#!/usr/bin/env node
// Real-Chromium (raw CDP, no Playwright) browser proof for the Designjoy request board:
//  (1) local/request-board.html review demo behavior, (2) served /board + /operator/board
//  against a real server.mjs process incl. restart persistence, tenant isolation, operator auth.
// Synthetic fixtures only; no customer data, no network beyond 127.0.0.1.
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "synthetic-e2e-operator-token-4567890";
const A = "cs_test_e2e_ALPHA01", B = "cs_test_e2e_BRAVO02", LONG = "cs_test_" + "A1_".repeat(45);
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log((ok ? "PASS " : "FAIL ") + n + (d ? " — " + d : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function api(port, method, url, body, token) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return [r.status, await r.json().catch(() => null)];
}
async function startServer(drops) {
  const port = await freePort();
  const child = spawn("node", [path.join(ROOT, "server.mjs")], { env: { ...process.env, NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1", GLOWHUM_DROPS_DIR: drops, DROP_ROOT: mkdtempSync(path.join(tmpdir(), "rb-cdp-drop-")), GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN: TOKEN }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/order-config`)).status === 200) return { child, port }; } catch {} await sleep(150); }
  child.kill(); throw new Error("server did not start");
}
const stop = (c) => new Promise((r) => { c.once("exit", r); c.kill("SIGTERM"); });

// ---- Part 1: static local demo page (review only) ----
const staticSrv = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { const b = readFileSync(p); res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" }).end(b); } catch { res.writeHead(404).end(); }
});
await new Promise((r) => staticSrv.listen(0, "127.0.0.1", r));
const sbase = `http://127.0.0.1:${staticSrv.address().port}`;
const chrome = await launch();
try {
  const page = await chrome.newPage();
  await page.goto(sbase + "/local/request-board.html");
  check("local script path ../request-board.js serves 200", (await page.eval("fetch('../request-board.js').then(r=>r.status)")) === 200);
  check("page loads with RequestBoard present", await page.eval("typeof window.RequestBoard === 'object'"));
  await page.fill("#title", '<img src=x onerror="window.__pwned=1">');
  await page.fill("#incs", '<b>evil</b> cut, final "v1"');
  await page.eval("document.getElementById('due').value = new Date(Date.now()+86400000).toISOString().slice(0,10), true");
  await page.click("#add");
  check("malicious title does not execute as markup", (await page.eval("window.__pwned === 1")) === false);
  const dom = await page.eval("document.getElementById('queued').innerHTML + document.getElementById('slot').innerHTML");
  check("malicious title is escaped in rendered DOM", !dom.includes("<img"));
  check("increment label escaped and visible as text", (await page.text(".inc")).includes("<b>evil</b> cut"));
  check("due date collected and displayed", (await page.text(".card")).includes("due 2"));
  await page.click("#queued .card button");
  check("queued request starts into the single slot", (await page.text("#slot")).includes("active"));
  await page.eval("[...document.querySelectorAll('#slot .inc')].forEach(el=>el.click()), true");
  await page.eval("[...document.querySelectorAll('#slot button')].find(b=>b.textContent==='Deliver').click(), true");
  const del = await page.text("#delivered");
  check("deliver after increments shows delivered + on time", del.includes("delivered") && del.includes("on time"));
  const onTime = await page.eval("(document.getElementById('metrics').innerHTML.match(/On time: <b>(\\d+)/)||[])[1]");
  check("on-time metric counts 1", onTime === "1", "metric=" + onTime);
  await page.reload();
  const ph = await page.eval("document.getElementById('delivered').innerHTML");
  check("board persists across reload via localStorage (escaped)", !ph.includes("<img") && ph.includes("&lt;img") && ph.length > 20);
  await page.eval("localStorage.setItem('glowhum-request-board-v1','{corrupt'), true");
  await page.reload();
  check("malformed stored state fails safe to a fresh board", (await page.text("#queued")).includes("(none)") && (await page.text("#delivered")).includes("(none)"));
  await page.close();
} finally { staticSrv.close(); }
const srcServer = readFileSync(path.join(ROOT, "server.mjs"), "utf8");
const block = srcServer.split("serveStatic")[1].split("\n}")[0];
check("production serveStatic whitelist never references local/ or request-board", !block.includes("request-board") && !block.includes("local/"));

// ---- Part 2: served customer + operator flow against real server.mjs ----
const drops = mkdtempSync(path.join(tmpdir(), "rb-cdp-drops-"));
for (const o of [A, B, LONG]) { mkdirSync(path.join(drops, "drops", o), { recursive: true }); writeFileSync(path.join(drops, "drops", o, "receipt.json"), JSON.stringify({ order_id: o, status: "paid", created_at: "2026-10-18T00:00:00.000Z" })); }
let { child, port } = await startServer(drops);
const base = () => `http://127.0.0.1:${port}`;
try {
  const page = await chrome.newPage();
  await page.goto(`${base()}/board?order_id=${A}`);
  check("/board serves with brand text", (await page.text("h1")).includes("GLOWHUM"));
  await page.fill("#title", "Customer browser request"); await page.fill("#incs", "script, final cut"); await page.click("#add");
  await page.waitSel(".card");
  check("browser submission renders on the customer board", (await page.text("#board")).includes("Customer browser request"));
  let [st, bd] = await api(port, "GET", `/api/order/${A}/board`);
  check("submission persisted server-side", st === 200 && bd.requests.length === 1);
  [st, bd] = await api(port, "GET", `/api/order/${B}/board`);
  check("cross-customer isolation (API)", st === 200 && bd.requests.length === 0);
  [st] = await api(port, "POST", "/api/order/cs_test_e2e_UNKNOWN9/board/requests", { title: "x", increments: ["y"] });
  check("unauthenticated mutation rejected (unknown capability)", st === 404);
  [st] = await api(port, "GET", `/internal/request-board/${A}/requests`);
  check("operator route without bearer refused (401)", st === 401, "status=" + st);
  const op = await chrome.newPage();
  await op.goto(`${base()}/operator/board`);
  check("served operator page loads on the same app", (await op.text("h1")).includes("GLOWHUM"));
  check("operator shell shows no board data before token", (await op.text("#board")).includes("Customer browser request") === false);
  await op.fill("#token", TOKEN); await op.fill("#tenant", A); await op.click("#load");
  await op.waitSel(".card");
  check("operator page loads the customer board", (await op.text("#board")).includes("Customer browser request"));
  await op.click('[data-act="start"]');
  await op.waitFor("document.querySelector('.state')?.textContent === 'active'");
  const stored = await op.eval("JSON.stringify([localStorage, sessionStorage])");
  const url = await op.eval("location.href");
  check("operator action persists without storing token or putting it in URL", url.endsWith("/operator/board") && !stored.includes(TOKEN));
  await op.close();
  [st] = await api(port, "GET", `/internal/request-board/${A}/requests`, null, TOKEN);
  check("operator role sees the customer board", st === 200);
  [st] = await api(port, "GET", `/internal/request-board/${A}/requests`, null, "wrong-token-" + "q".repeat(20));
  check("operator routes refuse a wrong token", st === 401);
  const lc = await chrome.newPage();
  await lc.goto(`${base()}/board?order_id=${LONG}`);
  await lc.fill("#title", "Long capability request"); await lc.fill("#incs", "review"); await lc.click("#add"); await lc.waitSel(".card");
  const lo = await chrome.newPage();
  await lo.goto(`${base()}/operator/board`);
  await lo.fill("#token", TOKEN); await lo.fill("#tenant", LONG); await lo.click("#load"); await lo.waitSel(".card");
  check("long Stripe capability round-trips customer->operator", (await lo.text("#board")).includes("Long capability request"));
  await lo.close(); await lc.close(); await page.close();
} finally { await stop(child); }

({ child, port } = await startServer(drops));
try {
  const page = await chrome.newPage();
  await page.goto(`${base()}/board?order_id=${A}`);
  await page.waitSel(".card");
  const t = await page.text("#board");
  check("after full process restart the customer re-reads the persisted request", t.includes("Customer browser request"));
  check("post-restart state shows operator's start", t.includes("active"));
  await page.goto(`${base()}/board?order_id=cs_test_e2e_UNKNOWN9`);
  await sleep(500);
  check("invalid capability shows an error, not data", (await page.text("#status")).includes("not valid") && !(await page.text("#board")).includes("Customer browser request"));
  await page.close();
} finally { await stop(child); await chrome.close(); }
console.log(`\ncdp-smoke: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
