const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const Database = require("better-sqlite3");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const ALLOWED_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

// Mimes we generate raster thumbnails for. SVG is excluded — it scales fine in
// the browser and rasterizing would change the extension.
const THUMBNAILABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const THUMB_SIZE = 192;

function loadConfig() {
  const configPath = path.join(__dirname, "conf", "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("Missing conf/config.json — copy conf/config.json.example and fill it in.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function generateId(length) {
  const bytes = crypto.randomBytes(length);
  let id = "";
  for (let i = 0; i < length; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return id;
}

function openDb() {
  const dataDir = path.join(__dirname, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "uploads.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      ext TEXT NOT NULL,
      filename TEXT,
      size INTEGER NOT NULL,
      mime TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  const cols = db.prepare("PRAGMA table_info(uploads)").all();
  if (!cols.some((c) => c.name === "has_thumb")) {
    db.exec("ALTER TABLE uploads ADD COLUMN has_thumb INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

// Constant-time equality over equal-length buffers. Falsy on length mismatch
// so the comparison never short-circuits on size alone.
function safeEqual(a, b) {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function authMiddleware(auth) {
  const basicConfigured = !!(auth.username && auth.password);
  const apiKeys = Array.isArray(auth.api_keys)
    ? auth.api_keys.filter((k) => typeof k === "string" && k.length > 0)
    : [];

  function challenge(res) {
    // Advertise both schemes so the browser UI still gets its Basic prompt,
    // and API clients see Bearer in the WWW-Authenticate header.
    const schemes = [];
    if (basicConfigured) schemes.push('Basic realm="Hoarder"');
    if (apiKeys.length > 0) schemes.push('Bearer realm="Hoarder"');
    if (schemes.length) res.setHeader("WWW-Authenticate", schemes.join(", "));
  }

  return (req, res, next) => {
    const header = req.headers.authorization || "";

    if (apiKeys.length > 0 && header.startsWith("Bearer ")) {
      const presented = header.slice(7).trim();
      if (presented && apiKeys.some((k) => safeEqual(k, presented))) return next();
      challenge(res);
      return res.status(401).send("Invalid API key");
    }

    if (basicConfigured && header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      const idx = decoded.indexOf(":");
      const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
      const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (safeEqual(user, auth.username) && safeEqual(pass, auth.password)) return next();
      challenge(res);
      return res.status(401).send("Invalid credentials");
    }

    challenge(res);
    return res.status(401).send("Authentication required");
  };
}

function buildPublicUrl(config, key) {
  const base = config.cdn_base_url.replace(/\/+$/, "");
  return `${base}/${key}`;
}

function buildKey(config, id, ext) {
  const prefix = (config.r2.key_prefix || "").replace(/^\/+|\/+$/g, "");
  const filename = `${id}.${ext}`;
  return prefix ? `${prefix}/${filename}` : filename;
}

function buildThumbKey(config, id, ext) {
  const prefix = (config.r2.key_prefix || "").replace(/^\/+|\/+$/g, "");
  const filename = `thumbs/${id}.${ext}`;
  return prefix ? `${prefix}/${filename}` : filename;
}

async function generateThumbnail(buffer, ext) {
  const pipeline = sharp(buffer, { animated: false }).resize(THUMB_SIZE, THUMB_SIZE, {
    fit: "cover",
    position: "centre",
  });
  switch (ext) {
    case "jpg":
      return pipeline.jpeg({ quality: 80 }).toBuffer();
    case "png":
      return pipeline.png({ compressionLevel: 9 }).toBuffer();
    case "webp":
      return pipeline.webp({ quality: 80 }).toBuffer();
    case "avif":
      return pipeline.avif({ quality: 60 }).toBuffer();
    case "gif":
      return pipeline.gif().toBuffer();
    default:
      throw new Error(`Unsupported thumbnail ext: ${ext}`);
  }
}

function main() {
  const config = loadConfig();
  const db = openDb();

  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.access_key_id,
      secretAccessKey: config.r2.secret_access_key,
    },
  });

  const maxBytes = (config.upload?.max_size_mb || 50) * 1024 * 1024;
  const idLength = config.upload?.id_length || 5;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
  });

  const app = express();
  app.disable("x-powered-by");

  // Health check is unauthenticated so external monitors don't need creds
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // Only basic auth gates the website. api_keys is a side channel for CLI
  // clients (e.g. lurker) — having keys configured without a username/password
  // shouldn't force the browser UI behind a login prompt.
  const authEnabled = !!(config.web?.auth?.username && config.web?.auth?.password);
  if (authEnabled) {
    app.use(authMiddleware(config.web.auth));
  }

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "web")));

  app.post("/api/upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const ext = ALLOWED_TYPES[req.file.mimetype];
    if (!ext) {
      return res.status(415).json({
        error: `Unsupported type: ${req.file.mimetype}`,
        allowed: Object.keys(ALLOWED_TYPES),
      });
    }

    // Retry on the rare collision; with 5-char alphanumeric IDs this almost never trips
    const insertStmt = db.prepare(
      "INSERT INTO uploads (id, ext, filename, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    let id;
    for (let attempt = 0; attempt < 5; attempt++) {
      id = generateId(idLength);
      try {
        insertStmt.run(id, ext, req.file.originalname || null, req.file.size, req.file.mimetype, Date.now());
        break;
      } catch (err) {
        if (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" && attempt < 4) continue;
        throw err;
      }
    }

    const key = buildKey(config, id, ext);

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.r2.bucket,
          Key: key,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
          CacheControl: "public, max-age=31536000, immutable",
        })
      );
    } catch (err) {
      db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
      console.error("R2 upload failed:", err);
      return res.status(502).json({ error: "Upload to R2 failed" });
    }

    let hasThumb = false;
    if (THUMBNAILABLE_MIMES.has(req.file.mimetype)) {
      try {
        const thumbBuffer = await generateThumbnail(req.file.buffer, ext);
        await s3.send(
          new PutObjectCommand({
            Bucket: config.r2.bucket,
            Key: buildThumbKey(config, id, ext),
            Body: thumbBuffer,
            ContentType: req.file.mimetype,
            CacheControl: "public, max-age=31536000, immutable",
          })
        );
        db.prepare("UPDATE uploads SET has_thumb = 1 WHERE id = ?").run(id);
        hasThumb = true;
      } catch (err) {
        // Thumbnail is best-effort; original upload already succeeded
        console.error(`Thumbnail generation failed for ${id}:`, err.message);
      }
    }

    res.json({
      id,
      ext,
      url: buildPublicUrl(config, key),
      thumb_url: hasThumb ? buildPublicUrl(config, buildThumbKey(config, id, ext)) : null,
      filename: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
    });
  });

  app.get("/api/uploads", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const rows = db
      .prepare(
        "SELECT id, ext, filename, size, mime, created_at, has_thumb FROM uploads ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit);
    const items = rows.map((row) => ({
      id: row.id,
      ext: row.ext,
      filename: row.filename,
      size: row.size,
      mime: row.mime,
      created_at: row.created_at,
      url: buildPublicUrl(config, buildKey(config, row.id, row.ext)),
      thumb_url: row.has_thumb ? buildPublicUrl(config, buildThumbKey(config, row.id, row.ext)) : null,
    }));
    res.json({ items, auth_enabled: authEnabled });
  });

  // app.delete("/api/uploads/:id", async (req, res) => {
  //   const row = db.prepare("SELECT id, ext, has_thumb FROM uploads WHERE id = ?").get(req.params.id);
  //   if (!row) return res.status(404).json({ error: "Not found" });
  //
  //   const key = buildKey(config, row.id, row.ext);
  //   try {
  //     await s3.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
  //     if (row.has_thumb) {
  //       await s3.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: buildThumbKey(config, row.id, row.ext) }));
  //     }
  //   } catch (err) {
  //     console.error("R2 delete failed:", err);
  //     return res.status(502).json({ error: "Delete from R2 failed" });
  //   }
  //   db.prepare("DELETE FROM uploads WHERE id = ?").run(row.id);
  //   res.json({ ok: true });
  // });

  app.use((err, _req, res, _next) => {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `File too large (max ${config.upload?.max_size_mb || 50} MB)` });
    }
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  });

  const port = config.web?.port || 3000;
  app.listen(port, () => {
    console.log(`Hoarder listening on http://localhost:${port}`);
  });
}

main();
