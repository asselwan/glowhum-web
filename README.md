# GLOWHUM

Glow is the picture. Hum is the sound.

GLOWHUM turns a topic or a research report into a finished long form episode plus three vertical cuts, published to YouTube, TikTok and Shorts. One episode costs 199 AED by default.

Glowhum by NOMOI.

## Files

- `index.html` the order form for one episode.
- `order.html` the paid, rendering and published order status page.
- `server.mjs` zero-dependency Node server that serves the site, starts Stripe Checkout and accepts drops.
- `Dockerfile` builds a Node 22 Alpine image for that server.
- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `site.webmanifest` site icons and metadata.

## Run

Open `index.html` in a browser, or serve the container:

```
docker build -t glowhum-web .
docker run --rm -p 8080:80 -v /data/glowhum-drops:/data glowhum-web
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
- `GET /api/order-config` returns the published integer AED price.
- `POST /api/checkout` accepts JSON with `email` and either `topic` or `report_url`. It creates a hosted Stripe Checkout session for one episode and returns its URL.
- `POST /api/stripe/webhook` verifies the raw Stripe body. A paid `checkout.session.completed` event grants one entitlement. A full `charge.refunded` event revokes that same entitlement.
- `GET /api/order/:id` returns the public order state: `paid`, `rendering`, `published` or `refunded`, plus `video_url` and `published_at` when available.

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

## Checkout and episode jobs

Set these server-only values in the deployment environment. Do not place either Stripe key in HTML, browser JavaScript or a client-side build.

- `STRIPE_SECRET_KEY` is the Stripe secret API key used only by `POST /api/checkout`.
- `STRIPE_WEBHOOK_SECRET` is the endpoint signing secret used only by `POST /api/stripe/webhook`.
- `STRIPE_PRICE_ID` is the one time Stripe Price created for the Glowhum one episode offer.
- `STRIPE_ALLOW_LIVE=true` is required in addition to a live key. Without this separate switch, checkout refuses live keys. Do not set it during test proof.
- `GLOWHUM_EPISODE_PRICE_AED` is a positive integer price in AED. It defaults to `199`.
- `GLOWHUM_DROPS_DIR` is the episode job directory. It defaults to `/data/glowhum-drops` when the server runs directly. The container sets it to `/data`.
- `PUBLIC_BASE_URL` is required for checkout. It must be the deployed HTTPS origin, for example `https://glowhum.com`. The server never derives Stripe return URLs from a request Host header.

Checkout sessions use `client_reference_id=glowhum_one_episode_v1` and matching product, price and test markers. The webhook requires those markers, a paid payment mode Checkout Session, the expected Stripe mode, AED currency, and the exact configured amount before it writes anything.

Create or reuse the test Product and Price with the setup command. It does no network work unless `--apply` and the exact confirmation are both present. It refuses live keys.

```bash
node scripts/setup-stripe-test.mjs
STRIPE_SECRET_KEY=... node scripts/setup-stripe-test.mjs --apply --confirm=glowhum_one_episode_v1
```

Save the returned `STRIPE_PRICE_ID` in the test deployment. Configure the webhook endpoint for `checkout.session.completed` and `charge.refunded`, then save its test signing secret as `STRIPE_WEBHOOK_SECRET`.

The production storage mapping is host `/data/glowhum-drops` to container `/data`. With the container value `GLOWHUM_DROPS_DIR=/data`, the existing `glowhum-drop-sync` watcher reads the host path `/data/glowhum-drops/drops/*/receipt.json`.

On an accepted webhook, the server writes the source request first and the receipt last. Both final files are atomically published:

```
GLOWHUM_DROPS_DIR/
  drops/
    <stripe-checkout-session-id>/
      request.md
      receipt.json
  events/
    <stripe-event-id>.json
  payments/
    <stripe-payment-intent-id>.json
  entitlements/
    <stripe-checkout-session-id>.json
  revocations/
    <stripe-checkout-session-id>.json
```

`request.md` contains the submitted topic and report URL. `receipt.json` includes the source compatibility fields `name: "request.md"`, `sha256`, `size`, and `received_at`. It also records the order, Product marker, Price, PaymentIntent, Stripe mode, price and state.

Idempotency is keyed by Stripe event ID. The atomic file in `events/` binds each event ID to one Checkout session ID. A repeated event can finish an interrupted write for that same order, while reuse of an event ID for another session is rejected. The payment index binds one PaymentIntent to one order. The entitlement starts as `active`. One immutable revocation record changes it to `revoked` after a full refund. A paid event replay cannot restore a revoked entitlement.

The episode pipeline owns only these state updates: set `status` to `rendering` when work starts; set `status` to `published`, `video_url` to a valid HTTPS URL, and `published_at` to an ISO 8601 timestamp after publishing. The webhook can set `status` to `refunded`. The status page accepts only `paid`, `rendering`, `refunded`, or a fully populated `published` receipt and never exposes the buyer email or report details.

Report URLs must be public HTTPS URLs. The order server rejects localhost and obvious private literal addresses. Any downstream fetcher must also resolve DNS and enforce SSRF protection before it fetches a report URL.

## Notes

- Deep indigo night `#0b1026`, warm glow core `#ffb454`, aura edge `#ff7a3d`, one electric accent `#41e6ff`.
- The order form reads the current integer AED price from the server.
