// Dependency-free Chrome DevTools Protocol client (Node >=22 global WebSocket).
// Replaces the missing Python Playwright venv for the request-board browser proof.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME = process.env.CHROME_BIN || "/home/ainur/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const dir = mkdtempSync(path.join(tmpdir(), "cdp-profile-"));
  const proc = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0",
    `--user-data-dir=${dir}`, "about:blank"], { stdio: "ignore" });
  const f = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(f); i++) await sleep(100);
  if (!existsSync(f)) { proc.kill(); throw new Error("chrome did not expose DevToolsActivePort"); }
  const [port, wsPath] = readFileSync(f, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, (d) => d.error ? rej(new Error(method + ": " + d.error.message)) : res(d.result));
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
  async function newPage() {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s("Page.enable");
    const page = {
      async eval(expr) {
        const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
      },
      async goto(url) {
        await s("Page.navigate", { url });
        for (let i = 0; i < 100; i++) { await sleep(100); try { if (await page.eval("document.readyState") === "complete" && (await page.eval("location.href")) !== "about:blank") return; } catch {} }
        throw new Error("navigation timeout " + url);
      },
      reload: async () => { await s("Page.reload"); await sleep(300); for (let i = 0; i < 100; i++) { try { if (await page.eval("document.readyState") === "complete") return; } catch {} await sleep(100); } },
      fill: (sel, v) => page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.focus();e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`),
      click: (sel) => page.eval(`document.querySelector(${JSON.stringify(sel)}).click(), true`),
      text: (sel) => page.eval(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`),
      async waitFor(expr, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await page.eval(expr)) return true; } catch {} await sleep(100); } throw new Error("waitFor timeout: " + expr); },
      waitSel: (sel) => page.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`),
      close: () => send("Target.closeTarget", { targetId }),
    };
    return page;
  }
  return { newPage, close: async () => { try { await send("Browser.close"); } catch {} proc.kill(); } };
}
