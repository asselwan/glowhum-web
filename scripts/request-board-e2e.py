#!/usr/bin/env python3
"""End-to-end browser test: real server.mjs process + real Chromium (installed
Playwright) driving the served /board page — submission -> server persistence ->
full process restart -> customer re-read, cross-customer isolation, unauthenticated
mutation rejection, and operator role separation. Synthetic fixtures only.
prm_cfc51c53 v2."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKEN = "synthetic-e2e-operator-token-4567890"
ORDER_A = "cs_test_e2e_ALPHA01"
ORDER_B = "cs_test_e2e_BRAVO02"
ORDER_LONG = "cs_test_" + "A1_" * 45
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + ((" — " + detail) if detail else ""))
    if not ok:
        globals()["_failed"] = True


def start_server(drops):
    port = free_port()
    env = {**os.environ, "NODE_ENV": "test", "PORT": str(port), "HOST": "127.0.0.1",
           "GLOWHUM_DROPS_DIR": drops, "DROP_ROOT": tempfile.mkdtemp(prefix="rb-e2e-drop-"),
           "GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN": TOKEN}
    child = subprocess.Popen(["node", str(ROOT / "server.mjs")], env=env,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/order-config", timeout=1) as r:
                if r.status == 200:
                    return child, port
        except Exception:
            time.sleep(0.15)
    child.kill()
    raise RuntimeError("server did not come up")


def free_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def api(port, method, url, body=None, token=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{url}", method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        data = json.dumps(body).encode()
    else:
        data = None
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, data, timeout=5) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


drops = tempfile.mkdtemp(prefix="rb-e2e-drops-")
os.makedirs(pathlib.Path(drops, "drops", ORDER_A), exist_ok=True)
os.makedirs(pathlib.Path(drops, "drops", ORDER_B), exist_ok=True)
os.makedirs(pathlib.Path(drops, "drops", ORDER_LONG), exist_ok=True)
for order in (ORDER_A, ORDER_B, ORDER_LONG):  # synthetic paid receipts = the capability
    pathlib.Path(drops, "drops", order, "receipt.json").write_text(json.dumps({
        "order_id": order, "status": "paid", "created_at": "2026-10-18T00:00:00.000Z"}))

child, port = start_server(drops)
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/home/ainur/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
            args=["--no-sandbox"])
        page = browser.new_page()
        page.goto(f"http://127.0.0.1:{port}/board?order_id={ORDER_A}")

        check("/board serves with brand text", "GLOWHUM" in (page.text_content("h1") or ""))

        page.fill("#title", "Customer browser request")
        page.fill("#incs", "script, final cut")
        page.click("#add")
        page.wait_for_selector(".card")
        check("browser submission renders on the customer board", "Customer browser request" in (page.text_content("#board") or ""))

        status, board = api(port, "GET", f"/api/order/{ORDER_A}/board")
        check("submission persisted server-side", status == 200 and len(board["requests"]) == 1)

        status, other = api(port, "GET", f"/api/order/{ORDER_B}/board")
        check("cross-customer isolation (API)", status == 200 and other["requests"] == [])

        status, bad = api(port, "POST", f"/api/order/cs_test_e2e_UNKNOWN9/board/requests", {"title": "x", "increments": ["y"]})
        check("unauthenticated mutation rejected (unknown capability)", status == 404)

        operator = browser.new_page()
        operator.goto(f"http://127.0.0.1:{port}/operator/board")
        check("served operator page loads on the same app", "GLOWHUM" in (operator.text_content("h1") or ""))
        operator.fill("#token", TOKEN)
        operator.fill("#tenant", ORDER_A)
        operator.click("#load")
        operator.wait_for_selector(".card")
        check("operator page loads the customer board", "Customer browser request" in (operator.text_content("#board") or ""))
        operator.locator('[data-act="start"]').click()
        operator.wait_for_function("document.querySelector('.state')?.textContent === 'active'")
        stored_token = operator.evaluate("JSON.stringify([localStorage, sessionStorage])")
        check("operator action persists without storing token or putting it in URL",
              operator.url.endswith("/operator/board") and TOKEN not in stored_token)
        operator.close()
        status, _ = api(port, "GET", f"/internal/request-board/{ORDER_A}/requests", token=TOKEN)
        check("operator role sees the customer board", status == 200)
        status, _ = api(port, "GET", f"/internal/request-board/{ORDER_A}/requests", token="wrong-token-" + "q" * 20)
        check("operator routes refuse a wrong token", status == 401)

        long_customer = browser.new_page()
        long_customer.goto(f"http://127.0.0.1:{port}/board?order_id={ORDER_LONG}")
        long_customer.fill("#title", "Long capability request")
        long_customer.fill("#incs", "review")
        long_customer.click("#add")
        long_customer.wait_for_selector(".card")
        long_operator = browser.new_page()
        long_operator.goto(f"http://127.0.0.1:{port}/operator/board")
        long_operator.fill("#token", TOKEN)
        long_operator.fill("#tenant", ORDER_LONG)
        long_operator.click("#load")
        long_operator.wait_for_selector(".card")
        check("long Stripe capability round-trips from customer submission to operator view",
              "Long capability request" in (long_operator.text_content("#board") or ""))
        long_operator.close()
        long_customer.close()

        browser.close()
finally:
    child.terminate()
    child.wait(timeout=10)

# Full process restart, fresh browser context: the customer re-reads the same board.
child, port = start_server(drops)
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/home/ainur/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
            args=["--no-sandbox"])
        page = browser.new_page()
        page.goto(f"http://127.0.0.1:{port}/board?order_id={ORDER_A}")
        page.wait_for_selector(".card")
        text = page.text_content("#board") or ""
        check("after restart the customer re-reads the persisted request", "Customer browser request" in text)
        check("post-restart state shows operator's start", "active" in text)
        page.goto(f"http://127.0.0.1:{port}/board?order_id=cs_test_e2e_UNKNOWN9")
        page.wait_for_timeout(400)
        check("invalid capability shows an error, not data", "not valid" in (page.text_content("#status") or ""))
        browser.close()
finally:
    child.terminate()
    child.wait(timeout=10)

failed = results.count(False)
print(f"\ne2e: {len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
