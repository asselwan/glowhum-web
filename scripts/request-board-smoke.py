#!/usr/bin/env python3
"""Page-interaction smoke for local/request-board.html — real Chromium via the
installed Playwright venv, plus a local static server for the repo root so the
page's ../request-board.js path serves exactly as in local review.
Local/review-only feature; prm_cfc51c53 v2."""
import http.server
import json
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + ((" — " + detail) if detail else ""))
    if not ok:
        globals()["_failed"] = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_address[1]}"
page_url = base + "/local/request-board.html"

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        executable_path="/home/ainur/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
        args=["--no-sandbox"])
    page = browser.new_page()
    page.goto(page_url)

    script = page.evaluate("fetch('../request-board.js').then(r => r.status)")
    check("local script path ../request-board.js serves 200", script == 200, f"status={script}")
    check("page loads with RequestBoard present", page.evaluate("typeof window.RequestBoard === 'object'"))

    malicious = '<img src=x onerror="window.__pwned=1">'
    page.fill("#title", malicious)
    page.fill("#incs", '<b>evil</b> cut, final "v1"')
    page.evaluate("document.getElementById('due').value = new Date(Date.now() + 86400000).toISOString().slice(0,10)")
    page.click("#add")
    check("malicious title does not execute as markup", page.evaluate("window.__pwned === 1") is False)
    dom = page.evaluate("document.getElementById('queued').innerHTML + document.getElementById('slot').innerHTML")
    check("malicious title is escaped in rendered DOM", "<img" not in dom)
    inc = page.text_content(".inc") or ""
    check("increment label is escaped and visible as text", "<b>evil</b> cut" in inc)
    check("due date collected and displayed", "due 2" in (page.text_content(".card") or ""))

    page.click("#queued .card button")  # Start
    check("queued request starts into the single slot", "active" in (page.text_content("#slot") or ""))
    page.evaluate("[...document.querySelectorAll('#slot .inc')].forEach(el => el.click())")
    page.evaluate("[...document.querySelectorAll('#slot button')].find(b => b.textContent === 'Deliver').click()")
    delivered_text = page.text_content("#delivered") or ""
    check("deliver after increments shows delivered + on time", "delivered" in delivered_text and "on time" in delivered_text)
    on_time = page.evaluate("(document.getElementById('metrics').innerHTML.match(/On time: <b>(\\d+)/) || [])[1]")
    check("on-time metric counts 1", on_time == "1", f"metric={on_time}")

    page.reload()
    persisted_html = page.evaluate("document.getElementById('delivered').innerHTML")
    check("board persists across reload via localStorage (escaped)",
          "<img" not in persisted_html and "&lt;img" in persisted_html and len(persisted_html) > 20)
    check("persisted title stays escaped after reload", "<img" not in (page.evaluate("document.getElementById('delivered').innerHTML")))

    page.evaluate("localStorage.setItem('glowhum-request-board-v1', '{corrupt')")
    page.reload()
    check("malformed stored state fails safe to a fresh board",
          "(none)" in (page.text_content("#queued") or "") and "(none)" in (page.text_content("#delivered") or ""))

    browser.close()

serve_static = (ROOT / "server.mjs").read_text()
block = serve_static.split("serveStatic")[1].split("\n}")[0]
check("production serveStatic whitelist never references local/ or request-board",
      "request-board" not in block and "local/" not in block)

server.shutdown()
failed = sum(1 for _, ok in results if not ok)
print(f"\nsmoke: {len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
