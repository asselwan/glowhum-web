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
