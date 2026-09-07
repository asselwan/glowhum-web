# Glowhum design pass, 2026-09-08

TwoThumbs prompt: `prm_a611c7ea-cec5-4831-970d-248073dff6fc`

Method note. Every pattern below is a real Mobbin flow retrieved through `mcp__mobbin__search_flows` in this session, web platform. Flow ids and screen counts are the ones Mobbin returned. Nothing here is invented.

## 1. Drop zone landing (report upload)

Retrieved: Midday "Uploading a file" (web, 4 screens, `1a2c5285-9a03-44a7-a76e-a1100bd74e36`), Mercury "Uploading company documents" (web, 4 screens, `9e56fcb4-084c-4ada-98a0-48e049ddb2bd`), AWS S3 "Uploading files" (web, 7 screens, `a4d0df13-8f6a-4ee9-a33a-58da21f04978`).

What the pattern does. All three render a real drop target, a dashed border box with an upload icon and the words "Drag and drop here or click to upload." Mercury shows the chosen file as a thumbnail card with a filename and a green check once it is attached. AWS shows the picked files in a small table before the upload starts.

What Glowhum does today. `drop.html` is titled "Drop a report" and its only control is a plain `<input type="file">`. There is no `dragover` or `drop` handler anywhere in the file. The page promises a drop zone and does not have one.

The exact change. Add a real drop target: a dashed box that lights up on `dragover`, accepts a dropped file on `drop`, and still works with the existing click-to-choose input. Once a file is picked (by drag or by click) show a file card with the name, a human size, and a pending mark, then a green check when the receipt confirms the save. Keep `POST /api/drop` and its headers exactly as they are; this only changes how the file reaches that same call.

Copy, before: "Choose your report" / "Save report".
Copy, after: "Drag your report here or choose a file" / "Save report".

## 2. One item checkout entry

Retrieved: Uvodo "Ordering an item (sell via link)" (web, 3 screens, `493b1fbe-2c7a-4bd7-b000-618d14a2d71b`), Apple "Purchasing an item" (web, 17 screens, `b0b14742-ced9-42b7-864e-265e3a5c8c90`).

What the pattern does. Uvodo is the closest match to Glowhum's shape: one product, one fixed price, a short form, and a pay button that states the exact amount ("Pay $0.50"). Its confirmation screen states the fact plainly: "Thanks for your payment. Your order was completed successfully," with the order number, the date, and the email it went to. Apple's confirmation states the same three facts in fewer words: "You're all set," the masked email the update went to, and the order number.

What Glowhum does today. `index.html` has a Continue to payment button that never states the amount, and the price only appears in a separate aside card. The order form and the price are two disconnected pieces of the same decision.

The exact change. Put the price and the button in the same visual unit and repeat the amount on the button once the price loads from `/api/order-config` ("Pay 199 AED" instead of a bare "Continue to payment"). Add a three-step strip above the fold, Send your topic, Pay once, Get your episode, so a first-time visitor understands the shape of the whole order before they start the form, the same job Uvodo's single clear price plus one form does in one screen. No new endpoint; the price still comes from the same `GET /api/order-config` call.

Copy, before: "Continue to payment".
Copy, after: "Pay 199 AED" (falls back to "Continue to payment" until the price loads).

## 3. Order status with delivery tracking

Retrieved: Apple "Order status" (web, 9 screens, `ce3a7a41-d9a5-45df-9608-55ab61c412ff`), adidas "Order details" (web, 4 screens, `170ab9e1-6e4a-4ea0-bc50-59c8105dbee4`), Hims "Tracking an order" (web, 2 screens, `79397988-1f04-499a-9fa4-813686178ea4`).

What the pattern does. Apple renders a labeled step bar, Order Placed, Processing, Preparing to Ship, Shipped, Delivered, with the completed steps filled solid. adidas uses three icon steps, In Progress, On Its Way, Delivered, each with a check mark once passed. Hims leads with a plain state line, "friday OCT 17 on its way," and a "Show full history" expander underneath.

What Glowhum does today. `order.html` shows one headline word and one sentence of body copy. There is no visual step, no sense of where the order sits in the pipeline, and the "This can take a moment" copy never changes even while the page is actively polling.

The exact change. Add a three-step bar, Paid, Rendering, Published, built only from the `status` field the API already returns; a step is marked done, current, or upcoming from that one field, nothing invented. Give the current step a moving pulse so a person watching the page mid-render sees it working, not stalled. Keep `published_at` as the only timestamp shown, exactly as the API returns it, and add a one-tap copy of the order id next to its label the way Apple keeps the order number one tap away on its confirmation. Refunded renders as its own closed state, not a fourth step on the happy path, since a refund is not a step forward.

Copy, before: "Checking your order" / "This can take a moment after payment."
Copy, after: "Checking your order" / "We are watching your order. This page updates on its own."

## Priority order shipped

1. Order status tracker (`order.html`), highest value: the page a customer stares at the longest and the one that most looked unfinished.
2. Drop zone with real drag and drop (`drop.html`): the page's own name promised a capability it did not have.
3. One item checkout entry (`index.html`): ties price and action together and sets expectations before the form.

## Scope held

The server API is unchanged, and this pass touches no server file at all. `index.html`, `order.html`, and `drop.html` are rewritten on top of the committed `server.mjs` exactly as it stands at `HEAD` (`GET /api/order-config`, `POST /api/checkout`, `GET /api/order/:id`, `POST /api/drop`, `POST /api/drop/:id/email`, `GET /api/drop/:id`), not on top of the unrelated, still-uncommitted delivery pipeline, topic preview, KADR, and founder summary work sitting in this working tree from an earlier session. That work is out of scope here: `.tools/payment-path-change-guard` flags `creative-jobs.mjs` and its test as a payment-sensitive diff needing its own fresh cross-caller audit, which this pass did not do and is not the right session to rush. The three rewritten pages were smoke tested against the exact `HEAD` server (`node server.mjs` on a scratch port) before this pass shipped: `/`, `/order`, and `/drop` all return `200`, and the new markup (`class="steps"`, `dropzone`, `id="tracker"`) is present in each response.
