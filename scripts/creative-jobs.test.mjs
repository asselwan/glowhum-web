import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { createCreativeJob, creativeJobRoutes, engineCatalog, readCreativeJob, runCreativeJob } from "../creative-jobs.mjs";

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body || ""; },
  };
}

test("priced canary maps one engine to a stable customer job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-creative-jobs-"));
  try {
    const job = await createCreativeJob(root, {
      engine: "kadr-clinic-offer",
      input: { prompt: "A warm clinic offer video" },
    }, () => "2026-09-07T00:00:00.000Z");

    assert.equal(job.status, "queued");
    assert.equal(job.canary, true);
    assert.deepEqual(job.price, { amount: 199, currency: "AED", basis: "Glowhum one episode offer" });
    assert.equal(job.input.prompt, "A warm clinic offer video");
    assert.match(job.job_url, new RegExp(`/job\\?id=${job.id}$`));
    assert.deepEqual(await readCreativeJob(root, job.id), job);
    assert.equal((await fs.readdir(path.join(root, "jobs", job.id))).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("engine catalog states the bounded canary capability and price", () => {
  const catalog = engineCatalog();
  assert.equal(catalog.engines.length, 1);
  assert.equal(catalog.engines[0].id, "kadr-clinic-offer");
  assert.equal(catalog.engines[0].duration_seconds, 5);
  assert.equal(catalog.engines[0].resolution, "720p");
  assert.deepEqual(catalog.engines[0].price, { amount: 199, currency: "AED", basis: "Glowhum one episode offer" });
});

test("customer job routes return the catalog, a stable job view, and validation errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-creative-jobs-"));
  try {
    const catalogRes = responseRecorder();
    await creativeJobRoutes({ method: "GET", headers: Symbol("unused") }, catalogRes, "/api/engines", root);
    assert.equal(catalogRes.status, 200);
    assert.equal(JSON.parse(catalogRes.body).engines[0].id, "kadr-clinic-offer");

    const createRes = responseRecorder();
    const createReq = Readable.from([Buffer.from(JSON.stringify({ engine: "kadr-clinic-offer", input: { prompt: "A quiet clinic offer" } }))]);
    createReq.method = "POST";
    createReq.headers = { "content-type": "application/json" };
    await creativeJobRoutes(createReq, createRes, "/api/jobs", root);
    assert.equal(createRes.status, 202);
    const created = JSON.parse(createRes.body);

    const readRes = responseRecorder();
    await creativeJobRoutes({ method: "GET", headers: {} }, readRes, `/api/jobs/${created.id}`, root);
    assert.equal(readRes.status, 200);
    assert.equal(JSON.parse(readRes.body).price.amount, 199);

    const badRes = responseRecorder();
    const badReq = Readable.from([Buffer.from(JSON.stringify({ engine: "unknown", input: { prompt: "x" } }))]);
    badReq.method = "POST";
    badReq.headers = { "content-type": "application/json" };
    await creativeJobRoutes(badReq, badRes, "/api/jobs", root);
    assert.equal(badRes.status, 400);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("worker claims the canary and records a failed run without a provider key", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-creative-jobs-"));
  try {
    const job = await createCreativeJob(root, { engine: "kadr-clinic-offer", input: { prompt: "A canary" } });
    await assert.rejects(() => runCreativeJob(root, job.id, { key: "" }), /FAL_KEY is required/);
    const failed = await readCreativeJob(root, job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.output, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("creative job input rejects an unknown engine and a blank prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "glowhum-creative-jobs-"));
  try {
    await assert.rejects(() => createCreativeJob(root, { engine: "unknown", input: { prompt: "x" } }), /Use the kadr-clinic-offer engine/);
    await assert.rejects(() => createCreativeJob(root, { engine: "kadr-clinic-offer", input: { prompt: " " } }), /Add a prompt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
