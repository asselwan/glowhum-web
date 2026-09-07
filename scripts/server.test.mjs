import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Server did not become ready in time");
}

test("server API behavior", async () => {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverPath = path.join(rootDir, "server.mjs");

  const port = await freePort();
  const dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-"));

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DROP_ROOT: dropRoot,
      DROP_MAX_BYTES: String(2 * 1024 * 1024),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childErr = "";
  child.stderr?.on("data", (d) => {
    childErr += d.toString();
  });

  try {
    await waitForServer(port);

    const payload = crypto.randomBytes(1024 * 1024);
    const upload = await fetch(`http://127.0.0.1:${port}/api/drop`, {
      method: "POST",
      headers: {
        "X-File-Name": "research.pdf",
        "X-File-Size": String(payload.length),
      },
      body: payload,
    });

    assert.equal(upload.status, 201);
    const receipt = await upload.json();
    assert.equal(receipt.sha256, crypto.createHash("sha256").update(payload).digest("hex"));

    const id = receipt.id;
    assert.equal(receipt.name, "research.pdf");
    assert.equal(receipt.size, payload.length);
    assert.equal(receipt.status, "received");
    assert.equal(receipt.email, null);

    const tooBig = crypto.randomBytes(3 * 1024 * 1024);
    const bigUpload = await fetch(`http://127.0.0.1:${port}/api/drop`, {
      method: "POST",
      headers: {
        "X-File-Name": "big.pdf",
        "X-File-Size": String(tooBig.length),
      },
      body: tooBig,
    });
    assert.equal(bigUpload.status, 413);

    const emailRes = await fetch(`http://127.0.0.1:${port}/api/drop/${id}/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "operator@glowhum.example" }),
    });
    assert.equal(emailRes.status, 200);
    const emailReceipt = await emailRes.json();
    assert.equal(emailReceipt.email, "operator@glowhum.example");

    const readBack = await fetch(`http://127.0.0.1:${port}/api/drop/${id}`);
    assert.equal(readBack.status, 200);
    const readReceipt = await readBack.json();
    assert.equal(readReceipt.email, "operator@glowhum.example");
    assert.equal(readReceipt.sha256, receipt.sha256);

    const missing = await fetch(`http://127.0.0.1:${port}/api/drop/not-a-real-id`);
    assert.equal(missing.status, 404);
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dropRoot, { recursive: true, force: true });
  }

  if (childErr && !child.killed) {
    process.stderr.write(childErr);
  }
});

function signedStripeEvent(event, secret) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { body, signature: `t=${timestamp},v1=${signature}` };
}

function validCheckoutEvent(overrides = {}) {
  const session = {
    object: "checkout.session",
    id: "cs_test_paid_order_1",
    created: 1767225600,
    mode: "payment",
    payment_status: "paid",
    currency: "aed",
    amount_total: 19900,
    client_reference_id: "glowhum_one_episode_v1",
    customer_details: { email: "operator@glowhum.example" },
    metadata: {
      glowhum_product: "glowhum_one_episode_v1",
      topic: "A clear topic",
      report_url: "https://example.com/report",
    },
    ...overrides,
  };
  return {
    id: "evt_checkout_complete_1",
    type: "checkout.session.completed",
    data: { object: session },
  };
}

test("Stripe webhook validates payment, claims events, and writes consumer receipts", async () => {
  const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const serverPath = path.join(rootDir, "server.mjs");
  const port = await freePort();
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-jobs-"));
  const webhookSecret = "whsec_test_secret";
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DROP_ROOT: path.join(jobDir, "uploads"),
      GLOWHUM_DROPS_DIR: jobDir,
      STRIPE_SECRET_KEY: "sk_test_server_only",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      GLOWHUM_EPISODE_PRICE_AED: "199",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(port);
    const privateReport = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "operator@glowhum.example", report_url: "https://127.0.0.1/report" }),
    });
    assert.equal(privateReport.status, 400);

    const missingPublicBase = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "untrusted.example" },
      body: JSON.stringify({ email: "operator@glowhum.example", topic: "A clear topic" }),
    });
    assert.equal(missingPublicBase.status, 503);

    const postWebhook = (event) => {
      const signed = signedStripeEvent(event, webhookSecret);
      return fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": signed.signature },
      body: signed.body,
    });
    };

    const event = validCheckoutEvent();
    const replays = await Promise.all(Array.from({ length: 8 }, () => postWebhook(event)));
    const replayBodies = await Promise.all(replays.map((response) => response.json()));
    assert.equal(replays.filter((response) => response.status === 200).length, 8);
    assert.equal(replayBodies.filter((body) => body.created === true).length, 1);
    assert.equal(replayBodies.filter((body) => body.created === false).length, 7);

    const orderDir = path.join(jobDir, "drops", "cs_test_paid_order_1");
    const jobPath = path.join(orderDir, "receipt.json");
    const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
    assert.deepEqual(job, {
      id: "cs_test_paid_order_1",
      order_id: "cs_test_paid_order_1",
      email: "operator@glowhum.example",
      topic: "A clear topic",
      report_url: "https://example.com/report",
      price_aed: 199,
      created_at: "2026-01-01T00:00:00.000Z",
      status: "paid",
      event_id: "evt_checkout_complete_1",
      video_url: null,
      published_at: null,
      name: "request.md",
      sha256: job.sha256,
      size: job.size,
      received_at: "2026-01-01T00:00:00.000Z",
    });
    const request = await fs.readFile(path.join(orderDir, "request.md"));
    assert.equal(job.size, request.length);
    assert.equal(job.sha256, crypto.createHash("sha256").update(request).digest("hex"));
    assert.deepEqual(JSON.parse(request.toString("utf8")), {
      topic: "A clear topic",
      report_url: "https://example.com/report",
    });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(jobDir, "events", "evt_checkout_complete_1.json"), "utf8")), {
      event_id: "evt_checkout_complete_1",
      order_id: "cs_test_paid_order_1",
    });

    const conflictingEvent = validCheckoutEvent({ id: "cs_test_other_order_2" });
    const conflict = await postWebhook(conflictingEvent);
    assert.equal(conflict.status, 409);

    const retryEvent = validCheckoutEvent({ id: "cs_test_claim_retry_3" });
    retryEvent.id = "evt_claim_retry_3";
    await fs.mkdir(path.join(jobDir, "events"), { recursive: true });
    await fs.writeFile(path.join(jobDir, "events", "evt_claim_retry_3.json"), JSON.stringify({
      event_id: "evt_claim_retry_3",
      order_id: "cs_test_claim_retry_3",
    }) + "\n");
    const retry = await postWebhook(retryEvent);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { received: true, created: true, order_id: "cs_test_claim_retry_3" });
    await fs.access(path.join(jobDir, "drops", "cs_test_claim_retry_3", "receipt.json"));

    const rejected = [
      ["unrelated event", { id: "evt_unrelated_event", type: "payment_intent.succeeded", data: { object: {} } }],
      ["unrelated product", validCheckoutEvent({ id: "cs_test_reject_marker", client_reference_id: "other_product" })],
      ["missing product marker", validCheckoutEvent({ id: "cs_test_reject_metadata", metadata: { topic: "A clear topic", report_url: "https://example.com/report" } })],
      ["unpaid", validCheckoutEvent({ id: "cs_test_reject_unpaid", payment_status: "unpaid" })],
      ["wrong currency", validCheckoutEvent({ id: "cs_test_reject_currency", currency: "usd" })],
      ["wrong amount", validCheckoutEvent({ id: "cs_test_reject_amount", amount_total: 100 })],
      ["wrong object", validCheckoutEvent({ id: "cs_test_reject_object", object: "payment_intent" })],
    ];
    for (const [label, invalidEvent] of rejected) {
      if (label !== "unrelated event") invalidEvent.id = `evt_${label.replace(/[^a-z]+/g, "_")}`;
      const response = await postWebhook(invalidEvent);
      assert.equal(response.status, 400, label);
      if (invalidEvent.data.object.id) {
        await assert.rejects(fs.access(path.join(jobDir, "drops", invalidEvent.data.object.id, "receipt.json")));
      }
    }

    job.status = "published";
    job.video_url = "https://video.example/episode";
    job.published_at = "2026-01-02T00:00:00.000Z";
    await fs.writeFile(jobPath, JSON.stringify(job), "utf8");
    const status = await fetch(`http://127.0.0.1:${port}/api/order/cs_test_paid_order_1`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      order_id: "cs_test_paid_order_1",
      status: "published",
      created_at: "2026-01-01T00:00:00.000Z",
      video_url: "https://video.example/episode",
      published_at: "2026-01-02T00:00:00.000Z",
    });

    job.status = "unknown";
    await fs.writeFile(jobPath, JSON.stringify(job), "utf8");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/order/cs_test_paid_order_1`)).status, 404);

    job.status = "published";
    job.video_url = "http://video.example/episode";
    await fs.writeFile(jobPath, JSON.stringify(job), "utf8");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/order/cs_test_paid_order_1`)).status, 404);
  } finally {
    child.kill("SIGTERM");
    await fs.rm(jobDir, { recursive: true, force: true });
  }
});
