import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPreset, renderKadrPreset, SAVED_FAL_MODEL } from "./kadr-render.mjs";

const presetPath = path.join(import.meta.dirname, "..", "kadr", "presets", "glowhum-clinic-offer.json");

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

test("saved preset holds the fal slug, Glowhum decision, and budget", async () => {
  const preset = await loadPreset(presetPath);
  assert.equal(preset.model, SAVED_FAL_MODEL);
  assert.equal(preset.brand, "Glowhum");
  assert.equal(preset.budget.max_usd, 1.2);
  assert.equal(preset.input.resolution, "720p");
  assert.equal(preset.input.duration, "5");
  assert.equal(preset.input.generate_audio, true);
});

test("runner submits the saved slug, polls, downloads, and writes a receipt", async () => {
  const preset = await loadPreset(presetPath);
  const dir = await mkdtemp(path.join(os.tmpdir(), "glowhum-kadr-"));
  const outputPath = path.join(dir, "clip.mp4");
  const calls = [];
  const fakeVideo = Buffer.from("real test video bytes");
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === "POST") return response({ request_id: "req_test", status_url: "https://queue.test/status", response_url: "https://queue.test/result" });
    if (String(url).endsWith("/status")) return response({ status: "COMPLETED" });
    if (String(url).endsWith("/result")) return response({ video: { url: "https://fal.media/test.mp4" }, seed: 2601 });
    if (String(url).startsWith("https://api.fal.ai/v1/models/billing-events")) return response({ billing_events: [{ request_id: "req_test", endpoint_id: SAVED_FAL_MODEL, timestamp: "2026-09-07T00:00:01Z", output_units: 5, unit_price: 0.052, cost_total: 0.26, currency: "USD" }] });
    return new Response(fakeVideo, { status: 200, headers: { "content-type": "video/mp4" } });
  };
  try {
    const receipt = await renderKadrPreset({ preset, key: "test-key", outputPath, fetchImpl: fakeFetch, now: () => "2026-09-07T00:00:00.000Z" });
    assert.equal(receipt.saved_slug_verified, true);
    assert.equal(receipt.request_id, "req_test");
    assert.equal(receipt.brand, "Glowhum");
    assert.equal(receipt.output_bytes, fakeVideo.length);
    assert.equal(receipt.billing_readback.status, "found");
    assert.equal(receipt.actual_cost_usd, 0.26);
    assert.equal(receipt.within_budget, true);
    assert.equal((await readFile(outputPath)).toString(), fakeVideo.toString());
    assert.match((await readFile(`${outputPath}.receipt.json`)).toString(), /glowhum\.kadr-render-receipt\.v1/);
    assert.equal(calls[0].url, `https://queue.fal.run/${SAVED_FAL_MODEL}`);
    assert.match(calls[0].options.headers.Authorization, /^Key /);
    assert.equal(JSON.parse(calls[0].options.body).input, undefined);
    assert.equal(JSON.parse(calls[0].options.body).prompt, preset.prompt);
    assert.match(calls[0].options.body, /"aspect_ratio":"9:16"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner refuses a changed slug, brand, or budget before network use", async () => {
  const preset = await loadPreset(presetPath);
  for (const change of [
    { model: "fal-ai/bytedance/seedance-2.0" },
    { brand: "KADR" },
    { budget: { max_usd: 1.21 } },
  ]) {
    const altered = { ...preset, ...change };
    await assert.rejects(() => renderKadrPreset({ preset: altered, key: "test-key", outputPath: "/tmp/unused.mp4", fetchImpl: async () => { throw new Error("network used"); } }));
  }
});
