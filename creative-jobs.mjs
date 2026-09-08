import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPreset, renderKadrPreset } from "./scripts/kadr-render.mjs";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROMPT_LENGTH = 1000;
const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CANARY_PRESET_PATH = path.join(MODULE_ROOT, "kadr", "presets", "glowhum-clinic-offer.json");

export const CANARY_ENGINE = Object.freeze({
  id: "kadr-clinic-offer",
  name: "Clinic offer video",
  capability: "short_video",
  provider: "fal",
  model: "fal-ai/bytedance/seedance/v1.5/pro/text-to-video",
  input: ["prompt"],
  output: "video",
  duration_seconds: 5,
  resolution: "720p",
  audio: true,
});

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function canaryPriceAed() {
  return positiveInteger(process.env.GLOWHUM_CANARY_PRICE_AED, positiveInteger(process.env.GLOWHUM_EPISODE_PRICE_AED, 199));
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) fail(413, "This job request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail(400, "Send a JSON job request.");
  }
}

function jobsRoot(root) {
  return path.join(root, "jobs");
}

function jobPath(root, id) {
  if (!JOB_ID_PATTERN.test(id)) fail(404, "Job not found.");
  return path.join(jobsRoot(root), id, "job.json");
}

function publicJob(job) {
  return {
    id: job.id,
    engine: job.engine,
    capability: job.capability,
    status: job.status,
    input: job.input,
    output: job.output,
    price: job.price,
    canary: job.canary,
    execution: job.execution,
    created_at: job.created_at,
    updated_at: job.updated_at,
    job_url: `/job?id=${encodeURIComponent(job.id)}`,
  };
}

function validateCreateInput(input) {
  if (input?.engine !== CANARY_ENGINE.id) fail(400, `Use the ${CANARY_ENGINE.id} engine.`);
  const prompt = typeof input?.input?.prompt === "string" ? input.input.prompt.trim() : "";
  if (!prompt) fail(400, "Add a prompt for the canary.");
  if (prompt.length > MAX_PROMPT_LENGTH) fail(400, `Keep the prompt under ${MAX_PROMPT_LENGTH} characters.`);
  return { prompt };
}

export function engineCatalog() {
  return {
    engines: [{
      ...CANARY_ENGINE,
      price: { amount: canaryPriceAed(), currency: "AED", basis: "Glowhum one episode offer" },
      canary: true,
    }],
  };
}

export async function createCreativeJob(root, input, now = () => new Date().toISOString()) {
  const validated = validateCreateInput(input);
  const timestamp = now();
  const id = crypto.randomUUID();
  const job = {
    schema: "glowhum.creative-job.v1",
    id,
    engine: CANARY_ENGINE.id,
    capability: CANARY_ENGINE.capability,
    status: "queued",
    input: validated,
    output: null,
    price: { amount: canaryPriceAed(), currency: "AED", basis: "Glowhum one episode offer" },
    canary: true,
    execution: {
      state: "waiting_for_worker",
      provider: CANARY_ENGINE.provider,
      model: CANARY_ENGINE.model,
      bounded_seconds: 600,
    },
    created_at: timestamp,
    updated_at: timestamp,
  };
  const directory = path.join(jobsRoot(root), id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "job.json"), `${JSON.stringify(job, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return publicJob(job);
}

export async function readCreativeJob(root, id) {
  const job = JSON.parse(await fs.readFile(jobPath(root, id), "utf8"));
  if (job.schema !== "glowhum.creative-job.v1" || job.id !== id) fail(404, "Job not found.");
  return publicJob(job);
}

async function readStoredJob(root, id) {
  const stored = JSON.parse(await fs.readFile(jobPath(root, id), "utf8"));
  if (stored.schema !== "glowhum.creative-job.v1" || stored.id !== id) fail(404, "Job not found.");
  return stored;
}

async function writeStoredJob(root, job) {
  await fs.writeFile(jobPath(root, job.id), `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
}

export async function runCreativeJob(root, id, {
  key = process.env.FAL_KEY,
  outputPath = path.join(root, "jobs", id, "output", "canary.mp4"),
  promptId = process.env.TWOTHUMBS_PROMPT_ID,
  promptVersion = process.env.TWOTHUMBS_PROMPT_VERSION ? Number(process.env.TWOTHUMBS_PROMPT_VERSION) : undefined,
  ...renderOptions
} = {}) {
  const job = await readStoredJob(root, id);
  if (job.status !== "queued") fail(409, "This job is not waiting for a worker.");
  await writeStoredJob(root, { ...job, status: "running", execution: { ...job.execution, state: "running" }, updated_at: new Date().toISOString() });
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const preset = await loadPreset(CANARY_PRESET_PATH);
    const receipt = await renderKadrPreset({
      ...renderOptions,
      preset: { ...preset, prompt: job.input.prompt },
      key,
      outputPath,
      promptId,
      promptVersion,
      pollTimeoutMs: 10 * 60 * 1000,
    });
    const completed = {
      ...job,
      status: "completed",
      output: {
        kind: "video",
        file: path.relative(path.join(root, "jobs", id), outputPath),
        bytes: receipt.output_bytes,
        sha256: receipt.output_sha256,
      },
      execution: { ...job.execution, state: "completed" },
      updated_at: new Date().toISOString(),
    };
    await writeStoredJob(root, completed);
    return publicJob(completed);
  } catch (error) {
    const failed = {
      ...job,
      status: "failed",
      execution: { ...job.execution, state: "failed" },
      failure: "The canary worker could not complete this job.",
      updated_at: new Date().toISOString(),
    };
    await writeStoredJob(root, failed);
    throw error;
  }
}

export async function creativeJobRoutes(req, res, pathname, root) {
  try {
    if (pathname === "/api/engines" && req.method === "GET") {
      json(res, 200, engineCatalog());
      return true;
    }
    if (pathname === "/api/jobs" && req.method === "POST") {
      if (!(req.headers["content-type"] || "").startsWith("application/json")) fail(415, "Send the job as JSON.");
      json(res, 202, await createCreativeJob(root, await readJson(req)));
      return true;
    }
    const match = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
    if (match && req.method === "GET") {
      json(res, 200, await readCreativeJob(root, match[1]));
      return true;
    }
    return false;
  } catch (error) {
    if (Number.isInteger(error?.status)) json(res, error.status, { error: error.message });
    else if (error?.code === "ENOENT") json(res, 404, { error: "Job not found." });
    else json(res, 500, { error: "Could not handle this job." });
    return true;
  }
}
