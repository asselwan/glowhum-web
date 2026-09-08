import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-topic-preview-"));
process.env.GLOWHUM_DROPS_DIR = root;
process.env.GLOWHUM_PREVIEW_MAX_BYTES = "1024";
const { topicPreviewRoutes } = await import("../topic-preview.mjs");

function response() {
  return {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; },
  };
}

function request(method, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { yield bytes; },
  };
}

async function call(method, pathname, body, headers) {
  const res = response();
  await topicPreviewRoutes(request(method, body, headers), res, pathname, root);
  return { ...res, json: res.body && !Buffer.isBuffer(res.body) ? JSON.parse(res.body) : null };
}

test("an anonymous topic reaches a complete preview and download needs an active entitlement", async () => {
  try {
    const created = await call("POST", "/api/topic-preview", JSON.stringify({ topic: "How sleep affects focus" }), { "content-type": "application/json" });
    assert.equal(created.status, 201);
    assert.equal(created.json.status, "previewing");
    assert.equal(created.json.topic, "How sleep affects focus");
    assert.match(created.json.id, /^[a-f0-9]{36}$/);

    const id = created.json.id;
    const beforeVideo = await call("GET", `/api/topic-preview/${id}/video`);
    assert.equal(beforeVideo.status, 404);

    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(40, 7)]);
    const saved = await call("POST", `/api/topic-preview/${id}/video`, webm, { "content-type": "video/webm" });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.status, "ready");
    assert.equal(saved.json.video.content_type, "video/webm");
    assert.equal(saved.json.video.size, webm.length);

    const watched = await call("GET", `/api/topic-preview/${id}/video`);
    assert.equal(watched.status, 200);
    assert.equal(watched.headers["Content-Disposition"], 'inline; filename="glowhum-topic-preview.webm"');
    assert.deepEqual(watched.body, webm);

    const noOrder = await call("POST", `/api/topic-preview/${id}/download`, JSON.stringify({}), { "content-type": "application/json" });
    assert.equal(noOrder.status, 401);

    const entitlementId = "cs_test_topic_preview_1";
    await fs.mkdir(path.join(root, "entitlements"), { recursive: true });
    await fs.writeFile(path.join(root, "entitlements", `${entitlementId}.json`), JSON.stringify({
      entitlement_id: entitlementId,
      order_id: entitlementId,
      product: "glowhum_one_episode_v1",
      status: "active",
    }));
    const download = await call("POST", `/api/topic-preview/${id}/download`, JSON.stringify({ entitlement_id: entitlementId }), { "content-type": "application/json" });
    assert.equal(download.status, 200);
    assert.equal(download.headers["Content-Disposition"], 'attachment; filename="glowhum-topic-preview.webm"');
    assert.deepEqual(download.body, webm);

    await fs.writeFile(path.join(root, "entitlements", `${entitlementId}.json`), JSON.stringify({
      entitlement_id: entitlementId,
      order_id: entitlementId,
      product: "glowhum_one_episode_v1",
      status: "revoked",
    }));
    const revoked = await call("POST", `/api/topic-preview/${id}/download`, JSON.stringify({ entitlement_id: entitlementId }), { "content-type": "application/json" });
    assert.equal(revoked.status, 403);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("topic preview route rejects empty topics and non-video uploads", async () => {
  const empty = await call("POST", "/api/topic-preview", JSON.stringify({ topic: " " }), { "content-type": "application/json" });
  assert.equal(empty.status, 400);
  const created = await call("POST", "/api/topic-preview", JSON.stringify({ topic: "A topic" }), { "content-type": "application/json" });
  const badVideo = await call("POST", `/api/topic-preview/${created.json.id}/video`, Buffer.alloc(40), { "content-type": "text/plain" });
  assert.equal(badVideo.status, 415);
});
