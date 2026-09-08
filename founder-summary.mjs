import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyChannelFormat } from "./scripts/verify-nomoi-channel-format.mjs";

const DEFAULT_SOURCE = "/home/ainur/Apps/.ainur/physai/NOMOI_CHANNEL_FORMAT_GENSPARK_K3_2026_09_04.md";
const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024;
const RECEIPT_ID = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function cleanCopy(text) {
  return text
    .replace(/\s+[—–]\s+/g, ". ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function section(markdown, heading, nextHeading) {
  const start = markdown.search(heading);
  if (start < 0) return "";
  const body = markdown.slice(start);
  const end = nextHeading ? body.search(nextHeading) : -1;
  return body.slice(0, end < 0 ? body.length : end).trim();
}

export function buildFounderSummary(markdown, sourceSha256) {
  const sections = [
    ["The format", /^## 0\. The format in one paragraph\s*$/m, /^## 1\./m],
    ["The source format decoded", /^## 1\. The Genspark format, decoded\s*$/m, /^## 2\./m],
    ["The NOMOI channel format", /^## 2\. The NOMOI channel format\s*$/m, /^## 3\./m],
    ["The solo production kit", /^## 3\. The solo production kit\s*$/m, /^## 4\./m],
    ["The first three episode briefs", /^## 4\. First three episode briefs\s*$/m, /^## 5\./m],
    ["The floor", /^## 5\. The floor.*$/m, /^## 6\./m],
    ["What does not transfer", /^## 6\. Adversarial: what will NOT transfer, and what replaces it\s*$/m, /^## 7\./m],
    ["Pre-flight", /^## 7\. Pre-flight checklist.*$/m, null],
  ];

  const selected = sections.map(([label, heading, nextHeading]) => {
    const value = section(markdown, heading, nextHeading);
    if (!value) fail(422, `The synthesis is missing the ${label.toLowerCase()} section.`);
    return value;
  });

  const message = [
    "Glowhum channel summary",
    `Source SHA 256: ${sourceSha256}`,
    "",
    ...selected,
    "",
    "This summary was generated from the verified canonical synthesis. It does not claim filming, founder approval, a live run, or a published episode.",
  ].map(cleanCopy).join("\n\n");

  if (message.length > 64 * 1024) fail(422, "The founder summary is too large to deliver.");
  return message;
}

function configured(options = {}) {
  const sourcePath = options.sourcePath || process.env.GLOWHUM_CHANNEL_FORMAT_SOURCE || DEFAULT_SOURCE;
  const storageRoot = options.storageRoot || process.env.GLOWHUM_FOUNDER_SUMMARY_ROOT || "/data/glowhum-drops/founder-summary";
  const deliveryUrl = options.deliveryUrl || process.env.GLOWHUM_FOUNDER_DELIVERY_URL || "";
  const promptId = options.promptId || process.env.TWOTHUMBS_PROMPT_ID || "prm_a611c7ea-cec5-4831-970d-248073dff6fc";
  const promptVersion = Number(options.promptVersion || process.env.TWOTHUMBS_PROMPT_VERSION || 125);
  return { sourcePath, storageRoot, deliveryUrl, promptId, promptVersion };
}

function checkDeliveryUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail(503, "Founder delivery is not configured."); }
  const localTest = process.env.NODE_ENV === "test" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (!localTest && parsed.protocol !== "https:") fail(503, "Founder delivery must use HTTPS.");
  if (!parsed.hostname || parsed.username || parsed.password || parsed.hash) fail(503, "Founder delivery URL is invalid.");
  return parsed;
}

function bearerMatch(req) {
  const expected = process.env.GLOWHUM_FOUNDER_DELIVERY_TOKEN || "";
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return expected.length >= 32
    && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${crypto.randomBytes(12).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readReceipt(storageRoot, id) {
  if (!RECEIPT_ID.test(id)) fail(404, "Delivery receipt not found.");
  try { return JSON.parse(await fs.readFile(path.join(storageRoot, `${id}.json`), "utf8")); }
  catch { fail(404, "Delivery receipt not found."); }
}

async function responseBody(response, maxBytes = 16 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      fail(502, "Founder delivery returned an oversized receipt.");
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function deliverFounderSummary(options = {}) {
  const settings = configured(options);
  const source = await fs.readFile(settings.sourcePath);
  if (source.length > DEFAULT_MAX_SOURCE_BYTES) fail(422, "The synthesis source is too large.");
  const sourceSha256 = sha256(source);
  const verified = await verifyChannelFormat(settings.sourcePath);
  if (verified.status !== "COMPLETE") fail(422, "The canonical synthesis is incomplete.");
  const message = buildFounderSummary(source.toString("utf8"), sourceSha256);
  const deliveryId = sha256(`${settings.promptId}:${settings.promptVersion}:${sourceSha256}`);
  await fs.mkdir(settings.storageRoot, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(settings.storageRoot, `${deliveryId}.json`);
  try {
    const existing = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    if (existing.status === "send_confirmed") return { ...existing, replayed: true };
    if (["send_pending", "send_unknown"].includes(existing.status) && options.retry !== true) fail(409, "A prior delivery has an unknown result. Set retry after checking its receipt.");
    if (existing.status === "send_rejected" && options.retry !== true) fail(409, "A prior delivery was rejected. Set retry to try again.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const lockPath = path.join(settings.storageRoot, `${deliveryId}.lock`);
  try { await fs.mkdir(lockPath); }
  catch (error) { if (error.code === "EEXIST") fail(409, "This founder delivery is already running. Check its receipt shortly."); throw error; }
  try {
    try {
      const existing = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      if (existing.status === "send_confirmed") return { ...existing, replayed: true };
      if (["send_pending", "send_unknown"].includes(existing.status) && options.retry !== true) fail(409, "A prior delivery has an unknown result. Set retry after checking its receipt.");
      if (existing.status === "send_rejected" && options.retry !== true) fail(409, "A prior delivery was rejected. Set retry to try again.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const url = checkDeliveryUrl(settings.deliveryUrl);
    const startedAt = new Date().toISOString();
    const payload = JSON.stringify({
      schema: "glowhum.founder-summary.v1",
      delivery_id: deliveryId,
      prompt_id: settings.promptId,
      prompt_version: settings.promptVersion,
      source_sha256: sourceSha256,
      message,
    });
    const pendingReceipt = {
      schema: "glowhum.founder-summary-receipt.v1",
      delivery_id: deliveryId,
      status: "send_pending",
      prompt_id: settings.promptId,
      prompt_version: settings.promptVersion,
      source_artifact: settings.sourcePath,
      source_sha256: sourceSha256,
      message_sha256: sha256(message),
      message,
      started_at: startedAt,
    };
    await writeJsonAtomic(receiptPath, pendingReceipt);
    const messageSha256 = sha256(message);
    const headers = {
      "Content-Type": "application/json",
      "X-Glowhum-Delivery-Id": deliveryId,
      "X-Glowhum-Message-SHA256": messageSha256,
      "Idempotency-Key": deliveryId,
    };
    if (process.env.GLOWHUM_FOUNDER_DELIVERY_SECRET) headers.Authorization = `Bearer ${process.env.GLOWHUM_FOUNDER_DELIVERY_SECRET}`;
    const fetchImpl = options.fetchImpl || fetch;
    let response;
    let providerBody = "";
    try {
      response = await fetchImpl(url, { method: "POST", headers, body: payload, redirect: "error", signal: AbortSignal.timeout(15000) });
      providerBody = await responseBody(response);
    } catch (error) {
      const receipt = {
        schema: "glowhum.founder-summary-receipt.v1",
        delivery_id: deliveryId,
        status: "send_unknown",
        prompt_id: settings.promptId,
        prompt_version: settings.promptVersion,
        source_artifact: settings.sourcePath,
        source_sha256: sourceSha256,
        message_sha256: messageSha256,
        started_at: startedAt,
        error: error.message,
      };
      await writeJsonAtomic(receiptPath, receipt);
      fail(502, "Founder delivery could not be confirmed. Check the retained receipt.");
    }

    const receipt = {
      schema: "glowhum.founder-summary-receipt.v1",
      delivery_id: deliveryId,
      status: response.ok ? "send_confirmed" : "send_rejected",
      prompt_id: settings.promptId,
      prompt_version: settings.promptVersion,
      source_artifact: settings.sourcePath,
      source_sha256: sourceSha256,
      message_sha256: messageSha256,
      message,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      provider: {
        origin: url.origin,
        http_status: response.status,
        response_body: providerBody,
        response_sha256: sha256(providerBody),
      },
    };
    try {
      await writeJsonAtomic(receiptPath, receipt);
    } catch (error) {
      const unknownReceipt = {
        ...receipt,
        status: "send_unknown",
        error: `The provider answered, but the final receipt could not be saved: ${error.message}`,
      };
      await writeJsonAtomic(receiptPath, unknownReceipt).catch(() => {});
      fail(500, "The provider answered, but the delivery receipt could not be saved.");
    }
    if (!response.ok) fail(502, "Founder delivery was rejected. Check the retained receipt.");
    return receipt;
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function requestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) fail(413, "Request is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail(400, "Could not read this request."); }
}

export async function founderSummaryRoutes(req, res, pathname, options = {}) {
  const deliverPath = pathname === "/api/founder-summary/deliver";
  const receiptMatch = /^\/api\/founder-summary\/receipt\/([a-f0-9]{64})$/.exec(pathname);
  if (!deliverPath && !receiptMatch) return false;
  try {
    if (!bearerMatch(req)) fail(401, "Founder delivery access required.");
    const settings = configured(options);
    if (receiptMatch && req.method === "GET") {
      sendJson(res, 200, await readReceipt(settings.storageRoot, receiptMatch[1]));
      return true;
    }
    if (!deliverPath || req.method !== "POST") fail(405, "Use the founder delivery action.");
    const input = await requestBody(req);
    const result = await deliverFounderSummary({ ...options, retry: input.retry === true });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, Number.isInteger(error.code) ? error.code : 500, { error: Number.isInteger(error.code) ? error.message : "Founder delivery failed." });
  }
  return true;
}
