import { mkdir } from "node:fs/promises";
import path from "node:path";
import { renderRunpod } from "./runpod-render.mjs";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

const prompt = argument("--prompt", "A quiet sunrise over a desert clinic, simple cinematic motion");
const outputRoot = path.resolve(argument("--out-dir", "/tmp/glowhum-runpod-cold-warm"));
const seconds = argument("--seconds", "3");

try {
  await mkdir(outputRoot, { recursive: true });
  const cold = await renderRunpod({
    prompt,
    seconds,
    outputPath: path.join(outputRoot, "cold.mp4"),
    keepPod: true,
  });
  const warm = await renderRunpod({
    prompt,
    seconds,
    outputPath: path.join(outputRoot, "warm.mp4"),
    keepPod: false,
  });
  console.log(JSON.stringify({ schema: "glowhum.runpod-cold-warm-proof.v1", cold, warm }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
