# Hoarder

A self-hosted file dropper. Drag, paste, or drop an image or short video into
the page and Hoarder hands back a short shareable URL like
`https://cdn.example.com/ImJcH.png`. Files live in Cloudflare R2; metadata
(short id, original filename, size, mime, timestamp) lives in a local SQLite
db. Thumbnails are generated on upload so the recent-uploads list stays light
even when the originals are huge.

The aesthetic is deliberately spartan — a dropzone, a status line, a recent
list. No accounts, no folders, no tags. Just a place to stash a file and walk
away with a URL.

## What's in here

```
index.js                Express server: upload, list, optional delete
web/                    Static frontend (drop / paste / recent list)
scripts/backfill-thumbs.js   One-shot thumbnail generator for pre-existing uploads
conf/config.json.example     Sample config (R2 creds, basic auth, CDN base URL)
data/                   (gitignored) SQLite db lives here
docker-compose.yml      Joins external proxy-network for cloudflared routing
Dockerfile              node:20 + npm install + start
```

## How an upload flows

1. **Drop / paste / pick.** The frontend `POST`s a multipart `file` field to
   `/api/upload`.
2. **Validate.** Mime is checked against the allowed list (png, jpeg, gif,
   webp, avif, svg, mp4, mov, webm). Anything else is rejected with 415.
3. **Allocate id.** A 5-character base62 id is generated from
   `crypto.randomBytes`. Collisions retry up to 5 times against the SQLite
   primary key.
4. **Upload.** The original is `PutObject`'d to R2 with a 1-year immutable
   cache header. If R2 fails, the SQLite row is rolled back.
5. **Thumbnail.** For raster images (not SVG), sharp generates a 192×192
   center-cropped thumbnail in the same format and uploads it to
   `thumbs/<id>.<ext>`. Best-effort — a thumbnail failure doesn't fail the
   upload, it just leaves `has_thumb = 0`.
6. **Respond.** The client gets back `{ id, url, thumb_url, ... }`, copies the
   URL to clipboard, and refreshes the recent list.

## Setup

1. **Clone and install:**

```sh
git clone https://github.com/amiantos/hoarder.git
cd hoarder
npm install
```

2. **Configure:**

```sh
cp conf/config.json.example conf/config.json
# Edit conf/config.json with R2 creds, CDN base URL, and (optionally) basic auth
```

3. **Run:**

```sh
# Development (auto-restart)
npm run dev

# Production
npm start

# Docker (joins the external proxy-network)
docker compose up -d --build
```

Visit `http://localhost:3001`.

## Configuration

| Key | Notes |
| --- | --- |
| `web.port` | Internal listen port (default 3001) |
| `web.auth.username` / `web.auth.password` | Basic auth — leave empty to disable |
| `r2.access_key_id` / `r2.secret_access_key` | R2 / S3 credentials |
| `r2.bucket` | Bucket name |
| `r2.endpoint` | `https://<account-id>.r2.cloudflarestorage.com` |
| `r2.key_prefix` | Optional prefix inside the bucket (default: flat) |
| `cdn_base_url` | Public CDN base, e.g. `https://cdn.example.com` |
| `upload.id_length` | Short-id length (default 5 — ~916M combinations) |
| `upload.max_size_mb` | Per-file size cap (default 50 MB) |

When basic auth is disabled the upload UI hides the delete buttons (the delete
endpoint is currently commented out anyway, but the UI courtesy stays).

## Cloudflared / proxy-network

The `docker-compose.yml` joins the external `proxy-network` so a cloudflared
tunnel running in the same network can route a public hostname to Hoarder
without exposing a host port:

```yaml
- hostname: upload.example.com
  service: http://hoarder:3001
```

Host port `3001` is also published for local debugging.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/` | Upload UI |
| `POST` | `/api/upload` | Multipart `file`. Returns `{ id, ext, url, thumb_url, ... }` |
| `GET` | `/api/uploads?limit=N` | Recent uploads (default 50, max 500). Includes `auth_enabled` flag |
| `GET` | `/health` | Unauthenticated health check |

`DELETE /api/uploads/:id` exists in the source but is currently commented out.

## Backfilling thumbnails

If you have uploads that predate thumbnail generation (or thumbnailing was
broken when they were uploaded), run:

```sh
npm run backfill-thumbs
```

This walks the SQLite db, downloads each thumbnailable original from R2,
generates and uploads the thumbnail, and flips `has_thumb = 1`.

## Data storage

- `data/uploads.db` — SQLite, schema is one `uploads` table with `(id, ext,
  filename, size, mime, created_at, has_thumb)`.
- R2 bucket — originals at `<prefix>/<id>.<ext>`, thumbs at
  `<prefix>/thumbs/<id>.<ext>`.

Both are kept in sync at upload time. There is no background reconciler — if
the bucket and the db drift, fix it manually.
