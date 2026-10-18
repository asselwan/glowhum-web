// Request Board — local/review-only replication of the Designjoy-documented client
// request-board mechanism (one active request at a time, larger requests delivered in
// increments, queued/active/revision/delivered states). Source of the mechanism:
// .ainur/SPOLIA/companies/designjoy.md (official designjoy.co site copy, DISCOVERY_ONLY).
// Not linked from any production page; no publish/deploy. prm_cfc51c53 v2.

(function (global) {
  "use strict";

  const STATES = ["queued", "active", "revision", "delivered"];

  function createBoard(now) {
    return { requests: [], now: now || null };
  }

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  // All user-entered text (titles, increment labels, notes) MUST go through this
  // before being placed in innerHTML markup.
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
  }

  function slotHolders(board) {
    return board.requests.filter((r) => r.state === "active" || r.state === "revision");
  }

  // WIP limit 1: at most one request may be active or in revision at a time.
  function enqueue(board, title, increments, now) {
    if (!title || !title.trim()) throw new Error("title required");
    if (!Array.isArray(increments) || increments.length === 0)
      throw new Error("at least one delivery increment required");
    const req = {
      id: "r" + (board.requests.length + 1) + "-" + Math.random().toString(36).slice(2, 8),
      title: title.trim(),
      state: "queued",
      createdAt: now,
      dueAt: null,
      deliveredAt: null,
      increments: increments.map((label) => ({ label: String(label), done: false })),
    };
    board.requests.push(req);
    return req;
  }

  function start(board, id) {
    const held = slotHolders(board);
    if (held.length > 0)
      throw new Error("slot busy: " + held[0].title + " is " + held[0].state);
    const req = board.requests.find((r) => r.id === id && r.state === "queued");
    if (!req) throw new Error("no queued request " + id);
    req.state = "active";
    return req;
  }

  function toggleIncrement(board, id, index) {
    const req = board.requests.find((r) => r.id === id);
    if (!req || !req.increments[index]) throw new Error("bad increment");
    if (req.state !== "active" && req.state !== "revision")
      throw new Error("increments only advance while the request holds the slot");
    req.increments[index].done = !req.increments[index].done;
    return req;
  }

  function requestRevision(board, id, note) {
    const req = board.requests.find((r) => r.id === id && r.state === "active");
    if (!req) throw new Error("no active request " + id);
    req.state = "revision";
    if (note) req.revisionNote = String(note);
    return req;
  }

  function deliver(board, id, now) {
    const req = board.requests.find((r) => r.id === id);
    if (!req || (req.state !== "active" && req.state !== "revision"))
      throw new Error("request is not in the slot: " + id);
    if (req.increments.some((inc) => !inc.done))
      throw new Error("cannot deliver: unfinished increments");
    req.state = "delivered";
    req.deliveredAt = now;
    return req;
  }

  // Due dates: collect one per request, validate it is a real, future-pointing
  // timestamp relative to creation — otherwise the on-time metric is unfalsifiable.
  function setDue(board, id, dueAt, now) {
    const req = board.requests.find((r) => r.id === id);
    if (!req) throw new Error("no request " + id);
    const t = dueAt instanceof Date ? dueAt.getTime() : Number(dueAt);
    if (!Number.isFinite(t)) throw new Error("due date is not a valid date");
    const reference = req.createdAt != null ? req.createdAt : now;
    if (reference != null && t <= reference) throw new Error("due date must be after the request was created");
    req.dueAt = t;
    return req;
  }

  function ageDays(req, now) {
    if (req.createdAt == null || now == null) return null;
    return Math.max(0, ((now - req.createdAt) / 86400000));
  }

  // Watched numbers from the steal list: queue age, on-time delivery, active requests
  // per operator.
  function metrics(board, now) {
    const queued = board.requests.filter((r) => r.state === "queued");
    const delivered = board.requests.filter((r) => r.state === "delivered");
    const onTime = delivered.filter((r) => r.dueAt != null && r.deliveredAt <= r.dueAt);
    return {
      queueDepth: queued.length,
      oldestQueueAgeDays: queued.length
        ? Math.max(...queued.map((r) => ageDays(r, now) || 0))
        : 0,
      deliveredCount: delivered.length,
      onTimeCount: onTime.length,
      activeRequestsPerOperator: slotHolders(board).length,
    };
  }

  // Persistence: serialize to a JSON string for localStorage; restore returns a
  // valid board or null on ANY malformed input (callers fall back to a fresh board).
  const STORAGE_VERSION = 1;

  function serialize(board) {
    return JSON.stringify({ version: STORAGE_VERSION, requests: board.requests });
  }

  function validRequest(r) {
    return (
      r && typeof r === "object" && typeof r.id === "string" && r.id &&
      typeof r.title === "string" && r.title.trim() &&
      STATES.includes(r.state) &&
      Array.isArray(r.increments) &&
      r.increments.every((inc) => inc && typeof inc === "object" && typeof inc.label === "string" && typeof inc.done === "boolean") &&
      (r.createdAt == null || Number.isFinite(r.createdAt)) &&
      (r.dueAt == null || Number.isFinite(r.dueAt)) &&
      (r.deliveredAt == null || Number.isFinite(r.deliveredAt))
    );
  }

  function restore(text) {
    let parsed;
    try {
      parsed = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.requests))
      return null;
    if (!parsed.requests.every(validRequest)) return null;
    return { requests: parsed.requests.map((r) => structuredClone(r)), now: null };
  }

  const api = { STATES, createBoard, enqueue, start, toggleIncrement, requestRevision, deliver, metrics, ageDays, escapeHtml, setDue, serialize, restore, STORAGE_VERSION };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.RequestBoard = api;
})(typeof window !== "undefined" ? window : globalThis);
