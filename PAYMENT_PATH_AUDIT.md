# Glowhum payment path audit

Payment-path cross-caller audit: complete

Callers audited: The order form calls `POST /api/checkout`. The server creates one hosted Checkout Session from the configured Stripe Price. Stripe calls `POST /api/stripe/webhook`. The webhook grants an entitlement for a verified paid Checkout event and revokes that entitlement for a verified full refund on the same PaymentIntent. The order page reads `GET /api/order/:id`. The render watcher reads `drops/*/receipt.json` only after the entitlement and payment binding exist. The setup command creates or reuses the test Product and Price. The HTTP tests cover each caller and a tampered webhook body.

Price/units verified: `scripts/setup-stripe-test.mjs` owns the fixed test offer. The price is AED 199. Stripe receives 19,900 fils in `unit_amount`. Checkout and webhooks require the same AED amount and configured Price ID.

Regression checks: `node --test scripts/*.test.mjs` passed 5 tests with 0 failures on 2026-09-07. `node --check` passed for the server, setup command, and both test files. `docker build -t glowhum-web:stripe-test-proof .` exited 0. The built container returned `{"price_aed":199,"checkout_ready":false}` without keys and served the refunded order copy. `/home/ainur/Apps/.tools/payment-path-change-guard --repo /home/ainur/Apps/glowhum-web --audit-note PAYMENT_PATH_AUDIT.md` passed.
