import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ARTIFACT_PATH = path.resolve(
  SCRIPT_DIR,
  "../../.ainur/physai/NOMOI_CHANNEL_FORMAT_GENSPARK_K3_2026_09_04.md",
);

function lineNumber(markdown, index) {
  return markdown.slice(0, index).split("\n").length;
}

function findHeading(markdown, pattern) {
  const match = pattern.exec(markdown);
  return match ? lineNumber(markdown, match.index) : null;
}

function sectionBetween(markdown, startPattern, endPattern) {
  const start = startPattern.exec(markdown);
  if (!start) return null;
  const end = endPattern?.exec(markdown.slice(start.index + start[0].length));
  const endIndex = end ? start.index + start[0].length + end.index : markdown.length;
  return markdown.slice(start.index, endIndex);
}

function check(id, passed, detail, line = null) {
  return { id, status: passed ? "pass" : "fail", detail, ...(line ? { line } : {}) };
}

function distinctBriefs(markdown) {
  const block = sectionBetween(markdown, /^## 4\. First three episode briefs\s*$/m, /^## 5\./m);
  if (!block) return { count: 0, titles: [], unique: false };
  const headings = [...block.matchAll(/^### 4\.[1-3] (.+)$/gm)];
  const briefs = headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? block.length;
    return { title: heading[1].trim(), body: block.slice(start, end) };
  });
  const fingerprints = briefs.map(({ body }) => {
    const payload = body.replace(/^### 4\.[1-3] .+\n/, "");
    return crypto.createHash("sha256").update(payload).digest("hex");
  });
  return {
    count: briefs.length,
    titles: briefs.map(({ title }) => title),
    unique: new Set(fingerprints).size === briefs.length,
    briefs,
  };
}

export function inspectChannelFormat(markdown, artifactPath = DEFAULT_ARTIFACT_PATH) {
  const format = sectionBetween(markdown, /^## 2\. The NOMOI channel format\s*$/m, /^## 3\./m) || "";
  const founder = sectionBetween(markdown, /^### 2\.2 Founder's on-camera role and exact shot list\s*$/m, /^### 2\.3 /m) || "";
  const formulation = sectionBetween(markdown, /^### 2\.3 The formulation pattern\b.*$/m, /^### 2\.4 /m) || "";
  const kit = sectionBetween(markdown, /^## 3\. The solo production kit\s*$/m, /^## 4\./m) || "";
  const briefs = distinctBriefs(markdown);
  const formulationSteps = ["ASK", "ACKNOWLEDGEMENT", "REFINEMENT", "RECEIPT"];
  const formulationPositions = formulationSteps.map((step) => formulation.indexOf(`**${step}.**`));
  const formulationIsOrdered = formulationPositions.every(
    (position, index) => position >= 0 && (index === 0 || position > formulationPositions[index - 1]),
  );

  const checks = [
    check(
      "format",
      Boolean(format) && /THE RUN/.test(format) && /### 2\.1 Episode skeleton/.test(format)
        && ["THE ASK", "THE ACKNOWLEDGEMENT", "THE JAM", "THE REFINEMENT", "THE RECEIPT", "THE LEDGER", "Hard out"]
          .every((beat) => format.includes(beat)),
      "THE RUN and the episode skeleton contain the required run beats.",
      findHeading(markdown, /^## 2\. The NOMOI channel format\s*$/m),
    ),
    check(
      "founder_role_and_shot_list",
      Boolean(founder)
        && /operator's boss/.test(founder)
        && /Minimum 45% of runtime/.test(founder)
        && /Inverted-hierarchy beat/.test(founder)
        && ["S0", "A1", "V1", "S1", "S2", "S3", "A2", "S4", "A3", "A4", "S5", "A5"]
          .every((shot) => new RegExp(`\\b${shot}\\b`).test(founder)),
      "The founder role, camera shots, fleet handoff, and physical errand are specified.",
      findHeading(markdown, /^### 2\.2 Founder's on-camera role and exact shot list\s*$/m),
    ),
    check(
      "formulation",
      Boolean(formulation)
        && /ASK → ACKNOWLEDGEMENT → REFINEMENT → RECEIPT/.test(formulation)
        && formulationIsOrdered
        && ["1. **ASK.**", "2. **ACKNOWLEDGEMENT.**", "3. **REFINEMENT.**", "4. **RECEIPT.**"]
          .every((step) => formulation.includes(step))
        && /exactly\s+one\**\s+clarifying question/.test(formulation),
      "The four step formulation is present in order with the one question rule.",
      findHeading(markdown, /^### 2\.3 The formulation pattern\b.*$/m),
    ),
    check(
      "solo_kit",
      Boolean(kit) && ["### 3.1 Gear", "### 3.2 Capture", "### 3.3 Edit + template", "### 3.4 Captions", "### 3.5 Music / audio", "### 3.6 Pacing numbers", "### 3.7", "### 3.8 Receipts archive"]
        .every((heading) => kit.includes(heading)),
      "The solo gear, capture, edit, captions, audio, pacing, automation, human work, and receipts sections are present.",
      findHeading(markdown, /^## 3\. The solo production kit\s*$/m),
    ),
    check(
      "three_distinct_episode_briefs",
      briefs.count === 3
        && briefs.unique
        && ["EP001", "EP002", "EP003"].every((episode) => markdown.includes(episode))
        && ["Dain Bot", "Basin", "RevenueFloor"].every((product) => markdown.includes(product)),
      `Found ${briefs.count} distinct episode briefs: ${briefs.titles.join("; ") || "none"}.`,
      findHeading(markdown, /^## 4\. First three episode briefs\s*$/m),
    ),
  ];

  return {
    schema: "glowhum.nomoi-channel-format-check.v1",
    artifact: artifactPath,
    status: checks.every(({ status }) => status === "pass") ? "COMPLETE" : "INCOMPLETE",
    gate_remaining: "FOUNDER_ACCEPTANCE_OR_REAL_RUN",
    checks,
  };
}

export async function verifyChannelFormat(artifactPath = DEFAULT_ARTIFACT_PATH) {
  const contents = await fs.readFile(artifactPath);
  const result = inspectChannelFormat(contents.toString("utf8"), artifactPath);
  return {
    ...result,
    bytes: contents.length,
    sha256: crypto.createHash("sha256").update(contents).digest("hex"),
  };
}

async function main() {
  const requestedPath = process.argv[2] || process.env.NOMOI_CHANNEL_FORMAT_PATH || DEFAULT_ARTIFACT_PATH;
  try {
    const result = await verifyChannelFormat(path.resolve(requestedPath));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "COMPLETE" ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({
      schema: "glowhum.nomoi-channel-format-check.v1",
      artifact: path.resolve(requestedPath),
      status: "MISSING_ARTIFACT",
      error: error.code === "ENOENT" ? "The canonical channel format file was not found." : error.message,
    }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
