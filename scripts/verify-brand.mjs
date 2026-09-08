import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

async function readText(relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

async function exists(relativePath) {
  try {
    await fs.access(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function sha256(relativePath) {
  const bytes = await fs.readFile(path.join(repoRoot, relativePath));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function addCheck(result, check, passed, detail) {
  result.checks.push({ check, passed, detail });
  if (!passed) result.ok = false;
}

export async function auditBrand(record) {
  if (!record) record = JSON.parse(await readText("brand/glowhum.json"));
  const result = { ok: true, approval_complete: true, checks: [], gaps: [] };
  const brand = record.brand;

  addCheck(result, "brand name is present", Boolean(brand?.name), brand?.name || "missing");
  addCheck(result, "brand domain is present", Boolean(brand?.domain), brand?.domain || "missing");
  addCheck(
    result,
    "approved name source is recorded",
    brand?.name_approval?.status === "approved" && Boolean(brand.name_approval.source),
    brand?.name_approval?.source || "missing"
  );

  const logoPath = brand?.logo?.canonical_path;
  addCheck(result, "canonical logo exists", Boolean(logoPath) && await exists(logoPath), logoPath || "missing");
  if (logoPath && await exists(logoPath)) {
    const logo = await readText(logoPath);
    addCheck(result, "canonical logo is an SVG mark", /<svg\b/i.test(logo) && /aria-label="GLOWHUM glow mark"/.test(logo), logoPath);
    addCheck(result, "canonical logo has a square icon viewBox", /viewBox="0 0 64 64"/.test(logo), logoPath);
    addCheck(result, "canonical logo has a readable icon silhouette", (logo.match(/<(?:rect|circle|path)\b/g) || []).length >= 4, logoPath);
    addCheck(result, "canonical logo has no text-only fallback", !/<text\b/i.test(logo), logoPath);
  }

  for (const variant of brand?.favicon?.variants || []) {
    addCheck(result, `favicon asset exists: ${variant.path}`, await exists(variant.path), variant.type);
    if (await exists(variant.path)) {
      addCheck(result, `favicon asset hash matches: ${variant.path}`, (await sha256(variant.path)) === variant.sha256, variant.sha256);
    }
  }

  const manifest = await readText("site.webmanifest");
  addCheck(result, "manifest uses the canonical logo", manifest.includes(`"src": "/${logoPath}"`), logoPath || "missing");
  addCheck(result, "manifest includes the touch icon", manifest.includes('"src": "/apple-touch-icon.png"'), "apple-touch-icon.png");

  for (const page of record.pages || []) {
    const source = await readText(page.file);
    addCheck(result, `page exists: ${page.route}`, true, page.file);
    addCheck(result, `page uses the brand text: ${page.route}`, source.includes(page.brand_text), page.brand_text);
    for (const iconRef of page.icon_refs) {
      addCheck(result, `page uses icon ${iconRef}: ${page.route}`, source.includes(iconRef), iconRef);
    }
  }

  const shippedHtml = (await fs.readdir(repoRoot)).filter((file) => file.endsWith(".html"));
  for (const file of shippedHtml) {
    addCheck(result, `shipped HTML is covered: ${file}`, (record.pages || []).some((page) => page.file === file), file);
  }

  const server = await readText("server.mjs");
  for (const page of record.pages || []) {
    const routeMarker = `pathname === "${page.route}"`;
    const fileMarker = `file = "${page.file}"`;
    addCheck(result, `server maps ${page.route}`, server.includes(routeMarker) && server.includes(fileMarker), page.file);
  }

  for (const redirect of record.redirects || []) {
    const source = await readText(redirect.source_file);
    const targetPage = (record.pages || []).find((page) => page.route === redirect.target_route);
    addCheck(result, `redirect source is wired: ${redirect.id}`, source.includes(redirect.source_marker), redirect.source_file);
    addCheck(result, `redirect target is a branded page: ${redirect.id}`, Boolean(targetPage), redirect.target_route);
  }

  if (brand?.logo?.approval?.status !== "approved" || !brand.logo.approval.source) {
    result.approval_complete = false;
    result.gaps.push({
      asset: "logo",
      status: brand?.logo?.approval?.status || "missing",
      detail: "No explicit approval source for the canonical Glowhum logo was found."
    });
  }

  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const strict = process.argv.includes("--require-approved");
  const result = await auditBrand();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok || (strict && !result.approval_complete)) process.exitCode = 1;
}
