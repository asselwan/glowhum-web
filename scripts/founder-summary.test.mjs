import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFounderSummary, deliverFounderSummary, founderSummaryRoutes } from "../founder-summary.mjs";

const sourcePath = "/home/ainur/Apps/.ainur/physai/NOMOI_CHANNEL_FORMAT_GENSPARK_K3_2026_09_04.md";

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "glowhum-founder-summary-"));
}

function fakeResponse(status, body) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function request(method, authorization, body = "{}") {
  return {
    method,
    headers: authorization ? { authorization } : {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
  };
}

function responseCapture() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
}

test("founder summary is generated from the complete verified source", async () => {
  const source = await fs.readFile(sourcePath);
  const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
  const summary = buildFounderSummary(source.toString("utf8"), sourceHash);

  assert.match(summary, /The format/);
  assert.match(summary, /Founder's on-camera role and exact shot list/);
  assert.match(summary, /ASK → ACKNOWLEDGEMENT → REFINEMENT → RECEIPT/);
  assert.match(summary, /The solo production kit/);
  assert.match(summary, /S0/);
  assert.match(summary, /ASK → ACKNOWLEDGEMENT → REFINEMENT → RECEIPT/);
  assert.match(summary, /### 3\.8 Receipts archive/);
  assert.match(summary, /EP001/);
  assert.match(summary, /EP002/);
  assert.match(summary, /EP003/);
  assert.doesNotMatch(summary, /\s[—–]\s/);
  assert.match(summary, new RegExp(`Source SHA 256: ${sourceHash}`));
});

test("successful founder delivery keeps the provider receipt and is idempotent", async () => {
  const storageRoot = await tempRoot();
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), request: JSON.parse(request.body), headers: request.headers });
    return fakeResponse(202, JSON.stringify({ provider_receipt_id: "founder-20260907-1", accepted: true }));
  };

  const first = await deliverFounderSummary({ sourcePath, storageRoot, deliveryUrl: "https://founder.example/deliver", fetchImpl, promptVersion: 124 });
  const second = await deliverFounderSummary({ sourcePath, storageRoot, deliveryUrl: "https://founder.example/deliver", fetchImpl, promptVersion: 124 });

  assert.equal(first.status, "send_confirmed");
  assert.equal(first.provider.http_status, 202);
  assert.equal(first.provider.response_body, JSON.stringify({ provider_receipt_id: "founder-20260907-1", accepted: true }));
  assert.equal(second.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.schema, "glowhum.founder-summary.v1");
  assert.equal(calls[0].request.source_sha256, first.source_sha256);
  assert.equal(calls[0].headers["Idempotency-Key"], first.delivery_id);
  assert.equal(calls[0].headers["X-Glowhum-Message-SHA256"], first.message_sha256);
  assert.equal(first.provider.response_sha256, crypto.createHash("sha256").update(first.provider.response_body).digest("hex"));
  assert.equal(first.message_sha256, crypto.createHash("sha256").update(first.message).digest("hex"));
  assert.equal(await fs.readFile(path.join(storageRoot, `${first.delivery_id}.json`), "utf8").then(JSON.parse).then((receipt) => receipt.provider.response_body), first.provider.response_body);
});

test("a provider rejection is retained as a failed receipt", async () => {
  const storageRoot = await tempRoot();
  await assert.rejects(
    deliverFounderSummary({
      sourcePath,
      storageRoot,
      deliveryUrl: "https://founder.example/deliver",
      fetchImpl: async () => fakeResponse(400, JSON.stringify({ error: "not accepted" })),
    }),
    /rejected/,
  );
  const receipts = await fs.readdir(storageRoot);
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await fs.readFile(path.join(storageRoot, receipts[0]), "utf8"));
  assert.equal(receipt.status, "send_rejected");
  assert.equal(receipt.provider.http_status, 400);
  assert.equal(receipt.provider.response_body, JSON.stringify({ error: "not accepted" }));
});

test("founder delivery rejects a non-HTTPS destination before provider use", async () => {
  const storageRoot = await tempRoot();
  let called = false;
  await assert.rejects(
    deliverFounderSummary({
      sourcePath,
      storageRoot,
      deliveryUrl: "http://founder.example/deliver",
      fetchImpl: async () => { called = true; return fakeResponse(200, "{}"); },
    }),
    /must use HTTPS/,
  );
  assert.equal(called, false);
  assert.deepEqual(await fs.readdir(storageRoot), []);
});

test("a transport error is retained as unknown and blocks an unsafe retry", async () => {
  const storageRoot = await tempRoot();
  const options = {
    sourcePath,
    storageRoot,
    deliveryUrl: "https://founder.example/deliver",
    fetchImpl: async () => { throw new Error("connection refused"); },
  };
  await assert.rejects(deliverFounderSummary(options), /could not be confirmed/);
  await assert.rejects(deliverFounderSummary(options), /unknown result/);
});

test("an explicit retry can recover an unknown send with the same idempotency key", async () => {
  const storageRoot = await tempRoot();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("response lost");
    return fakeResponse(200, JSON.stringify({ receipt_id: "provider-retry-1" }));
  };
  const options = { sourcePath, storageRoot, deliveryUrl: "https://founder.example/deliver", fetchImpl };
  await assert.rejects(deliverFounderSummary(options), /could not be confirmed/);
  const recovered = await deliverFounderSummary({ ...options, retry: true });
  assert.equal(recovered.status, "send_confirmed");
  assert.equal(calls, 2);
});

test("founder delivery route requires its server token", async () => {
  const previous = process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN;
  process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN = "x".repeat(32);
  try {
    const response = responseCapture();
    await founderSummaryRoutes(request("POST", "Bearer wrong"), response, "/api/founder-summary/deliver", {});
    assert.equal(response.status, 401);
    assert.deepEqual(JSON.parse(response.body), { error: "Founder delivery access required." });
  } finally {
    if (previous === undefined) delete process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN;
    else process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN = previous;
  }
});

test("authenticated founder delivery route returns the retained send receipt", async () => {
  const previous = process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN;
  process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN = "y".repeat(32);
  const storageRoot = await tempRoot();
  try {
    const response = responseCapture();
    await founderSummaryRoutes(
      request("POST", `Bearer ${process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN}`),
      response,
      "/api/founder-summary/deliver",
      {
        sourcePath,
        storageRoot,
        deliveryUrl: "https://founder.example/deliver",
        fetchImpl: async () => fakeResponse(200, JSON.stringify({ receipt_id: "provider-1" })),
      },
    );
    const receipt = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.equal(receipt.status, "send_confirmed");
    assert.equal(receipt.provider.response_body, JSON.stringify({ receipt_id: "provider-1" }));
  } finally {
    if (previous === undefined) delete process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN;
    else process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN = previous;
  }
});
