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
- `brand/glowhum.json` is the one brand record for the name, mark, icon set, pages and redirect targets.
- `scripts/verify-brand.mjs` checks the record against the shipped assets and source pages. It does not claim approval when an approval source is missing.

## Run

Open `index.html` in a browser, or serve the container:

```
docker build -t glowhum-web .
docker run --rm -p 8080:80 -v /data/glowhum-drops:/data glowhum-web
```

Then visit http://localhost:8080

## Brand verification

Run the read-only consistency check from the repository root:

```
node scripts/verify-brand.mjs
```

Use `--require-approved` when a release must stop until every asset has an explicit approval source:

```
node scripts/verify-brand.mjs --require-approved
```

The current record proves the Glowhum name approval and the consistency of the local mark, favicon set, branded pages and redirect targets. It records the logo approval as unproven because no explicit approval source was found.

## API

The server is a small HTTP API.

- `GET /` returns `index.html`.
- `GET /favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png`, `/site.webmanifest` return those static assets with appropriate content types and cache headers.
- `POST /api/drop` uploads one file as the raw request body. Required headers:
  - `X-File-Name`
  - `X-File-Size`
  The file is streamed into the drop root, a SHA-256 is computed, and a `201` response returns a receipt with `id`, `name`, `size`, `sha256`, `received_at`, `status`, and `email`.
- `POST /api/drop/:id/email` accepts JSON `{ "email": "..." }`, validates a plain email shape, saves it on the matching receipt, and returns the updated receipt.
- `GET /api/drop/:id` returns the saved report, delivery state, pipeline steps, preview, publication and receipt data.
- `GET /api/drop/:id/receipt` returns the same customer state from the saved report link.
- `POST /api/drop/:id/start` starts video making after the customer confirms.
- `GET /api/drop/:id/preview` streams the saved preview video.
- `POST /api/drop/:id/publish` queues private publication after the customer confirms the current preview.
- `GET /api/order-config` returns the published integer AED price.
- `POST /api/checkout` accepts JSON with `email` and either `topic` or `report_url`. It creates a hosted Stripe Checkout session for one episode and returns its URL.
- `POST /api/stripe/webhook` verifies the raw Stripe body. A paid `checkout.session.completed` event grants one entitlement. A full `charge.refunded` event revokes that same entitlement.
- `GET /api/order/:id` returns the public order state: `paid`, `rendering`, `published` or `refunded`, plus `video_url` and `published_at` when available.
- `GET /api/engines` returns the customer engine catalog with the canary price and its input and output limits.
- `POST /api/jobs` accepts `{ "engine": "kadr-clinic-offer", "input": { "prompt": "..." } }` and returns a queued job record with a stable ID, quoted price and job view URL.
- `GET /api/jobs/:id` returns the same customer job record with state, input, output and price.
- `/job?id=...` is the customer job view. A canary job stays queued until the server side worker claims it. The API does not claim provider output before a worker writes it.

The canary worker is `scripts/run-creative-job.mjs`. It reads the saved KADR preset, claims one queued job, runs the existing server side render path with a ten minute limit, and writes the output hash back to the same job record. It requires `FAL_KEY` and is a separate operator action, so creating a priced job never spends provider credit by itself. A missing key records a failed job and does not claim output.

The RunPod adapter is `scripts/runpod-render.mjs`. It calls the existing fixed Hopper worker, which attaches the audited `hopper-weights` network volume when `HOPPER_VOLUME_ID` is set, tries its configured GPU and cloud fallbacks, and terminates the pod on success or failure. It writes a receipt only after a nonempty video exists and includes the output hash. It does not retry an uncertain provider call.

Run a bounded cold then warm proof with the existing volume:

```
HOPPER_MAX_MINUTES=15 HOPPER_READY_MINUTES=15 HOPPER_IDLE_MINUTES=5 node scripts/runpod-cold-warm.mjs --out-dir /tmp/glowhum-runpod-cold-warm --seconds 3
```

The first render keeps the newly started pod for the second render. The second render reuses that pod. Both outputs and their receipts must exist before the command is a pass. Set `HOPPER_VOLUME_ID` in the existing operator environment or the worker will report that weights are not persistent.
- `POST /api/topic-preview` accepts `{ "topic": "..." }` without sign in and creates one private preview job.
- `POST /api/topic-preview/:id/video` saves the complete browser-made WebM or MP4 preview. `GET /api/topic-preview/:id/video` lets the visitor watch it.
- `POST /api/topic-preview/:id/download` returns the saved video only when the request includes an active Glowhum entitlement ID from `entitlements/`.
- `POST /api/founder-summary/deliver` reads the canonical Genspark channel synthesis, verifies all requested sections, sends the complete founder summary to the configured destination, and keeps the provider response as a receipt.
- `GET /api/founder-summary/receipt/:id` returns one retained founder delivery receipt. Both founder-summary routes require the server-only founder delivery token.

Drops are rate limited to 20 per IP per hour.

The topic preview is made in the visitor's browser from the submitted topic, then saved by the server. Watching the preview does not require sign in. The download endpoint checks the active Stripe entitlement before it returns the video as a file.

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
- `GLOWHUM_CANARY_PRICE_AED` is an optional positive integer price in AED for the shared creative canary. It defaults to the episode price.
- `GLOWHUM_DROPS_DIR` is the episode job directory. It defaults to `/data/glowhum-drops` when the server runs directly. The container sets it to `/data`.
- `PUBLIC_BASE_URL` is required for checkout. It must be the deployed HTTPS origin, for example `https://glowhum.com`. The server never derives Stripe return URLs from a request Host header.

## Founder summary delivery

The founder summary action is a server action. It does not report success from a local file. It reads `GLOWHUM_CHANNEL_FORMAT_SOURCE`, runs the channel format check, then sends one JSON request to `GLOWHUM_FOUNDER_DELIVERY_URL`. The destination must return an HTTP success response. The provider response body, source hash and message hash are saved under `GLOWHUM_FOUNDER_SUMMARY_ROOT`.

Set these server-only values in the deployment environment:

- `GLOWHUM_CHANNEL_FORMAT_SOURCE` is the absolute path to `NOMOI_CHANNEL_FORMAT_GENSPARK_K3_2026_09_04.md`.
- `GLOWHUM_FOUNDER_DELIVERY_URL` is the approved HTTPS destination for the founder message.
- `GLOWHUM_FOUNDER_DELIVERY_TOKEN` is a random value of at least 32 characters used by the protected action.
- `GLOWHUM_FOUNDER_DELIVERY_SECRET` is optional and is sent to the destination as a bearer credential.
- `GLOWHUM_FOUNDER_SUMMARY_ROOT` is the persistent receipt directory. It defaults to `/data/glowhum-drops/founder-summary`.
- `TWOTHUMBS_PROMPT_ID` and `TWOTHUMBS_PROMPT_VERSION` bind the receipt to the intake. The current defaults are the supplied prompt and version 125.

The delivery ID is derived from the prompt identity and source hash. A `send_confirmed` receipt is returned on repeat without another provider request. A transport error is saved as `send_unknown` and blocks an automatic retry because the destination may have accepted the message before the connection failed. A rejected response is saved as `send_rejected` and can only be retried with `{ "retry": true }`. A retry reuses the same delivery ID, message hash and idempotency key. The destination must deduplicate that key.

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

## KADR provider check

The saved clinic offer preset is `kadr/presets/glowhum-clinic-offer.json`. It uses the saved fal Seedance 1.5 Pro slug, Glowhum as the brand, 720p, five seconds, audio, and a maximum render budget of `$1.20`.

Run one server side render with the key kept out of the repository and browser:

```
FAL_KEY=... TWOTHUMBS_PROMPT_ID=... TWOTHUMBS_PROMPT_VERSION=... node scripts/kadr-render.mjs --preset kadr/presets/glowhum-clinic-offer.json --out /tmp/glowhum-kadr-clinic-offer.mp4
```

The runner checks the saved slug, brand, input settings, and budget before the queue call. It writes a sidecar receipt with the fal request ID and output hash. The provider response is the source of render status. The receipt records a cost basis estimate only when fal does not return an invoice.

## Report drop and current delivery gates

TwoThumbs prompt id: prm_a611c7ea-cec5-4831-970d-248073dff6fc, version 67.

`/drop` accepts a file, shows upload progress, reads its saved status, starts video making, shows the saved preview, queues private publication, and downloads the current receipt. Its private return link holds the report ID in the URL fragment. If delivery is not connected, the page keeps the report saved and shows the exact missing step. Files named `receipt.json` are stored as `report-receipt.json` so the receipt cannot overwrite the source. A size mismatch fails the upload and removes the incomplete drop.

The page can be used by a fresh browser user from upload through receipt. A saved report is not described as a rendered or published episode until the delivery worker and destination provide those saved states.

The four Glowhum asks from `.ainur/ASTRA_HANDOFF_2026_09_07.md` remain partial:

| Ask | Remaining evidence |
|---|---|
| automate report to script to shots to voice to episode | One admitted source report, actual script, shots, voice and episode artifacts, their hashes, elapsed time, measured cost, retries, QA results and human touches from the engine. The engine is outside this repository. |
| render and publish the full Astra episode and three verticals | Founder approval for the bounded render and private upload, followed by the four output artifacts, private video IDs, actual cost and touch count. No approval or video ID was inferred. |
| make the Glowhum front door useful in plain words | A live fresh user run through drop, status, preview, approval, publication and receipt. This change provides the drop and receipt slice. |
| challenge Higgsfield with our own engine | An admitted research source, a completed episode costing less than 100 AED, measured latency and touches, and a comparison against the canonical charter. The unsupported price and engine comparison was removed from the page. |

Before the render, bind the approved source and script hashes, full episode plus three verticals, provider, maximum cost, destination account and private visibility to the approval. Stop on a missing approval or source admission. After the render, check every artifact and record real cost, retries, QA and touches before requesting private upload. Check the destination video IDs and visibility after upload. Do not replace these checks with local test results.

Existing evidence pointers are the workspace Astra handoff and DDAY founder and K3 handoffs dated 2026-09-07. The `physai` charter and root founder review paths quoted by those handoffs were absent at those exact paths during this check. Their targets must be resolved before execution.

Validation on 2026-09-07: `node scripts/drop-storage.test.mjs` passed with exit 0. It exercises the actual upload handler and disk writes, verifies source and receipt hashes, checks reserved and path shaped names, rejects incomplete and oversized bodies, and serves the new page. `node --check server.mjs` and `git diff --check` passed. The HTTP suite `node --test scripts/server.test.mjs scripts/stripe-setup.test.mjs` exited 1. Direct execution confirmed that the sandbox refuses socket listeners with `EPERM`; the Stripe setup subprocess also returned an empty body. HTTP, browser and live delivery checks remain open.
