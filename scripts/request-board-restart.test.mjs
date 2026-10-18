// Cross-process tests: real server.mjs processes over HTTP with synthetic
// fixtures — served operator shell, API auth boundary, tenant scoping through
// the actual mount, and persistence across a full server restart.
// prm_cfc51c53 v2.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "synthetic-restart-operator-token-34567"; // 37 chars, test-only

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    probe.on("error", reject);
  });
}

async function startServer(extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
    env: { ...process.env, NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error("server exited early: " + code)));
    setTimeout(() => reject(new Error("server did not come up")), 10000);
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/order-config`);
        if (response.status === 200) { clearInterval(poll); resolve(); }
      } catch { /* not up yet */ }
    }, 150);
  });
  return { child, port };
}

const stop = ({ child }) => new Promise((resolve) => { child.on("exit", resolve); child.kill("SIGTERM"); });

async function call(port, method, url, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("server mount: dormant without token, operator-only with token, restart-durable", async () => {
  const drops = fs.mkdtempSync(path.join(os.tmpdir(), "rb-restart-"));
  const env = {
    GLOWHUM_DROPS_DIR: drops,
    DROP_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "rb-restart-drop-")),
    GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN: TOKEN,
  };

  // First: NO token configured — route must not even exist; public routes intact.
  const off = await startServer({ GLOWHUM_DROPS_DIR: drops, DROP_ROOT: env.DROP_ROOT });
  try {
    assert.equal((await call(off.port, "GET", "/internal/request-board/acme/requests", undefined, TOKEN)).status, 404, "dormant: no token -> not mounted");
    const operatorPage = await fetch(`http://127.0.0.1:${off.port}/operator/board`);
    assert.equal(operatorPage.status, 200, "operator console shell is served without exposing board data");
    const operatorHtml = await operatorPage.text();
    assert.match(operatorHtml, /Authorization: "Bearer " \+ a\.token/, "token is sent as a bearer header");
    assert.doesNotMatch(operatorHtml, /id="base"|localStorage|sessionStorage/, "console has no external API target or token persistence");
    assert.equal((await fetch(`http://127.0.0.1:${off.port}/api/order-config`)).status, 200, "public routes untouched");
  } finally { await stop(off); }

  // Second: token configured — full operator flow over real HTTP.
  let server = await startServer(env);
  let id;
  try {
    assert.equal((await call(server.port, "GET", "/internal/request-board/acme/requests")).status, 401, "no bearer -> 401");
    assert.equal((await call(server.port, "GET", "/internal/request-board/acme/requests", undefined, "wrong-token-" + "z".repeat(24))).status, 401, "wrong bearer -> 401");

    const created = await call(server.port, "POST", "/internal/request-board/acme/requests", { title: "Synthetic restart episode", increments: ["script", "cut"] }, TOKEN);
    assert.equal(created.status, 201);
    id = created.body.id;

    // tenant scoping through the real mount
    await call(server.port, "POST", "/internal/request-board/other-co/requests", { title: "other tenant", increments: ["x"] }, TOKEN);
    const other = await call(server.port, "GET", "/internal/request-board/other-co/requests", undefined, TOKEN);
    assert.deepEqual(other.body.requests.map((r) => r.title), ["other tenant"]);
    const acme = await call(server.port, "GET", "/internal/request-board/acme/requests", undefined, TOKEN);
    assert.deepEqual(acme.body.requests.map((r) => r.title), ["Synthetic restart episode"]);
  } finally { await stop(server); }

  // Third: fresh process, same storage — state must survive the restart.
  server = await startServer(env);
  try {
    assert.equal((await call(server.port, "GET", "/internal/request-board/acme/requests")).status, 401, "auth still required after restart");
    const list = await call(server.port, "GET", "/internal/request-board/acme/requests", undefined, TOKEN);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.requests.map((r) => r.id), [id], "board state survived a full server restart");
    const started = await call(server.port, "POST", `/internal/request-board/acme/requests/${id}/start`, {}, TOKEN);
    assert.equal(started.status, 200);
    assert.equal(started.body.state, "active", "operations continue after restart");
  } finally { await stop(server); }
});
