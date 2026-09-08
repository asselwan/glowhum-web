import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const idPattern = /^[a-f0-9]{36}$/;
const entitlementPattern = /^cs_[A-Za-z0-9_]+$/;
const PRODUCT = "glowhum_one_episode_v1";
const MAX_TOPIC_BYTES = 8 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(18).toString("hex");

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, "That request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, MAX_TOPIC_BYTES)).toString("utf8"));
  } catch (error) {
    if (Number.isInteger(error?.code)) throw error;
    fail(400, "Could not read this request.");
  }
}

function previewRoot(root) {
  return path.join(root, "previews");
}

function previewDir(root, id) {
  if (!idPattern.test(id)) fail(404, "Preview not found.");
  return path.join(previewRoot(root), id);
}

function receiptPath(root, id) {
  return path.join(previewDir(root, id), "receipt.json");
}

async function saveJson(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readPreview(root, id) {
  try {
    return JSON.parse(await fs.readFile(receiptPath(root, id), "utf8"));
  } catch {
    fail(404, "Preview not found.");
  }
}

function publicPreview(receipt) {
  return {
    id: receipt.id,
    topic: receipt.topic,
    status: receipt.status,
    created_at: receipt.created_at,
    preview_url: receipt.video ? `/api/topic-preview/${receipt.id}/video` : null,
    video: receipt.video ? {
      content_type: receipt.video.content_type,
      size: receipt.video.size,
      sha256: receipt.video.sha256,
      ready_at: receipt.video.ready_at,
    } : null,
  };
}

async function createPreview(root, topic) {
  const id = newId();
  const dir = previewDir(root, id);
  await fs.mkdir(dir, { recursive: true });
  const receipt = { id, topic, status: "previewing", created_at: now(), video: null };
  await saveJson(path.join(dir, "receipt.json"), receipt);
  return receipt;
}

function validTopic(value) {
  if (typeof value !== "string") return null;
  const topic = value.trim();
  if (!topic || topic.length > 500) return null;
  return topic;
}

async function saveVideo(root, id, req) {
  const receipt = await readPreview(root, id);
  if (receipt.status === "ready") fail(409, "This preview is already ready.");
  const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].toLowerCase();
  if (!["video/webm", "video/mp4"].includes(contentType)) fail(415, "Send a WebM or MP4 video.");
  const body = await readBody(req, Number(process.env.GLOWHUM_PREVIEW_MAX_BYTES) || MAX_VIDEO_BYTES);
  if (body.length < 32) fail(400, "A complete video is required.");
  if (contentType === "video/webm" && !body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    fail(400, "A complete WebM video is required.");
  }
  if (contentType === "video/mp4" && body.subarray(4, 8).toString("ascii") !== "ftyp") {
    fail(400, "A complete MP4 video is required.");
  }
  const dir = previewDir(root, id);
  const videoName = contentType === "video/webm" ? "preview.webm" : "preview.mp4";
  const videoPath = path.join(dir, videoName);
  const temporary = `${videoPath}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, body, { mode: 0o600 });
  try {
    await fs.rename(temporary, videoPath);
    const video = {
      file: videoName,
      content_type: contentType,
      size: body.length,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      ready_at: now(),
    };
    const updated = { ...receipt, status: "ready", video };
    await saveJson(receiptPath(root, id), updated);
    return updated;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readEntitlement(root, id) {
  if (!entitlementPattern.test(id)) fail(401, "Sign in or enter an active order to download this video.");
  try {
    const entitlement = JSON.parse(await fs.readFile(path.join(root, "entitlements", `${id}.json`), "utf8"));
    if (entitlement.entitlement_id !== id || entitlement.order_id !== id || entitlement.product !== PRODUCT || entitlement.status !== "active") {
      fail(403, "This order does not unlock downloads.");
    }
    return entitlement;
  } catch (error) {
    if (Number.isInteger(error?.code)) throw error;
    fail(403, "This order does not unlock downloads.");
  }
}

async function sendVideo(res, root, receipt, attachment) {
  const videoPath = path.join(previewDir(root, receipt.id), receipt.video.file);
  const body = await fs.readFile(videoPath).catch(() => null);
  if (!body) fail(404, "The preview video is not available.");
  const extension = receipt.video.content_type === "video/mp4" ? "mp4" : "webm";
  res.writeHead(200, {
    "Content-Type": receipt.video.content_type,
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${attachment ? "attachment" : "inline"}; filename="glowhum-topic-preview.${extension}"`,
  });
  res.end(body);
}

export async function topicPreviewRoutes(req, res, pathname, root) {
  const match = /^\/api\/topic-preview(?:\/([a-f0-9]{36})(?:\/(video|download))?)?$/.exec(pathname);
  if (!match) return false;
  try {
    const [, id, action] = match;
    if (!id && req.method === "POST") {
      if (!(req.headers["content-type"] || "").startsWith("application/json")) fail(415, "Send the topic as JSON.");
      const input = await readJson(req);
      const topic = validTopic(input?.topic);
      if (!topic) fail(400, "Write one topic under 500 characters.");
      json(res, 201, publicPreview(await createPreview(root, topic)));
      return true;
    }
    if (!id) fail(405, "This action is not available.");
    if (!action && req.method === "GET") {
      json(res, 200, publicPreview(await readPreview(root, id)));
      return true;
    }
    if (action === "video" && req.method === "GET") {
      const receipt = await readPreview(root, id);
      if (!receipt.video || receipt.status !== "ready") fail(404, "Your preview is not ready yet.");
      await sendVideo(res, root, receipt, false);
      return true;
    }
    if (action === "video" && req.method === "POST") {
      json(res, 200, publicPreview(await saveVideo(root, id, req)));
      return true;
    }
    if (action === "download" && req.method === "POST") {
      const input = await readJson(req);
      await readEntitlement(root, input?.entitlement_id);
      const receipt = await readPreview(root, id);
      if (!receipt.video || receipt.status !== "ready") fail(404, "Your preview is not ready yet.");
      await sendVideo(res, root, receipt, true);
      return true;
    }
    fail(405, "This action is not available.");
  } catch (error) {
    if (!res.headersSent) json(res, Number.isInteger(error?.code) ? error.code : 500, { error: Number.isInteger(error?.code) ? error.message : "Could not save this preview." });
  }
  return true;
}
