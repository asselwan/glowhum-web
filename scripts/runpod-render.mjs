import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_HOPPER_RENDER_BIN = "/home/ainur/Apps/.tools/hopper-render";
export const RUNPOD_RECEIPT_SCHEMA = "glowhum.runpod-render-receipt.v1";
export const DEFAULT_HOPPER_ENV_FILE = "/home/ainur/.ainur/hopper.env";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export async function readConfiguredVolumeId({ env = process.env, envFile = DEFAULT_HOPPER_ENV_FILE } = {}) {
  if (typeof env.HOPPER_VOLUME_ID === "string" && env.HOPPER_VOLUME_ID.trim()) return env.HOPPER_VOLUME_ID.trim();
  if (env.HOPPER_ENV_FILE === "") return null;
  const text = await readFile(env.HOPPER_ENV_FILE || envFile, "utf8").catch(() => "");
  const match = text.match(/^HOPPER_VOLUME_ID=([^\n]*)$/m);
  const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return value || null;
}

export function runHopperCommand({ command, args, env = process.env, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function renderRunpod({
  prompt,
  outputPath,
  seconds = 5,
  keepPod = false,
  command = process.env.HOPPER_RENDER_BIN || DEFAULT_HOPPER_RENDER_BIN,
  env = process.env,
  runCommand = runHopperCommand,
  now = () => new Date().toISOString(),
} = {}) {
  const cleanPrompt = requiredText(prompt, "prompt");
  const target = path.resolve(requiredText(outputPath, "outputPath"));
  const duration = positiveInteger(seconds, "seconds");
  const executable = requiredText(command, "HOPPER_RENDER_BIN");
  const args = ["--t2v", cleanPrompt, "--seconds", String(duration), "--out", target];
  if (keepPod) args.push("--keep-pod");
  const volumeId = await readConfiguredVolumeId({ env });
  const volumeMountPath = env.HOPPER_VOLUME_MOUNT_PATH || "/workspace";

  const startedAt = now();
  const result = await runCommand({ command: executable, args, env, outputPath: target });
  if (result?.code !== 0) {
    const detail = String(result?.stderr || result?.stdout || "").trim().slice(-1000);
    throw new Error(`RunPod render failed with exit ${result?.code ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }
  const bytes = await stat(target).catch(() => null);
  if (!bytes?.isFile() || bytes.size <= 0) throw new Error("RunPod render completed without a nonempty output file");
  const body = await readFile(target);
  const receipt = {
    schema: RUNPOD_RECEIPT_SCHEMA,
    provider: "runpod",
    worker: path.basename(executable),
    volume_id: volumeId,
    volume_mount_path: volumeId ? volumeMountPath : null,
    volume_attach_configured: Boolean(volumeId),
    prompt: cleanPrompt,
    seconds: duration,
    keep_pod: keepPod,
    output_path: target,
    output_bytes: bytes.size,
    output_sha256: createHash("sha256").update(body).digest("hex"),
    started_at: startedAt,
    rendered_at: now(),
  };
  await writeFile(`${target}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return receipt;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const promptIndex = process.argv.indexOf("--prompt");
  const outIndex = process.argv.indexOf("--out");
  const prompt = promptIndex === -1 ? "" : process.argv[promptIndex + 1];
  const outputPath = outIndex === -1 ? "" : process.argv[outIndex + 1];
  const secondsIndex = process.argv.indexOf("--seconds");
  const seconds = secondsIndex === -1 ? 5 : process.argv[secondsIndex + 1];
  const keepPod = process.argv.includes("--keep-pod");
  if (!prompt || !outputPath) {
    console.error("Usage: node scripts/runpod-render.mjs --prompt TEXT --out FILE [--seconds N] [--keep-pod]");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await renderRunpod({ prompt, outputPath, seconds, keepPod }), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
