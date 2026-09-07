import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 80;
const DROP_ROOT = process.env.DROP_ROOT || "/data/drops";
const GLOWHUM_DROPS_DIR = process.env.GLOWHUM_DROPS_DIR || "/data/glowhum-drops";
const DROP_MAX_BYTES = Number(process.env.DROP_MAX_BYTES) || 200 * 1024 * 1024;
const EPISODE_PRICE_AED = positiveInteger(process.env.GLOWHUM_EPISODE_PRICE_AED, 199);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;
const WEBHOOK_MAX_BYTES = 1024 * 1024;
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const ORDER_PRODUCT_MARKER = "glowhum_one_episode_v1";
const ORDER_STATUSES = new Set(["paid", "rendering", "published"]);

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function positiveInteger(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sendJson(res, status, object) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(object));
}

function newId() {
  const bytes = crypto.randomBytes(12);
  let id = "";
  for (let i = 0; i < 12; i++) id += ID_ALPHABET[bytes[i] & 31];
  return id;
}

function sanitizeFilename(raw) {
  const base = path
    .basename(String(raw || "file").replace(/[\\/]/g, "/"))
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "file";
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  return JSON.parse((await readRawBody(req, maxBytes)).toString("utf8"));
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(email.trim());
}

function validOrderId(id) {
  return typeof id === "string" && /^cs_[A-Za-z0-9_]+$/.test(id);
}

function validEventId(id) {
  return typeof id === "string" && /^evt_[A-Za-z0-9_]+$/.test(id);
}

function safeText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= maxLength ? text : "";
}

function validateOrderInput(input) {
  if (typeof input?.email !== "string" || input.email.trim().length > 254) return { error: "Enter a valid email address." };
  if (typeof input?.topic === "string" && input.topic.trim().length > 500) return { error: "Keep the topic under 500 characters." };
  if (typeof input?.report_url === "string" && input.report_url.trim().length > 500) return { error: "Keep the report URL under 500 characters." };
  const email = safeText(input.email, 254);
  const topic = safeText(input.topic, 500);
  const reportUrl = safeText(input.report_url, 500);
  if (!validateEmail(email)) return { error: "Enter a valid email address." };
  if (!topic && !reportUrl) return { error: "Add a topic or a report URL." };
  if (reportUrl) {
    try {
      const url = new URL(reportUrl);
      if (url.protocol !== "https:" || isPrivateLiteralHost(url.hostname)) throw new Error("Unsupported URL");
    } catch {
      return { error: "Enter a public HTTPS report URL." };
    }
  }
  return { email, topic: topic || null, reportUrl: reportUrl || null };
}

function isPrivateLiteralHost(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const type = isIP(host);
  if (type === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (type === 6) {
    const normalized = host.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("::ffff:");
  }
  return false;
}

function configuredPublicBaseUrl() {
  try {
    const url = new URL(PUBLIC_BASE_URL);
    if (url.protocol !== "https:" || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function createCheckoutSession(order, baseUrl) {
  const params = new URLSearchParams({
    mode: "payment",
    customer_email: order.email,
    client_reference_id: ORDER_PRODUCT_MARKER,
    success_url: `${baseUrl}/order?order_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?checkout=cancelled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "aed",
    "line_items[0][price_data][unit_amount]": String(EPISODE_PRICE_AED * 100),
    "line_items[0][price_data][product_data][name]": "One episode",
    "metadata[email]": order.email,
    "metadata[glowhum_product]": ORDER_PRODUCT_MARKER,
    "metadata[topic]": order.topic || "",
    "metadata[report_url]": order.reportUrl || "",
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  if (!response.ok) throw new Error("Stripe Checkout could not be created");
  const session = await response.json();
  if (!session || typeof session.url !== "string") throw new Error("Stripe Checkout returned no URL");
  return session;
}

function signatureParts(header) {
  let timestamp = null;
  const signatures = [];
  for (const part of String(header || "").split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

function verifyStripeSignature(rawBody, header) {
  if (!STRIPE_WEBHOOK_SECRET) return false;
  const { timestamp, signatures } = signatureParts(header);
  if (!Number.isInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = crypto
    .createHmac("sha256", STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return signatures.some((signature) => {
    const signatureBuffer = Buffer.from(signature, "hex");
    return expectedBuffer.length === signatureBuffer.length && crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  });
}

function jobFromCheckoutSession(session, event) {
  const metadata = session.metadata || {};
  const createdSeconds = Number(session.created);
  const createdAt = Number.isFinite(createdSeconds)
    ? new Date(createdSeconds * 1000).toISOString()
    : new Date().toISOString();
  return {
    id: session.id,
    order_id: session.id,
    email: safeText(session.customer_details?.email, 254),
    topic: safeText(metadata.topic, 500) || null,
    report_url: safeText(metadata.report_url, 500) || null,
    price_aed: EPISODE_PRICE_AED,
    created_at: createdAt,
    status: "paid",
    event_id: event.id,
    video_url: null,
    published_at: null,
  };
}

function orderDirectory(orderId) {
  return path.join(GLOWHUM_DROPS_DIR, "drops", orderId);
}

function receiptPath(orderId) {
  return path.join(orderDirectory(orderId), "receipt.json");
}

function eventPath(eventId) {
  return path.join(GLOWHUM_DROPS_DIR, "events", `${eventId}.json`);
}

async function writeImmutableFile(destination, contents) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${crypto.randomBytes(8).toString("hex")}`;
  await fs.writeFile(temporary, contents, { flag: "wx" });
  try {
    await fs.link(temporary, destination);
    return { created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const current = await fs.readFile(destination);
    if (!current.equals(Buffer.isBuffer(contents) ? contents : Buffer.from(contents))) {
      const conflict = new Error("Existing immutable file differs");
      conflict.code = "CONFLICT";
      throw conflict;
    }
    return { created: false };
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function claimEvent(eventId, orderId) {
  const claim = `${JSON.stringify({ event_id: eventId, order_id: orderId })}\n`;
  try {
    const result = await writeImmutableFile(eventPath(eventId), claim);
    return { claimed: result.created };
  } catch (error) {
    if (error?.code === "CONFLICT") {
      const conflict = new Error("Event ID is already bound to another order");
      conflict.code = "EVENT_CONFLICT";
      throw conflict;
    }
    throw error;
  }
}

function requestContents(job) {
  return Buffer.from(`${JSON.stringify({ topic: job.topic, report_url: job.report_url }, null, 2)}\n`, "utf8");
}

async function writeOrderOnce(job) {
  const directory = orderDirectory(job.order_id);
  const request = requestContents(job);
  const requestSha = crypto.createHash("sha256").update(request).digest("hex");
  const receipt = {
    ...job,
    name: "request.md",
    sha256: requestSha,
    size: request.length,
    received_at: job.created_at,
  };
  await fs.mkdir(directory, { recursive: true });
  await writeImmutableFile(path.join(directory, "request.md"), request);
  const receiptContents = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    const result = await writeImmutableFile(receiptPath(job.order_id), receiptContents);
    return { created: result.created, job: receipt };
  } catch (error) {
    if (error?.code !== "CONFLICT") throw error;
    const existing = JSON.parse(await fs.readFile(receiptPath(job.order_id), "utf8"));
    if (existing.event_id === job.event_id) return { created: false, job: existing };
    const conflict = new Error("Order is already bound to another event");
    conflict.code = "ORDER_CONFLICT";
    throw conflict;
  }
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;
  let file = null;
  if (pathname === "/") file = "index.html";
  else if (pathname === "/order") file = "order.html";
  else if (pathname === "/favicon.svg") file = "favicon.svg";
  else if (pathname === "/favicon.ico") file = "favicon.ico";
  else if (pathname === "/apple-touch-icon.png") file = "apple-touch-icon.png";
  else if (pathname === "/site.webmanifest") file = "site.webmanifest";
  if (!file) return false;
  try {
    const data = await fs.readFile(path.join(__dirname, file));
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": mimeByExt[ext] || "application/octet-stream",
      "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
  return true;
}

const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const previous = (rateBuckets.get(ip) || []).filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (previous.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, previous);
    return true;
  }
  previous.push(now);
  rateBuckets.set(ip, previous);
  return false;
}

async function handleDrop(req, res, ip) {
  if (isRateLimited(ip)) return sendJson(res, 429, { error: "Rate limit exceeded" });
  const rawName = req.headers["x-file-name"];
  const declaredSize = Number(req.headers["x-file-size"]);
  if (!rawName || !Number.isFinite(declaredSize) || declaredSize < 0) {
    req.resume();
    return sendJson(res, 400, { error: "Missing or invalid X-File-Name / X-File-Size headers" });
  }
  if (declaredSize > DROP_MAX_BYTES) {
    req.resume();
    return sendJson(res, 413, { error: "File too large" });
  }

  const safeName = sanitizeFilename(rawName);
  const id = newId();
  const targetDir = path.join(DROP_ROOT, id);
  const targetFile = path.join(targetDir, safeName);
  await fs.mkdir(targetDir, { recursive: true });
  const hash = crypto.createHash("sha256");
  let storedSize = 0;
  let handle = null;
  try {
    handle = await fs.open(targetFile, "w");
    for await (const chunk of req) {
      storedSize += chunk.length;
      if (storedSize > DROP_MAX_BYTES) {
        await handle.close();
        handle = null;
        await fs.rm(targetFile, { force: true });
        await fs.rm(targetDir, { recursive: true, force: true });
        return sendJson(res, 413, { error: "File too large" });
      }
      await handle.write(chunk);
      hash.update(chunk);
    }
    await handle.close();
    handle = null;
  } catch {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(targetFile, { force: true }).catch(() => {});
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    return sendJson(res, 500, { error: "Upload failed" });
  }
  const receipt = {
    id,
    name: safeName,
    size: storedSize,
    sha256: hash.digest("hex"),
    received_at: new Date().toISOString(),
    status: "received",
    email: null,
  };
  await fs.writeFile(path.join(targetDir, "receipt.json"), JSON.stringify(receipt, null, 2), "utf8");
  sendJson(res, 201, receipt);
}

async function handleEmailSet(req, res, id) {
  let parsed;
  try {
    parsed = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  const email = safeText(parsed.email, 254);
  if (!validateEmail(email)) return sendJson(res, 400, { error: "Invalid email" });
  const receiptPath = path.join(DROP_ROOT, id, "receipt.json");
  try {
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.email = email;
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
    sendJson(res, 200, receipt);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleReceiptGet(res, id) {
  try {
    sendJson(res, 200, JSON.parse(await fs.readFile(path.join(DROP_ROOT, id, "receipt.json"), "utf8")));
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleCheckout(req, res) {
  let input;
  try {
    input = validateOrderInput(await readJsonBody(req));
  } catch {
    return sendJson(res, 400, { error: "Invalid order details." });
  }
  if (input.error) return sendJson(res, 400, { error: input.error });
  if (!STRIPE_SECRET_KEY) return sendJson(res, 503, { error: "Checkout is not ready yet." });
  const baseUrl = configuredPublicBaseUrl();
  if (!baseUrl) return sendJson(res, 503, { error: "Checkout is not ready yet." });
  try {
    const session = await createCheckoutSession(input, baseUrl);
    sendJson(res, 201, { checkout_url: session.url });
  } catch {
    sendJson(res, 502, { error: "Checkout could not be started. Please try again." });
  }
}

async function handleStripeWebhook(req, res) {
  let rawBody;
  try {
    rawBody = await readRawBody(req, WEBHOOK_MAX_BYTES);
  } catch {
    return sendJson(res, 400, { error: "Invalid webhook body" });
  }
  if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"])) {
    return sendJson(res, 400, { error: "Invalid webhook signature" });
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "Invalid webhook payload" });
  }
  if (event.type !== "checkout.session.completed") return sendJson(res, 400, { error: "Unsupported webhook event" });
  const session = event.data?.object;
  if (!validEventId(event.id) || !isValidPaidCheckoutSession(session)) {
    return sendJson(res, 400, { error: "Invalid Checkout session" });
  }
  const job = jobFromCheckoutSession(session, event);
  try {
    await claimEvent(job.event_id, job.order_id);
    const result = await writeOrderOnce(job);
    sendJson(res, 200, { received: true, created: result.created, order_id: result.job.order_id });
  } catch (error) {
    if (error?.code === "EVENT_CONFLICT" || error?.code === "ORDER_CONFLICT") {
      return sendJson(res, 409, { error: "Webhook event conflicts with an existing order" });
    }
    sendJson(res, 500, { error: "Could not store order" });
  }
}

function isValidPaidCheckoutSession(session) {
  if (!session || session.object !== "checkout.session" || !validOrderId(session.id)) return false;
  if (session.mode !== "payment" || session.payment_status !== "paid") return false;
  if (String(session.currency || "").toLowerCase() !== "aed") return false;
  if (session.amount_total !== EPISODE_PRICE_AED * 100) return false;
  if (session.client_reference_id !== ORDER_PRODUCT_MARKER) return false;
  if (session.metadata?.glowhum_product !== ORDER_PRODUCT_MARKER) return false;
  const order = validateOrderInput({
    email: session.customer_details?.email,
    topic: session.metadata?.topic,
    report_url: session.metadata?.report_url,
  });
  return !order.error;
}

function validHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function validIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function handleOrderStatus(res, id) {
  if (!validOrderId(id)) return sendJson(res, 404, { error: "Not found" });
  try {
    const job = JSON.parse(await fs.readFile(receiptPath(id), "utf8"));
    if (job.order_id !== id || !ORDER_STATUSES.has(job.status) || !validIsoDate(job.created_at)) {
      return sendJson(res, 404, { error: "Not found" });
    }
    if (job.status === "published" && (!validHttpsUrl(job.video_url) || !validIsoDate(job.published_at))) {
      return sendJson(res, 404, { error: "Not found" });
    }
    sendJson(res, 200, {
      order_id: job.order_id,
      status: job.status,
      created_at: job.created_at,
      video_url: job.status === "published" ? job.video_url : null,
      published_at: job.status === "published" ? job.published_at : null,
    });
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/order-config" && req.method === "GET") return sendJson(res, 200, { price_aed: EPISODE_PRICE_AED });
      if (pathname === "/api/checkout" && req.method === "POST") return handleCheckout(req, res);
      if (pathname === "/api/stripe/webhook" && req.method === "POST") return handleStripeWebhook(req, res);
      if (pathname === "/api/drop" && req.method === "POST") return handleDrop(req, res, req.socket.remoteAddress || "unknown");
      const emailMatch = pathname.match(/^\/api\/drop\/([^/]+)\/email$/);
      if (emailMatch && req.method === "POST") return handleEmailSet(req, res, emailMatch[1]);
      const dropMatch = pathname.match(/^\/api\/drop\/([^/]+)$/);
      if (dropMatch && req.method === "GET") return handleReceiptGet(res, dropMatch[1]);
      const orderMatch = pathname.match(/^\/api\/order\/(cs_[A-Za-z0-9_]+)$/);
      if (orderMatch && req.method === "GET") return handleOrderStatus(res, orderMatch[1]);
      return sendJson(res, 404, { error: "Not found" });
    }
    if (!(await serveStatic(req, res))) sendJson(res, 404, { error: "Not found" });
  } catch {
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  if (process.env.NODE_ENV !== "test") console.log(`GLOWHUM server listening on ${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
