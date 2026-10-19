# Glowhum order wait state

Added a real elapsed-time display beside the order tracker for the `rendering` state. It calculates time since `order.created_at`, updates every second, and clears when the status changes or an error appears. Added a quiet "Message us on WhatsApp" link in the same state, using the exact href from `index.html`.

Diff summary: `order.html` has 24 insertions and 1 deletion (the existing error handler now also hides the rendering-only content). The tracker, copy button, video link, other status copy, and existing hrefs are unchanged. No other page or server file was touched. `SCOPE.md` was already untracked before this work; this report is the only other file added.

Verification: `git diff --check` passed. A local JavaScript fixture passed for rendering, paid, published, refunded, and rendering-to-published behavior; it also confirmed the WhatsApp href exactly matches `index.html`. Headless Chrome exited in this environment before rendering a page, so a browser screenshot check was unavailable.

## Addendum — Designjoy request-board: local demo + operator-gated server-backed candidate (prm_cfc51c53 v2)

Scope: local-only continuation. No publish, no deploy, no external calls, no customer data (synthetic fixtures only). Production `serveStatic` whitelist unchanged — `local/request-board.html` and `request-board.js` are not served in production; the page loads only via a local static server (verified: `../request-board.js` returns 200 in the smoke harness).

Boundary verdict (source inspection, server.mjs): per-customer auth exists as unguessable capability IDs (Stripe `cs_` order IDs, drop IDs) with per-order file storage isolation; NO operator/admin role or interface exists anywhere in the repo (founder-summary's bearer is an outbound delivery token). Therefore the server-backed board ships as a dormant candidate with a narrowly scoped operator role; no request data is exposed until it is deliberately configured.

Changes:
- `request-board.js` (e8163058…): added `escapeHtml` (all user-entered text escapes before innerHTML), `setDue` (due date collected + validated: real timestamp, after creation — makes the on-time metric falsifiable), `serialize`/`restore` (localStorage persistence; malformed state fails safe to a fresh board in the browser, surfaced as 503 on the server).
- `local/request-board.html` (abeda4ac…): escaped titles/increment labels/due dates, due-date input feeding `setDue`, on-time/late badge on delivered cards, localStorage save on every mutation with try/catch fail-safe.
- `request-board-routes.mjs` (6df86ad6…, NEW): operator-gated board API — `POST/GET /internal/request-board/:tenant/requests`, `POST …/requests/:id/{start,deliver,toggle,revision}`. Bearer token from `GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN` (≥32 chars, no default, `crypto.timingSafeEqual`, never logged). Tenant-scoped file storage under `GLOWHUM_DROPS_DIR/request-board/<tenant>.json`, atomic 0600 writes. Dormant (returns false, nothing mounted) unless the token is configured. No customer-facing route added; no public shared queue.
- `server.mjs` (4 insertions): gated mount only — `operatorToken().length >= 32` guards the route call; with no token configured server behavior is byte-for-byte unchanged (restart test proves 404 + intact public routes).
- Tests: `scripts/request-board.test.mjs` (15855e25…, 13 tests: escaping, persistence/malformed restore, due-date/on-time, WIP-limit flow), `scripts/request-board-routes.test.mjs` (145b258a…, 9 tests: dormant default, 401 wrong/missing bearer, tenant isolation incl. cross-tenant id probe, server-side WIP limit, due validation, input rejection, corrupt→503), `scripts/request-board-restart.test.mjs` (22bc9217…, real server processes over HTTP: dormant without token, auth required, tenant scoping through the actual mount, board state survives a full process restart).
- `scripts/request-board-smoke.py` (69e29bb1…, NEW): real-Chromium Playwright smoke (installed venv + cached chromium, no new deps) against a local static server: malicious-title non-execution + DOM escaping, increment-label escaping, due-date display, queue→start→toggle→deliver→on-time flow, localStorage reload persistence (escaped), malformed-storage fail-safe, production whitelist exclusion.

Results (2026-10-18, this machine): `node --test "scripts/*.test.mjs"` → 72/72 pass (quoted glob required; bare `scripts/*.test.mjs` is shell-expanded and silently misses nothing here but the quoted form is the correct node test runner usage). `node scripts/verify-brand.mjs` → ok:true, exit 0. Playwright smoke → 13/13. Brand check untouched by these changes.

Deployment gate (remaining, deliberate): set `GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN` (≥32 random chars via the existing secure config rail — never in source/logs) on the deployment environment to activate the operator board under `/internal/request-board/*`; storage lands in `GLOWHUM_DROPS_DIR/request-board/`. Until then the feature is fully dormant. A customer-facing board view would additionally need per-customer scoping keyed to the existing `cs_` capability — not implemented, not exposed.

## Addendum 2 — customer flow connected: served /board UI + capability-scoped API (prm_cfc51c53 v2)

Closes the disconnection the root review found: the customer now has a served UI on real server persistence, scoped through the existing per-order capability; the operator role stays separately gated. No shared queue. All fixtures synthetic; nothing deployed or published; no existing production route's behavior changed (only additions).

Architecture (reused, not invented):
- Customer auth = the existing possession-capability model: the unguessable Stripe `cs_` order id in the `?order_id=` link, validated against a stored receipt (`orderExists` in server.mjs uses the same checks as `/api/order/:id`: order_id match, ORDER_STATUSES, valid created_at). Unknown or malformed capability → 404, no data.
- New API: `GET /api/order/:id/board` (view own board) and `POST /api/order/:id/board/requests` (submit) — read/create only. Board-state actions (start/deliver/toggle/revision) are operator-only; the customer action paths are not routed at all.
- Storage: per-capability file `GLOWHUM_DROPS_DIR/request-board/<cs_id>.json` (atomic 0600 rename writes). One board per order id — customers can never read or write another customer's board because their capability only ever names their own file.
- WIP=1 atomicity: per-tenant async mutex serializing load→mutate→save (single-process server topology, as designed for this zero-dependency server). Concurrent-start test proves exactly one winner.
- Operator role: unchanged token-gated `/internal/request-board/:tenant/requests…` mount (bearer, ≥32 chars from `GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN`, `crypto.timingSafeEqual`, no default, never logged, dormant without config). Operator tenants now also accept `cs_` ids so an operator can work a customer's board.

Files:
- `request-board-routes.mjs` 94048c29… — refactored shared `handleBoard` + role split, per-tenant lock, `customerBoardRoutes`.
- `board.html` 443e8ade… (NEW, served at `/board`) — customer UI: reads `?order_id=`, escapes all rendered text, submits to the capability-scoped API; brand text + icons per the brand record.
- `server.mjs` 88057513… — 19 added lines total: `orderExists`, customer-board mount in the `/api` section, `/board` static mapping.
- `brand/glowhum.json` 83419abd… — `/board` page entry (verify-brand passes, ok:true).
- `local/operator-board.html` 52d4d548… (NEW, local/review only) — operator console UI: token kept in memory only, tenant-scoped cross-customer view, start/toggle/revision/deliver actions.
- Tests: `scripts/request-board-routes.test.mjs` c6c01ea6… now 14 tests (adds: unknown-capability rejection, customer submission persistence + isolation, customer cannot advance state, operator/customer role separation, concurrent WIP=1); `scripts/request-board-e2e.py` 1efa1e8e… (NEW, installed Playwright + real server processes): browser submission → server persistence → full process restart → customer re-read, cross-customer isolation, unauthenticated mutation 404, operator advance + wrong-token 401, invalid capability renders an error not data. Unchanged: `request-board.js` e8163058…, `local/request-board.html` abeda4ac…, `scripts/request-board.test.mjs` 15855e25…, `scripts/request-board-restart.test.mjs` 22bc9217…, `scripts/request-board-smoke.py` 69e29bb1….

Results (2026-10-18): `node --test "scripts/*.test.mjs"` → 77/77 pass. `node scripts/verify-brand.mjs` → ok:true, exit 0. Playwright local smoke → 13/13. Playwright E2E → 11/11.

Deploy-ready config/target requirements (no deploy performed):
- Customer flow needs NO new config: `/board?order_id=<cs_id>` + `/api/order/<cs_id>/board` activate with the next deploy for any order id having a stored receipt. Target: Coolify glowhum-web service, env unchanged.
- Operator flow gate (unchanged): set `GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN` (≥32 random chars via the existing secure config rail; never in source, logs, or commits) in the service env. Storage lands under the existing `GLOWHUM_DROPS_DIR/request-board/` volume.
- Open by design: `/board` is reachable by anyone but shows nothing without a valid capability link (same security model as `/order`); `/operator/board` serves an unprivileged console shell, and all board data/actions still require the operator bearer token in the Authorization header.

## Addendum 3 — served same-origin operator console

The operator console is now served at `/operator/board` from the exact app origin. It no longer accepts a custom server URL, sends its token only to same-origin routes in the Authorization header, and never writes it to localStorage/sessionStorage or the URL. The static shell may load without a token but reveals no board data; operator APIs remain dormant unless a valid token is configured and reject missing/wrong bearer values. `brand/glowhum.json` includes the route. The current Coolify target still has no operator token configured, so operator access is not active until the secret is supplied through the secure deployment rail. No deployment was performed.

## Addendum 4 — CDP browser smoke fixed (founder7d-122ed97e9ba9302a5418)

Root cause of the "CDP smoke failure": `scripts/request-board-smoke.py` and `scripts/request-board-e2e.py` import Python Playwright, which is no longer installed (`ModuleNotFoundError: No module named 'playwright'`, also under `.tools/promo-burn-venv`). Fix: `scripts/cdp-lib.mjs` (dependency-free CDP client over Node 22 global WebSocket, launches the cached Chromium with `--remote-debugging-port=0`) and `scripts/request-board-cdp.mjs`, which ports both Python suites (local review demo + served /board and /operator/board against a real server.mjs process incl. restart persistence, tenant isolation, operator bearer auth) and adds 2 checks (operator route 401 without bearer; operator shell shows no data pre-token). Result: 28/28 PASS. `node --test "scripts/*.test.mjs"` 78/78. The local HTML demo stays review-only; no deploy, no production route change, no customer data.
