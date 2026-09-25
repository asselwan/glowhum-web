import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Proves the fix for the Stripe-paid-order / delivery.mjs-pipeline bridge: a paid checkout
// session now gets a delivery.mjs-compatible queue entry (deterministic hashed id, mapped back
// via a stored field), drives through queue -> render -> publish exactly like the free-drop
// pipeline, and order.html's /api/order/:id reflects the pipeline's live state instead of being
// stuck on "paid" forever.

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function waitForServer(port) {
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server did not become ready in time");
}

async function startFakeStripeApi() {
  const server = createHttpServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "cs_test_checkout_created_1", object: "checkout.session", url: "https://checkout.stripe.test/x" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port };
}

async function startFakeMailgun() {
  const messages = [];
  const server = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    messages.push(Object.fromEntries(params.entries()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: `<msg-${messages.length}@test>`, message: "Queued." }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port, messages };
}

function signedStripeEvent(event, secret) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { body, signature: `t=${timestamp},v1=${signature}` };
}

function checkoutEvent(overrides = {}) {
  const session = {
    object: "checkout.session", id: "cs_test_bridge_order_1", created: 1767225600,
    mode: "payment", payment_status: "paid", livemode: false, currency: "aed", amount_total: 19900,
    payment_intent: "pi_test_bridge_order_1", client_reference_id: "glowhum_one_episode_v1",
    customer_details: { email: "customer@example.com" },
    metadata: {
      glowhum_product: "glowhum_one_episode_v1", glowhum_price: "price_test_glowhum_one_episode_v1",
      is_test: "true", topic: "A bridged episode", report_url: "",
    },
    ...overrides,
  };
  return { id: "evt_bridge_checkout_1", type: "checkout.session.completed", data: { object: session } };
}

test("a paid Stripe order is bridged into the delivery pipeline, driven queue to published, and order.html reflects it live", async () => {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverPath = path.join(rootDir, "server.mjs");
  const port = await freePort();
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-bridge-"));
  const webhookSecret = "whsec_test_secret";
  const workerToken = crypto.randomBytes(32).toString("hex");
  const fakeStripe = await startFakeStripeApi();
  const fakeMailgun = await startFakeMailgun();

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      // deliveryRoutes is mounted on DROP_ROOT (see server.mjs), while the bridge writes via
      // orderDirectory() = GLOWHUM_DROPS_DIR/drops -- in production these default to the SAME
      // path (/data/drops under /data), which is exactly what makes the bridge reachable by the
      // pipeline's own HTTP routes at all. Mirror that here instead of using a separate uploads
      // dir (which the pre-existing entitlement test in server.test.mjs does, harmlessly, since
      // it never drives the pipeline's own HTTP routes for a paid order's id).
      DROP_ROOT: path.join(jobDir, "drops"),
      GLOWHUM_DROPS_DIR: jobDir,
      STRIPE_SECRET_KEY: "sk_test_server_only",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_PRICE_ID: "price_test_glowhum_one_episode_v1",
      STRIPE_API_BASE_URL: `http://127.0.0.1:${fakeStripe.port}`,
      PUBLIC_BASE_URL: "https://glowhum.test",
      GLOWHUM_EPISODE_PRICE_AED: "199",
      GLOWHUM_WORKER_TOKEN: workerToken,
      GLOWHUM_YOUTUBE_CHANNEL_ID: "UCJV-l1aT50bqblmpQAc1Z5Q",
      GLOWHUM_DELIVERY_ENABLED: "true",
      MAILGUN_API_KEY: "key-test",
      MAILGUN_DOMAIN: "bynomoi.com",
      MAILGUN_API_BASE: `http://127.0.0.1:${fakeMailgun.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr?.on("data", (d) => { childErr += d.toString(); });

  try {
    await waitForServer(port);

    const postWebhook = (event) => {
      const signed = signedStripeEvent(event, webhookSecret);
      return fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signature },
        body: signed.body,
      });
    };

    // Idempotency: fire the SAME event 3 times, only the first bridges.
    const event = checkoutEvent();
    const replies = await Promise.all([postWebhook(event), postWebhook(event), postWebhook(event)]);
    const bodies = await Promise.all(replies.map((r) => r.json()));
    assert.equal(replies.filter((r) => r.status === 200).length, 3);
    assert.equal(bodies.filter((b) => b.created === true).length, 1);
    assert.equal(bodies.filter((b) => b.created === false).length, 2);

    const deliveryId = crypto.createHash("sha256").update("cs_test_bridge_order_1").digest("hex").slice(0, 32);
    const bridgedReceipt = JSON.parse(await fs.readFile(path.join(jobDir, "drops", deliveryId, "receipt.json"), "utf8"));
    assert.equal(bridgedReceipt.email, "customer@example.com");
    assert.equal(bridgedReceipt.stripe_order_id, "cs_test_bridge_order_1");
    assert.equal(bridgedReceipt.topic, "A bridged episode");
    const bridgedState = JSON.parse(await fs.readFile(path.join(jobDir, "drops", deliveryId, "delivery.json"), "utf8"));
    assert.equal(bridgedState.status, "queued");
    assert.equal(bridgedState.destination.channel_id, "UCJV-l1aT50bqblmpQAc1Z5Q");
    // A paid order must resolve to unlisted: YouTube "private" is unviewable by link (d8f8c20),
    // so the customer's emailed video link would fail.
    assert.equal(bridgedState.destination.visibility, "unlisted");

    // order.html's own endpoint must show "rendering" now, not stuck on "paid" forever.
    const statusWhileQueued = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_bridge_order_1`);
    assert.equal(statusWhileQueued.status, 200);
    assert.equal((await statusWhileQueued.json()).status, "rendering");

    // Drive the SAME pipeline proven 2026-09-24 for the free-drop flow, now for a paid order.
    const claim1 = await fetch(`http://127.0.0.1:${port}/api/worker/claim`, {
      method: "POST", headers: { authorization: `Bearer ${workerToken}` },
    });
    const job1 = await claim1.json();
    assert.equal(job1.id, deliveryId);
    assert.equal(job1.phase, "render");

    const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from("ftypisom"), Buffer.alloc(24, 1)]);
    const previewUpload = await fetch(`http://127.0.0.1:${port}/api/worker/${deliveryId}/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}`, "x-worker-claim": job1.claim },
      body: fakeMp4,
    });
    assert.equal(previewUpload.status, 200);
    const readyState = await previewUpload.json();
    assert.equal(readyState.status, "ready");

    const publish = await fetch(`http://127.0.0.1:${port}/api/drop/${deliveryId}/publish`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, preview_sha256: readyState.preview.sha256 }),
    });
    assert.equal(publish.status, 200);

    const claim2 = await fetch(`http://127.0.0.1:${port}/api/worker/claim`, {
      method: "POST", headers: { authorization: `Bearer ${workerToken}` },
    });
    const job2 = await claim2.json();
    assert.equal(job2.phase, "publish");
    assert.equal(job2.destination.visibility, "unlisted");

    const fakeVideoId = "bridgeTest1"; // 11 chars, never a real YouTube upload (see delivery.mjs 'complete')
    const complete = await fetch(`http://127.0.0.1:${port}/api/worker/${deliveryId}/complete`, {
      method: "POST",
      headers: { authorization: `Bearer ${workerToken}`, "x-worker-claim": job2.claim, "content-type": "application/json" },
      body: JSON.stringify({ video_id: fakeVideoId, channel_id: job2.destination.channel_id, visibility: job2.destination.visibility, preview_sha256: readyState.preview.sha256, verified: true }),
    });
    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).status, "published");

    // order.html's endpoint (keyed by the ORIGINAL Stripe session id) must now show published.
    const statusPublished = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_bridge_order_1`);
    const publishedBody = await statusPublished.json();
    assert.equal(publishedBody.status, "published");
    assert.equal(publishedBody.video_url, `https://www.youtube.com/watch?v=${fakeVideoId}`);
    assert.ok(publishedBody.published_at);

    // Both emails fired, and the ready email links to the CUSTOMER'S order id, not the internal hash.
    await new Promise((r) => setTimeout(r, 200)); // fire-and-forget sends are async
    assert.equal(fakeMailgun.messages.length, 2);
    const paidMail = fakeMailgun.messages.find((m) => m.subject === "Glowhum order received");
    const readyMail = fakeMailgun.messages.find((m) => m.subject === "Your Glowhum episode is ready");
    assert.ok(paidMail, "paid confirmation email must have sent");
    assert.ok(readyMail, "ready-for-delivery email must have sent");
    assert.match(readyMail.text, /order_id=cs_test_bridge_order_1/);
    assert.doesNotMatch(readyMail.text, new RegExp(deliveryId));
  } finally {
    child.kill();
    fakeStripe.server.close();
    fakeMailgun.server.close();
    await fs.rm(jobDir, { recursive: true, force: true });
  }
  assert.doesNotMatch(childErr, /TypeError|ReferenceError|is not a function|Cannot read propert/);
});

test("a bridge write failure is alerted, not swallowed silently, and does not crash the webhook response", async () => {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverPath = path.join(rootDir, "server.mjs");
  const port = await freePort();
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-bridge-fail-"));
  const webhookSecret = "whsec_test_secret";
  const fakeStripe = await startFakeStripeApi();

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DROP_ROOT: path.join(jobDir, "uploads"),
      GLOWHUM_DROPS_DIR: jobDir,
      STRIPE_SECRET_KEY: "sk_test_server_only",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      STRIPE_PRICE_ID: "price_test_glowhum_one_episode_v1",
      STRIPE_API_BASE_URL: `http://127.0.0.1:${fakeStripe.port}`,
      PUBLIC_BASE_URL: "https://glowhum.test",
      GLOWHUM_EPISODE_PRICE_AED: "199",
      // Explicitly forced empty (not just "omitted"): the host actually running this suite may
      // have a real MCP_INTERNAL_SHARED_SECRET in its own environment (glowhum-web's production
      // container does, deliberately, so alertDain can really fire) -- {...process.env} above
      // would otherwise inherit it and this test would attempt a live network call instead of
      // exercising the "no secret" path deterministically.
      MCP_INTERNAL_SHARED_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr?.on("data", (d) => { childErr += d.toString(); });

  try {
    await waitForServer(port);
    const deliveryId = crypto.createHash("sha256").update("cs_test_bridge_fail_1").digest("hex").slice(0, 32);
    // Pre-create a CONFLICTING receipt.json (different content) so writeImmutableFile throws
    // CONFLICT inside bridgeToDeliveryPipeline -- a deterministic, reproducible bridge failure.
    const dir = path.join(jobDir, "drops", deliveryId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "request.md"), Buffer.from("pre-existing different content"));

    const event = checkoutEvent({ id: "cs_test_bridge_fail_1", payment_intent: "pi_test_bridge_fail_1" });
    event.id = "evt_bridge_fail_1";
    const signed = signedStripeEvent(event, webhookSecret);
    const response = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signature },
      body: signed.body,
    });
    // The order write itself succeeded; the response must still be 200 (retrying would not fix
    // a code-level bridge failure), never a silent 500 that masks a paid, unfulfillable order.
    assert.equal(response.status, 200);
    assert.equal((await response.json()).created, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(childErr, /bridge_to_delivery_failed/);
    assert.match(childErr, /no_secret_configured/);
  } finally {
    child.kill();
    fakeStripe.server.close();
    await fs.rm(jobDir, { recursive: true, force: true });
  }
});
