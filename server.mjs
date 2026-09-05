import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT) || 80;
const DROP_ROOT = process.env.DROP_ROOT || "/data/drops";
const DROP_MAX_BYTES = Number(process.env.DROP_MAX_BYTES) || 200 * 1024 * 1024;

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 20;

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, object) {
  const body = JSON.stringify(object);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function newId() {
  const bytes = crypto.randomBytes(12);
  let id = "";
  for (let i = 0; i < 12; i++) {
    id += ID_ALPHABET[bytes[i] & 31];
  }
  return id;
}

function sanitizeFilename(raw) {
  let base = path
    .basename(String(raw || "file").replace(/[\\/]/g, "/"))
    .replace(/[^A-Za-z0-9._-]/g, "_");
  return base || "file";
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return JSON.parse(raw);
}

function validateEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(email.trim());
}

async function serveStatic(req, res) {
  const pathname = new URL(req.url, "http://localhost").pathname;

  let file = null;
  if (pathname === "/") {
    file = "index.html";
  } else if (pathname === "/favicon.svg") {
    file = "favicon.svg";
  } else if (pathname === "/favicon.ico") {
    file = "favicon.ico";
  } else if (pathname === "/apple-touch-icon.png") {
    file = "apple-touch-icon.png";
  } else if (pathname === "/site.webmanifest") {
    file = "site.webmanifest";
  }

  if (!file) return false;

  const fullPath = path.join(__dirname, file);
  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(file);
    res.writeHead(200, {
      "Content-Type": mimeByExt[ext] || "application/octet-stream",
      "Cache-Control": file === "index.html" ? "no-cache" : "public, max-age=3600",
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
  const previous = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (previous.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, previous);
    return true;
  }
  previous.push(now);
  rateBuckets.set(ip, previous);
  return false;
}

async function handleDrop(req, res, ip) {
  if (isRateLimited(ip)) {
    sendJson(res, 429, { error: "Rate limit exceeded" });
    return;
  }

  const rawName = req.headers["x-file-name"];
  const rawSize = req.headers["x-file-size"];
  const declaredSize = Number(rawSize);

  if (!rawName || !Number.isFinite(declaredSize) || declaredSize < 0) {
    req.resume();
    sendJson(res, 400, { error: "Missing or invalid X-File-Name / X-File-Size headers" });
    return;
  }

  if (declaredSize > DROP_MAX_BYTES) {
    req.resume();
    sendJson(res, 413, { error: "File too large" });
    return;
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
        sendJson(res, 413, { error: "File too large" });
        return;
      }
      await handle.write(chunk);
      hash.update(chunk);
    }
    await handle.close();
    handle = null;
  } catch (err) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.rm(targetFile, { force: true }).catch(() => {});
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
    sendJson(res, 500, { error: "Upload failed" });
    return;
  }

  const sha256 = hash.digest("hex");
  const receivedAt = new Date().toISOString();
  const receipt = {
    id,
    name: safeName,
    size: storedSize,
    sha256,
    received_at: receivedAt,
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
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
  if (!validateEmail(email)) {
    sendJson(res, 400, { error: "Invalid email" });
    return;
  }

  const receiptPath = path.join(DROP_ROOT, id, "receipt.json");
  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  receipt.email = email;
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
  sendJson(res, 200, receipt);
}

async function handleReceiptGet(req, res, id) {
  const receiptPath = path.join(DROP_ROOT, id, "receipt.json");
  try {
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    sendJson(res, 200, receipt);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/drop" && req.method === "POST") {
        await handleDrop(req, res, req.socket.remoteAddress || "unknown");
        return;
      }

      const emailMatch = pathname.match(/^\/api\/drop\/([^/]+)\/email$/);
      if (emailMatch && req.method === "POST") {
        await handleEmailSet(req, res, emailMatch[1]);
        return;
      }

      const idMatch = pathname.match(/^\/api\/drop\/([^/]+)$/);
      if (idMatch && req.method === "GET") {
        await handleReceiptGet(req, res, idMatch[1]);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const didHandle = await serveStatic(req, res);
    if (!didHandle) {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (err) {
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, HOST, () => {
  if (process.env.NODE_ENV !== "test") {
    console.log(`GLOWHUM server listening on ${HOST}:${PORT}`);
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
