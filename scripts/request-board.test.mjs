// Focused test for the Designjoy-documented request-board mechanism (WIP limit 1,
// increment-gated delivery, revision state, watched-number metrics).
// prm_cfc51c53 v2 — local/review-only feature, not wired to production routes.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const B = require("../request-board.js");

const D = 86400000;

test("WIP limit 1: second start is refused while a request holds the slot", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "Episode A", ["script", "cut"], 0);
  const c = B.enqueue(b, "Episode B", ["cut"], 0);
  B.start(b, a.id);
  assert.throws(() => B.start(b, c.id), /slot busy: Episode A is active/);
  assert.equal(B.metrics(b).activeRequestsPerOperator, 1);
});

test("revision still occupies the single slot", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "Episode A", ["script"], 0);
  const c = B.enqueue(b, "Episode B", ["cut"], 0);
  B.start(b, a.id);
  B.requestRevision(b, a.id, "voiceover too fast");
  assert.throws(() => B.start(b, c.id), /slot busy: Episode A is revision/);
  assert.equal(B.metrics(b).activeRequestsPerOperator, 1);
});

test("delivery is blocked until every increment is done", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "Episode A", ["script", "long-form cut", "3 verticals"], 0);
  B.start(b, a.id);
  assert.throws(() => B.deliver(b, a.id, D), /unfinished increments/);
  B.toggleIncrement(b, a.id, 0);
  B.toggleIncrement(b, a.id, 1);
  assert.throws(() => B.deliver(b, a.id, D), /unfinished increments/);
  B.toggleIncrement(b, a.id, 2);
  B.deliver(b, a.id, D);
  assert.equal(a.state, "delivered");
});

test("increment toggling is refused outside the slot", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "Episode A", ["script"], 0);
  assert.throws(() => B.toggleIncrement(b, a.id, 0), /only advance while the request holds the slot/);
});

test("slot frees after delivery; next queued request can start", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "A", ["x"], 0);
  const c = B.enqueue(b, "C", ["y"], 0);
  B.start(b, a.id);
  B.toggleIncrement(b, a.id, 0);
  B.deliver(b, a.id, D);
  B.start(b, c.id);
  assert.equal(c.state, "active");
});

test("watched numbers: queue age, on-time delivery, active per operator", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "A", ["x"], 0);
  a.dueAt = 2 * D;
  const late = B.enqueue(b, "late", ["x"], 0);
  late.dueAt = D;
  const q = B.enqueue(b, "still queued", ["x"], 3 * D);
  B.start(b, a.id); B.toggleIncrement(b, a.id, 0); B.deliver(b, a.id, D);        // on time
  B.start(b, late.id); B.toggleIncrement(b, late.id, 0); B.deliver(b, late.id, 2 * D); // late
  const m = B.metrics(b, 4 * D);
  assert.equal(m.queueDepth, 1);
  assert.equal(m.oldestQueueAgeDays, 1); // queued at 3D, measured at 4D
  assert.equal(m.deliveredCount, 2);
  assert.equal(m.onTimeCount, 1);
  assert.equal(m.activeRequestsPerOperator, 0);
});

test("enqueue validates title and increments", () => {
  const b = B.createBoard();
  assert.throws(() => B.enqueue(b, "  ", ["x"], 0), /title required/);
  assert.throws(() => B.enqueue(b, "T", [], 0), /at least one delivery increment/);
});

// --- prm_cfc51c53 v2 additions: escaping, persistence, due dates ---

test("escapeHtml neutralizes markup in titles and increment labels", () => {
  const payload = '<img src=x onerror=alert(1)>"\'&<script>';
  const out = B.escapeHtml(payload);
  assert.ok(!out.includes("<img"), "img tag survived");
  assert.ok(!out.includes("<script"), "script tag survived");
  assert.equal(out, "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;&lt;script&gt;");
});

test("escapeHtml never emits raw < > & \" ' from any string input", () => {
  const out = B.escapeHtml("a<b>c&d\"e'f");
  for (const ch of ["<", ">", '"', "'"]) assert.ok(!out.includes(ch), ch + " leaked");
  assert.equal(out.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, ""), "abcdef"); // & appears only as entities
});

test("serialize/restore round-trips a board losslessly", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "Episode <A>", ["script", "cut"], 0);
  B.setDue(b, a.id, 5 * D, 0);
  B.start(b, a.id); B.toggleIncrement(b, a.id, 0); B.toggleIncrement(b, a.id, 1);
  B.deliver(b, a.id, 3 * D);
  const restored = B.restore(B.serialize(b));
  assert.deepEqual(restored.requests, b.requests);
});

test("restore fails safe to null on malformed stored state", () => {
  assert.equal(B.restore("{not json"), null);
  assert.equal(B.restore(null), null);
  assert.equal(B.restore("[]"), null);
  assert.equal(B.restore(JSON.stringify({ version: 99, requests: [] })), null);
  assert.equal(B.restore(JSON.stringify({ version: 1, requests: "nope" })), null);
  // structurally close but invalid request rows
  const base = { version: 1, requests: [{ id: "r1", title: "T", state: "queued", createdAt: 0, dueAt: null, deliveredAt: null, increments: [{ label: "x", done: false }] }] };
  assert.ok(B.restore(JSON.stringify(base)), "sanity: well-formed row restores");
  for (const mutate of [
    (r) => { r.state = "dreaming"; },
    (r) => { delete r.title; },
    (r) => { r.title = ""; },
    (r) => { r.dueAt = "next tuesday"; },
    (r) => { r.increments = [{ label: "x", done: "yes" }]; },
    (r) => { r.id = 7; },
  ]) {
    const bad = structuredClone(base);
    mutate(bad.requests[0]);
    assert.equal(B.restore(JSON.stringify(bad)), null, "should reject " + JSON.stringify(mutate));
  }
});

test("setDue validates the due date", () => {
  const b = B.createBoard();
  const a = B.enqueue(b, "A", ["x"], 1000);
  assert.throws(() => B.setDue(b, a.id, "next tuesday"), /not a valid date/);
  assert.throws(() => B.setDue(b, a.id, NaN), /not a valid date/);
  assert.throws(() => B.setDue(b, a.id, 500, 1000), /after the request was created/);
  assert.throws(() => B.setDue(b, "missing", 5000), /no request/);
  B.setDue(b, a.id, new Date(5000), 1000);
  assert.equal(a.dueAt, 5000);
});

test("on-time metric only counts delivered requests with a usable due date", () => {
  const b = B.createBoard();
  const noDue = B.enqueue(b, "no due", ["x"], 0);
  const onTime = B.enqueue(b, "on time", ["x"], 0); B.setDue(b, onTime.id, 5 * D, 0);
  const late = B.enqueue(b, "late", ["x"], 0); B.setDue(b, late.id, 2 * D, 0);
  B.start(b, noDue.id); B.toggleIncrement(b, noDue.id, 0); B.deliver(b, noDue.id, 1 * D);
  B.start(b, onTime.id); B.toggleIncrement(b, onTime.id, 0); B.deliver(b, onTime.id, 4 * D);
  B.start(b, late.id); B.toggleIncrement(b, late.id, 0); B.deliver(b, late.id, 3 * D);
  const m = B.metrics(b, 6 * D);
  assert.equal(m.deliveredCount, 3);
  assert.equal(m.onTimeCount, 1); // "no due" is not counted on time; "late" missed its due date
});
