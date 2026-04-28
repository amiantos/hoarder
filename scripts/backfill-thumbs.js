const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Database = require("better-sqlite3");
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const ROOT = path.join(__dirname, "..");

const THUMBNAILABLE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const THUMB_SIZE = 192;

function loadConfig() {
  const configPath = path.join(ROOT, "conf", "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("Missing conf/config.json");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function main() {
  const config = loadConfig();
  const db = new Database(path.join(ROOT, "data", "uploads.db"));
  db.pragma("journal_mode = WAL");

  const cols = db.prepare("PRAGMA table_info(uploads)").all();
  if (!cols.some((c) => c.name === "has_thumb")) {
    db.exec("ALTER TABLE uploads ADD COLUMN has_thumb INTEGER NOT NULL DEFAULT 0");
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint: config.r2.endpoint,
    credentials: {
      accessKeyId: config.r2.access_key_id,
      secretAccessKey: config.r2.secret_access_key,
    },
  });

  const rows = db
    .prepare("SELECT id, ext, mime FROM uploads WHERE has_thumb = 0 ORDER BY created_at ASC")
    .all();

  const candidates = rows.filter((row) => THUMBNAILABLE_MIMES.has(row.mime));
  console.log(
    `Found ${rows.length} rows without thumbs; ${candidates.length} are thumbnailable image types.`
  );

  const updateStmt = db.prepare("UPDATE uploads SET has_thumb = 1 WHERE id = ?");

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of candidates) {
    const key = buildKey(config, row.id, row.ext);
    const thumbKey = buildThumbKey(config, row.id, row.ext);

    try {
      // If the thumb already exists in R2 (e.g. from a previous partial run),
      // just mark the db row and move on
      try {
        await s3.send(new HeadObjectCommand({ Bucket: config.r2.bucket, Key: thumbKey }));
        updateStmt.run(row.id);
        skipped++;
        console.log(`[skip] ${row.id} — thumb already in R2`);
        continue;
      } catch (err) {
        if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) throw err;
      }

      const obj = await s3.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }));
      const buffer = await streamToBuffer(obj.Body);

      const thumbBuffer = await generateThumbnail(buffer, row.ext);

      await s3.send(
        new PutObjectCommand({
          Bucket: config.r2.bucket,
          Key: thumbKey,
          Body: thumbBuffer,
          ContentType: row.mime,
          CacheControl: "public, max-age=31536000, immutable",
        })
      );

      updateStmt.run(row.id);
      ok++;
      console.log(`[ok]   ${row.id}.${row.ext} → ${thumbBuffer.length} bytes`);
    } catch (err) {
      failed++;
      console.error(`[fail] ${row.id}.${row.ext}: ${err.message}`);
    }
  }

  console.log(`\nDone. generated=${ok} skipped=${skipped} failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
