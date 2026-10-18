// Server-backed request board. Customer routes are capability-scoped; operator
// mutations and cross-customer reads require the configured bearer token.
//
// Why this shape: glowhum-web has per-customer capability auth (unguessable
// Stripe cs_ / drop IDs) but NO operator authorization model. A Designjoy-style
// client-visible board needs operator-shared durable requests across customers,
// which is exactly a cross-tenant operator read — the API mount remains
// disabled until an operator token (>= 32 chars) is configured.
// The served operator page contains no board data until authenticated API calls.
// prm_cfc51c53 v2.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Board = require("./request-board.js");

const TENANT = /^(?:[A-Za-z0-9][A-Za-z0-9_-]{3,79}|cs_[A-Za-z0-9_]{1,252})$/;
const REQUEST_ID = /^r\d+-[a-z0-9]{2,12}$/;

// Per-tenant async mutex: serializes load -> mutate -> save inside this process so
// two concurrent "start" submissions cannot both see an empty slot (WIP limit 1).
// The server is a single zero-dependency Node process by design; cross-process
// mutation is not a supported topology.
const tenantLocks = new Map();
function withTenantLock(tenant, task) {
  const run = tenantLocks.get(tenant) || Promise.resolve();
  const next = run.then(task, task);
  tenantLocks.set(tenant, next.catch(() => {}));
  return next;
}

export function operatorToken() {
  return process.env.GLOWHUM_REQUEST_BOARD_OPERATOR_TOKEN || "";
}

function bearerMatch(req) {
  const expected = operatorToken();
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length >= 32
    && suppliedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

function boardFile(storageRoot, tenant) {
  return path.join(storageRoot, `${tenant}.json`);
}

async function loadBoard(storageRoot, tenant) {
  let text;
  try {
    text = await fs.readFile(boardFile(storageRoot, tenant), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return Board.createBoard();
    throw error;
  }
  // Fail-safe on the server side is the OPPOSITE of the browser: operator data
  // must never be silently reset — corruption is surfaced, not discarded.
  const board = Board.restore(text);
  if (!board) { const e = new Error("board state corrupt"); e.code = "BOARD_CORRUPT"; throw e; }
  return board;
}

async function saveBoard(storageRoot, tenant, board) {
  const file = boardFile(storageRoot, tenant);
  const temporary = `${file}.${crypto.randomBytes(12).toString("hex")}.tmp`;
  await fs.mkdir(storageRoot, { recursive: true });
  await fs.writeFile(temporary, `${Board.serialize(board)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function publicRequest(r) {
  return { id: r.id, title: r.title, state: r.state, created_at: r.createdAt, due_at: r.dueAt, delivered_at: r.deliveredAt, increments: r.increments };
}

function sendJson(res, status, object) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(object));
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Shared board handler. Operators get full action rights via the token-gated
// mount; customers get read + create only, scoped to their own order capability
// (an unguessable Stripe `cs_` id that must match a stored paid receipt — the
// same possession-auth /api/order/:id already uses).
async function handleBoard(req, res, storageRoot, tenant, requestId, action, role) {
  try {
    if (req.method === "POST" && !requestId && !action) {
      const body = await readJsonBody(req);
      return await withTenantLock(tenant, async () => {
        const board = await loadBoard(storageRoot, tenant);
        const request = Board.enqueue(board, String(body.title || ""), Array.isArray(body.increments) ? body.increments : [], Date.now());
        if (body.due_at != null) Board.setDue(board, request.id, Number(body.due_at), Date.now());
        await saveBoard(storageRoot, tenant, board);
        sendJson(res, 201, publicRequest(request));
      });
    }
    if (req.method === "GET" && !requestId && !action) {
      const board = await loadBoard(storageRoot, tenant);
      return sendJson(res, 200, { tenant, requests: board.requests.map(publicRequest) });
    }
    if (req.method === "POST" && requestId && action) {
      if (role !== "operator") { sendJson(res, 403, { error: "Only operators may advance board state" }); return; }
      const body = action === "toggle" ? await readJsonBody(req) : {};
      return await withTenantLock(tenant, async () => {
        const board = await loadBoard(storageRoot, tenant);
        const request = board.requests.find((r) => r.id === requestId);
        if (!request || !REQUEST_ID.test(request.id)) { sendJson(res, 404, { error: "Not found" }); return; }
        if (action === "start") Board.start(board, requestId);
        else if (action === "deliver") Board.deliver(board, requestId, Date.now());
        else if (action === "revision") Board.requestRevision(board, requestId, "operator feedback");
        else if (action === "toggle") Board.toggleIncrement(board, requestId, Number(body.index));
        else { sendJson(res, 404, { error: "Not found" }); return; }
        await saveBoard(storageRoot, tenant, board);
        sendJson(res, 200, publicRequest(request));
      });
    }
  } catch (error) {
    if (error.code === "BOARD_CORRUPT") { sendJson(res, 503, { error: "Board state is corrupt and needs operator attention" }); return; }
    if (error instanceof SyntaxError || /required|valid date|slot busy|not in the slot|bad increment|unfinished|after the request/.test(error.message)) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    sendJson(res, 500, { error: "Could not operate board" });
    return;
  }
  sendJson(res, 404, { error: "Not found" });
}

// Operator routes (dormant unless a token >= 32 chars is configured):
//   POST  /internal/request-board/:tenant/requests              {title, increments, due_at?}
//   GET   /internal/request-board/:tenant/requests
//   POST  /internal/request-board/:tenant/requests/:id/:action  start|deliver|toggle|revision
export async function requestBoardRoutes(req, res, pathname, storageRoot) {
  if (operatorToken().length < 32) return false; // dormant unless explicitly configured
  const match = pathname.match(/^\/internal\/request-board\/([A-Za-z0-9_-]+)(\/requests(\/([^/]+)(\/([a-z]+))?)?)?$/);
  if (!match) return false;
  const [, tenant, , , requestId, , action] = match;
  if (!TENANT.test(tenant)) { sendJson(res, 404, { error: "Not found" }); return true; }
  if (!bearerMatch(req)) { sendJson(res, 401, { error: "Operator token required" }); return true; }
  await handleBoard(req, res, storageRoot, tenant, requestId, action, "operator");
  return true;
}

// Customer routes — capability-scoped, always available like /api/order/:id:
//   GET   /api/order/:order_id/board        (view own board)
//   POST  /api/order/:order_id/board/requests  (submit a request)
// `orderExists` (supplied by server.mjs) validates the cs_ id against a stored
// receipt — the exact possession-auth the order status route already relies on.
// No shared queue: every id reads and writes only its own board file.
export async function customerBoardRoutes(req, res, pathname, storageRoot, orderExists) {
  const match = pathname.match(/^\/api\/order\/(cs_[A-Za-z0-9_]{1,252})\/board(\/requests)?$/);
  if (!match) return false;
  const [, orderId, requestsPart] = match;
  let valid = false;
  try { valid = await orderExists(orderId); } catch { valid = false; }
  if (!valid) { sendJson(res, 404, { error: "Not found" }); return true; }
  if (req.method === "GET" && !requestsPart) await handleBoard(req, res, storageRoot, orderId, null, null, "customer");
  else if (req.method === "POST" && requestsPart) await handleBoard(req, res, storageRoot, orderId, null, null, "customer");
  else if (req.method === "GET" && requestsPart) { sendJson(res, 405, { error: "Method not allowed" }); }
  else sendJson(res, 404, { error: "Not found" });
  return true;
}
