import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderRunpod } from "./runpod-render.mjs";

test("RunPod adapter invokes the bounded Hopper command and records the output hash", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glowhum-runpod-"));
  const outputPath = path.join(dir, "cold.mp4");
  try {
    const receipt = await renderRunpod({
      prompt: "A quiet sunrise",
      outputPath,
      seconds: 3,
      keepPod: true,
      command: "/fixed/hopper-render",
      env: { HOPPER_VOLUME_ID: "qgyf1j30uz" },
      now: () => "2026-09-07T00:00:00.000Z",
      runCommand: async ({ command, args, outputPath: target }) => {
        assert.equal(command, "/fixed/hopper-render");
        assert.deepEqual(args, ["--t2v", "A quiet sunrise", "--seconds", "3", "--out", target, "--keep-pod"]);
        await writeFile(target, "bounded video bytes");
        return { code: 0, stdout: "", stderr: "ok" };
      },
    });
    assert.equal(receipt.provider, "runpod");
    assert.equal(receipt.volume_id, "qgyf1j30uz");
    assert.equal(receipt.volume_mount_path, "/workspace");
    assert.equal(receipt.volume_attach_configured, true);
    assert.equal(receipt.output_bytes, 19);
    assert.match(receipt.output_sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(await readFile(`${outputPath}.receipt.json`, "utf8")).output_sha256, receipt.output_sha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RunPod adapter rejects a successful process that did not write an output", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glowhum-runpod-"));
  try {
    await assert.rejects(
      () => renderRunpod({ prompt: "A quiet sunrise", outputPath: path.join(dir, "missing.mp4"), env: { HOPPER_ENV_FILE: "" }, runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) }),
      /without a nonempty output file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("RunPod adapter reports the worker failure and does not create a receipt", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glowhum-runpod-"));
  const outputPath = path.join(dir, "failed.mp4");
  try {
    await assert.rejects(
      () => renderRunpod({ prompt: "A quiet sunrise", outputPath, runCommand: async () => ({ code: 1, stdout: "", stderr: "capacity failed" }) }),
      /RunPod render failed with exit 1: capacity failed/,
    );
    await assert.rejects(() => readFile(`${outputPath}.receipt.json`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
