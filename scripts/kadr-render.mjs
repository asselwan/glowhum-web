import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SAVED_FAL_MODEL = "fal-ai/bytedance/seedance/v1.5/pro/text-to-video";
export const FAL_QUEUE_ROOT = "https://queue.fal.run";
export const FAL_BILLING_EVENTS_ROOT = "https://api.fal.ai/v1/models/billing-events";
export const POLL_INTERVAL_MS = 5000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function jsonHeaders(key) {
  return { Authorization: `Key ${key}`, "Content-Type": "application/json" };
}

function assertPreset(preset) {
  if (!preset || typeof preset !== "object") throw new Error("preset must be an object");
  for (const field of ["id", "name", "brand", "provider", "model", "prompt"]) {
    if (typeof preset[field] !== "string" || !preset[field].trim()) throw new Error(`preset ${field} is required`);
  }
  if (preset.provider !== "fal") throw new Error(`unsupported provider: ${preset.provider}`);
  if (preset.model !== SAVED_FAL_MODEL) throw new Error(`saved fal slug mismatch: ${preset.model}`);
  if (preset.brand !== "Glowhum") throw new Error(`brand decision mismatch: ${preset.brand}`);
  if (!preset.input || preset.input.resolution !== "720p" || preset.input.duration !== "5" || preset.input.generate_audio !== true) {
    throw new Error("preset must use the recorded 720p, five second, audio settings");
  }
  if (!Number.isFinite(preset.budget?.max_usd) || preset.budget.max_usd > 1.2) {
    throw new Error("preset exceeds the recorded KADR budget");
  }
}

async function parseJson(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${label} returned non JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`${label} failed HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(ms, sleep) {
  if (sleep) return sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readFalBillingEvent({ key, requestId, fetchImpl = fetch } = {}) {
  if (!key) throw new Error("FAL_KEY is required for billing readback");
  if (!requestId) throw new Error("requestId is required for billing readback");
  const url = new URL(FAL_BILLING_EVENTS_ROOT);
  url.searchParams.set("request_id", requestId);
  url.searchParams.set("limit", "50");
  const response = await fetchImpl(url, { headers: jsonHeaders(key) });
  if (!response.ok) return { status: "unavailable", http_status: response.status };
  const body = await parseJson(response, "fal billing events");
  const event = (body.billing_events ?? []).find((item) => item.request_id === requestId);
  if (!event) return { status: "not_found", http_status: response.status, request_id: requestId };
  const costUsd = Number(event.cost_total ?? (Number(event.cost_estimate_nano_usd) / 1e9));
  return {
    status: "found",
    http_status: response.status,
    request_id: requestId,
    endpoint_id: event.endpoint_id ?? null,
    timestamp: event.timestamp ?? null,
    output_units: event.output_units ?? null,
    unit_price: event.unit_price ?? null,
    cost_usd: Number.isFinite(costUsd) ? costUsd : null,
    currency: event.currency ?? "USD",
  };
}

export async function attachBillingReadback({ receiptPath, outputPath = receiptPath, key = process.env.FAL_KEY, fetchImpl = fetch } = {}) {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const billing = await readFalBillingEvent({ key, requestId: receipt.request_id, fetchImpl });
  const updated = { ...receipt, billing_readback: billing };
  if (billing.status === "found" && billing.cost_usd !== null) {
    updated.cost_basis = "Fal billing event readback for this request.";
    updated.actual_cost_usd = billing.cost_usd;
    updated.within_budget = billing.cost_usd <= receipt.budget_max_usd;
  }
  await writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  return updated;
}

export async function renderKadrPreset({
  preset,
  key = process.env.FAL_KEY,
  outputPath,
  promptId,
  promptVersion,
  fetchImpl = fetch,
  sleep,
  now = () => new Date().toISOString(),
  pollIntervalMs = POLL_INTERVAL_MS,
  pollTimeoutMs = POLL_TIMEOUT_MS,
} = {}) {
  assertPreset(preset);
  if (!key) throw new Error("FAL_KEY is required and must stay server side");
  if (!outputPath) throw new Error("outputPath is required");

  const submittedAt = now();
  const submitUrl = `${FAL_QUEUE_ROOT}/${preset.model}`;
  const submitResponse = await fetchImpl(submitUrl, {
    method: "POST",
    headers: jsonHeaders(key),
    body: JSON.stringify({ prompt: preset.prompt, ...preset.input }),
  });
  const submitted = await parseJson(submitResponse, "fal queue submit");
  if (!submitted.request_id || !submitted.status_url || !submitted.response_url) {
    throw new Error("fal queue submit returned incomplete request metadata");
  }

  const deadline = Date.now() + pollTimeoutMs;
  let statusBody;
  while (Date.now() <= deadline) {
    const statusResponse = await fetchImpl(submitted.status_url, { headers: jsonHeaders(key) });
    statusBody = await parseJson(statusResponse, "fal queue status");
    if (statusBody.status === "COMPLETED") break;
    if (statusBody.status === "FAILED") throw new Error(`fal render failed: ${JSON.stringify(statusBody)}`);
    if (!["IN_QUEUE", "IN_PROGRESS"].includes(statusBody.status)) throw new Error(`unexpected fal status: ${statusBody.status}`);
    await waitFor(pollIntervalMs, sleep);
  }
  if (statusBody?.status !== "COMPLETED") throw new Error("fal render timed out");

  const resultResponse = await fetchImpl(submitted.response_url, { headers: jsonHeaders(key) });
  const result = await parseJson(resultResponse, "fal queue result");
  const videoUrl = result.video?.url;
  if (typeof videoUrl !== "string" || !/^https:\/\//.test(videoUrl)) throw new Error("fal result did not contain an HTTPS video URL");
  const billing = await readFalBillingEvent({ key, requestId: submitted.request_id, fetchImpl });
  if (billing.status === "found" && billing.cost_usd !== null && billing.cost_usd > preset.budget.max_usd) {
    throw new Error(`fal billing event exceeds preset budget: ${billing.cost_usd} > ${preset.budget.max_usd} USD`);
  }

  const downloadResponse = await fetchImpl(videoUrl);
  if (!downloadResponse.ok) throw new Error(`fal video download failed HTTP ${downloadResponse.status}`);
  const videoBytes = Buffer.from(await downloadResponse.arrayBuffer());
  if (!videoBytes.length) throw new Error("fal video download was empty");
  await writeFile(outputPath, videoBytes, { flag: "wx", mode: 0o600 });

  const receipt = {
    schema: "glowhum.kadr-render-receipt.v1",
    prompt_id: promptId ?? null,
    prompt_version: promptVersion ?? null,
    preset_id: preset.id,
    brand: preset.brand,
    provider: "fal",
    model: preset.model,
    saved_slug_verified: true,
    live_slug_verified_at_submit: submittedAt,
    request_id: submitted.request_id,
    provider_status: statusBody.status,
    provider_seed: result.seed ?? null,
    video_url: videoUrl,
    output_path: path.resolve(outputPath),
    output_bytes: videoBytes.length,
    output_sha256: createHash("sha256").update(videoBytes).digest("hex"),
    requested_input: { ...preset.input },
    budget_max_usd: preset.budget.max_usd,
    billing_readback: billing,
    cost_basis: billing.status === "found" ? "Fal billing event readback for this request." : "Provider page states roughly $0.26 for 720p five second video with audio. Actual invoice was not returned by this API response.",
    ...(billing.status === "found" && billing.cost_usd !== null ? { actual_cost_usd: billing.cost_usd, within_budget: billing.cost_usd <= preset.budget.max_usd } : {}),
    rendered_at: now(),
  };
  const receiptPath = `${outputPath}.receipt.json`;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

export async function loadPreset(presetPath) {
  return JSON.parse(await readFile(presetPath, "utf8"));
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const billingRequestId = argValue(process.argv, "--billing-request-id");
  const receiptPath = argValue(process.argv, "--receipt");
  const receiptOut = argValue(process.argv, "--receipt-out");
  if (billingRequestId) {
    try {
      const value = receiptPath
        ? await attachBillingReadback({ receiptPath, outputPath: receiptOut ?? receiptPath })
        : await readFalBillingEvent({ key: process.env.FAL_KEY, requestId: billingRequestId });
      console.log(JSON.stringify(value, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
  const presetPath = argValue(process.argv, "--preset");
  const outputPath = argValue(process.argv, "--out");
  if (!presetPath || !outputPath) {
    console.error("Usage: FAL_KEY=... node scripts/kadr-render.mjs --preset FILE --out MP4");
    process.exitCode = 2;
  } else {
    try {
      const receipt = await renderKadrPreset({ preset: await loadPreset(presetPath), outputPath, promptId: process.env.TWOTHUMBS_PROMPT_ID, promptVersion: process.env.TWOTHUMBS_PROMPT_VERSION });
      console.log(JSON.stringify(receipt, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
  }
}
