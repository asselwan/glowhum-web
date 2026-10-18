// Focused tests for customer-capability and operator-token board routes.
// Synthetic fixtures only (temp storage root, fake req/res). prm_cfc51c53 v2.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { requestBoardRoutes, customerBoardRoutes } from "../request-board-routes.mjs";

const TOKEN = "x".repeat(40); // synthetic, >= 32 chars
let storageRoot;
test.before(async () => {
  storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rb-routes-"));
  process.env.GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN = TOKEN;
});
test.after(() => { delete process.env.GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN; });

function fakeReq(method, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.headers = { authorization: `Bearer ${TOKEN}`, ...headers };
  return req;
}
async function call(method, url, body, headers) {
  const res = { statusCode: 0, body: "" };
  res.writeHead = (code) => { res.statusCode = code; return res; };
  res.end = (payload) => { res.body = payload ? JSON.parse(payload) : null; return res; };
  const handled = await requestBoardRoutes(fakeReq(method, body, headers), res, url, storageRoot);
  return { handled, status: res.statusCode, body: res.body };
}

test("route is dormant (returns false) when no operator token is configured", async () => {
  const saved = process.env.GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN;
  delete process.env.GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN;
  const r = await call("GET", "/internal/request-board/acme/requests", undefined);
  process.env.GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN = saved;
  assert.equal(r.handled, false);
});

test("every request requires the operator bearer token", async () => {
  for (const headers of [{ authorization: "" }, { authorization: "Bearer " + "y".repeat(40) }, { authorization: "Bearer " + TOKEN.slice(0, 39) }, { authorization: "Bearer " + "é".repeat(40) }]) {
    const r = await call("GET", "/internal/request-board/acme/requests", undefined, headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
  }
});

test("unrelated paths are not handled", async () => {
  assert.equal((await call("GET", "/api/order/cs_x")).handled, false);
  assert.equal((await call("GET", "/")).handled, false);
});

test("create -> start -> toggle -> deliver persists durably per tenant", async () => {
  let r = await call("POST", "/internal/request-board/acme/requests", { title: "Episode A", increments: ["script", "cut"], due_at: Date.now() + 5 * 86400000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.state, "queued");
  assert.ok(r.body.due_at > Date.now());
  const id = r.body.id;

  r = await call("POST", `/internal/request-board/acme/requests/${id}/start`);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "active");

  // deliver is blocked until every increment is done
  r = await call("POST", `/internal/request-board/acme/requests/${id}/deliver`);
  assert.equal(r.status, 400);

  for (let i = 0; i < 2; i++) {
    r = await call("POST", `/internal/request-board/acme/requests/${id}/toggle`, { index: i });
    assert.equal(r.status, 200);
  }
  r = await call("POST", `/internal/request-board/acme/requests/${id}/deliver`);
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "delivered");

  // durable: a fresh GET sees the same delivered request
  r = await call("GET", "/internal/request-board/acme/requests");
  assert.equal(r.status, 200);
  assert.equal(r.body.requests.length, 1);
  assert.equal(r.body.requests[0].state, "delivered");
});

test("tenant isolation: one tenant never sees another tenant's requests", async () => {
  await call("POST", "/internal/request-board/acme/requests", { title: "acme only", increments: ["x"] });
  const other = await call("GET", "/internal/request-board/contoso/requests");
  assert.equal(other.status, 200);
  assert.equal(other.body.requests.length, 0);
  assert.ok(!JSON.stringify(other.body).includes("acme only"));
  // cross-tenant request id is unknown in the other tenant
  const acme = await call("GET", "/internal/request-board/acme/requests");
  const id = acme.body.requests[0].id;
  const cross = await call("POST", `/internal/request-board/contoso/requests/${id}/start`);
  assert.equal(cross.status, 404);
});

test("one active slot per tenant is enforced server-side", async () => {
  await call("POST", "/internal/request-board/slotco/requests", { title: "first", increments: ["x"] });
  await call("POST", "/internal/request-board/slotco/requests", { title: "second", increments: ["x"] });
  const list = (await call("GET", "/internal/request-board/slotco/requests")).body.requests;
  const [a, b] = list;
  assert.equal((await call("POST", `/internal/request-board/slotco/requests/${a.id}/start`)).status, 200);
  const busy = await call("POST", `/internal/request-board/slotco/requests/${b.id}/start`);
  assert.equal(busy.status, 400);
  assert.match(busy.body.error, /slot busy/);
});

test("due date is validated on create", async () => {
  const past = await call("POST", "/internal/request-board/duedco/requests", { title: "T", increments: ["x"], due_at: Date.now() - 1000 });
  assert.equal(past.status, 400);
  assert.match(past.body.error, /after the request was created/);
  const garbage = await call("POST", "/internal/request-board/duedco/requests", { title: "T", increments: ["x"], due_at: "next tuesday" });
  assert.equal(garbage.status, 400);
});

test("invalid input is rejected", async () => {
  assert.equal((await call("POST", "/internal/request-board/vcoco/requests", { title: "  ", increments: ["x"] })).status, 400);
  assert.equal((await call("POST", "/internal/request-board/vcoco/requests", { title: "T", increments: [] })).status, 400);
  assert.equal((await call("POST", "/internal/request-board/vcoco/requests", "not-json" === true ? {} : { no: 1 })).status, 400);
  const badTenant = await call("POST", "/internal/request-board/BAD/requests", { title: "T", increments: ["x"] });
  assert.ok(badTenant.status === 404 || badTenant.handled === false, "invalid tenant never reaches the board");
  assert.equal((await call("POST", "/internal/request-board/vcoco/requests/r1-abc/explode")).status, 404);
});

test("corrupt stored board surfaces 503, never a silent reset", async () => {
  await fs.mkdir(storageRoot, { recursive: true });
  await fs.writeFile(path.join(storageRoot, "corruptco.json"), "{corrupt", "utf8");
  const r = await call("GET", "/internal/request-board/corruptco/requests");
  assert.equal(r.status, 503);
  assert.match(r.body.error, /corrupt/i);
});

// --- customer capability-scoped routes ---

const ORDERS = new Set(["cs_test_order_ONE111", "cs_test_order_TWO222"]);
const orderExists = async (id) => ORDERS.has(id);
async function cust(method, url, body) {
  const res = { statusCode: 0, body: "" };
  res.writeHead = (code) => { res.statusCode = code; return res; };
  res.end = (payload) => { res.body = payload ? JSON.parse(payload) : null; return res; };
  const handled = await customerBoardRoutes(fakeReq(method, body), res, url, storageRoot, orderExists);
  return { handled, status: res.statusCode, body: res.body };
}

test("customer routes: unknown/invalid order capability is rejected", async () => {
  assert.equal((await cust("GET", "/api/order/cs_test_order_NOPE333/board")).status, 404);
  assert.equal((await cust("POST", "/api/order/cs_test_order_NOPE333/board/requests", { title: "T", increments: ["x"] })).status, 404);
  assert.equal((await cust("GET", "/api/order/not-a-capability/board")).handled, false);
});

test("customer routes: submission persists to that order's board only", async () => {
  const r = await cust("POST", "/api/order/cs_test_order_ONE111/board/requests", { title: "customer one request", increments: ["script", "cut"] });
  assert.equal(r.status, 201);
  const mine = await cust("GET", "/api/order/cs_test_order_ONE111/board");
  assert.deepEqual(mine.body.requests.map((x) => x.title), ["customer one request"]);
  const other = await cust("GET", "/api/order/cs_test_order_TWO222/board");
  assert.equal(other.status, 200);
  assert.equal(other.body.requests.length, 0, "no shared queue: other order sees nothing");
});

test("customer routes cannot advance board state (operator-only actions)", async () => {
  const mine = await cust("GET", "/api/order/cs_test_order_ONE111/board");
  const id = mine.body.requests[0].id;
  const attempt = await cust("POST", `/api/order/cs_test_order_ONE111/board/requests/${id}/start`, {});
  assert.ok(attempt.handled === false || attempt.status === 404, "action paths are never routed for customers (falls to the /api 404)");
});

test("role separation: operator can act, customer token-less mount stays read/create", async () => {
  const mine = await cust("GET", "/api/order/cs_test_order_ONE111/board");
  const id = mine.body.requests[0].id;
  const op = await call("POST", `/internal/request-board/cs_test_order_ONE111/requests/${id}/start`);
  assert.equal(op.status, 200, "operator advances the customer's request through the gated mount");
  const after = await cust("GET", "/api/order/cs_test_order_ONE111/board");
  assert.equal(after.body.requests[0].state, "active", "customer sees the operator's transition");
});

test("long Stripe capability IDs round-trip through customer and operator board routes", async () => {
  const orderId = `cs_test_${"A1_".repeat(45)}`;
  ORDERS.add(orderId);
  const created = await cust("POST", `/api/order/${orderId}/board/requests`, { title: "long id customer request", increments: ["review"] });
  assert.equal(created.status, 201);
  const listed = await call("GET", `/internal/request-board/${orderId}/requests`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.requests[0].title, "long id customer request");
  const start = await call("POST", `/internal/request-board/${orderId}/requests/${created.body.id}/start`);
  assert.equal(start.status, 200);
  assert.equal((await cust("GET", `/api/order/${orderId}/board`)).body.requests[0].state, "active");
});

test("WIP limit 1 holds under concurrent start submissions", async () => {
  await call("POST", "/internal/request-board/raceco/requests", { title: "a", increments: ["x"] });
  await call("POST", "/internal/request-board/raceco/requests", { title: "b", increments: ["x"] });
  const list = (await call("GET", "/internal/request-board/raceco/requests")).body.requests;
  const [x, y] = list;
  const both = await Promise.all([
    call("POST", `/internal/request-board/raceco/requests/${x.id}/start`),
    call("POST", `/internal/request-board/raceco/requests/${y.id}/start`),
  ]);
  const ok = both.filter((r) => r.status === 200);
  const refused = both.filter((r) => r.status === 400);
  assert.equal(ok.length, 1, "exactly one start wins");
  assert.equal(refused.length, 1, "the loser gets slot-busy");
  assert.match(refused[0].body.error, /slot busy/);
});
