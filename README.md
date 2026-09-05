# GLOWHUM

Glow is the picture. Hum is the sound.

GLOWHUM turns a topic or a research report into a finished long form episode plus three vertical cuts, published to YouTube, TikTok and Shorts. No human in the loop unless you want one. The unit cost is printed on every receipt. A full creative studio for operators on our own GPU lanes is next on the roadmap.

Glowhum by NOMOI.

## Files

- `index.html` the whole front door. One file, inline CSS and JS, inline SVG only, no frameworks.
- `server.mjs` zero-dependency Node server that serves the site and accepts drops.
- `Dockerfile` builds a Node 22 Alpine image for that server.
- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `site.webmanifest` site icons and metadata.

## Run

Open `index.html` in a browser, or serve the container:

```
docker build -t glowhum-web .
docker run --rm -p 8080:80 glowhum-web
```

Then visit http://localhost:8080

## API

The server is a small HTTP API.

- `GET /` returns `index.html`.
- `GET /favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png`, `/site.webmanifest` return those static assets with appropriate content types and cache headers.
- `POST /api/drop` uploads one file as the raw request body. Required headers:
  - `X-File-Name`
  - `X-File-Size`
  The file is streamed into the drop root, a SHA-256 is computed, and a `201` response returns a receipt with `id`, `name`, `size`, `sha256`, `received_at`, `status`, and `email`.
- `POST /api/drop/:id/email` accepts JSON `{ "email": "..." }`, validates a plain email shape, saves it on the matching receipt, and returns the updated receipt.
- `GET /api/drop/:id` returns the receipt for the stored drop.

Drops are rate limited to 20 per IP per hour.

Errors return JSON with an `error` field. A file over the configured limit returns `413`.

## Drop root

Drops are written to `DROP_ROOT`, which defaults to `/data/drops`. The layout is:

```
DROP_ROOT/
  <12-char id>/
    <safe original filename>
    receipt.json
```

`DROP_MAX_BYTES` sets the maximum accepted file size; the default is 200 MB.

## Notes

- Deep indigo night `#0b1026`, warm glow core `#ffb454`, aura edge `#ff7a3d`, one electric accent `#41e6ff`.
- Dark and light themes follow `prefers-color-scheme` with a persisted manual toggle.
- Reduced motion is respected: the breathing glow and the typing demo settle to their final state.
- The Drop a report button uses `mailto:hello@glowhum.com` as a fallback.
- Pricing tiers carry no numbers: launch pricing lands with the first public episode.
