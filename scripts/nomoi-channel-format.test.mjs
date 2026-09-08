import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectChannelFormat, verifyChannelFormat, DEFAULT_ARTIFACT_PATH } from "./verify-nomoi-channel-format.mjs";

test("the canonical channel format covers the complete requested scope", async () => {
  const result = await verifyChannelFormat();
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.gate_remaining, "FOUNDER_ACCEPTANCE_OR_REAL_RUN");
  assert.equal(result.checks.length, 5);
  assert.ok(result.bytes > 0);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.artifact, DEFAULT_ARTIFACT_PATH);
});

test("the checker rejects a one episode substitute", () => {
  const result = inspectChannelFormat(`
## 2. The NOMOI channel format
THE RUN
### 2.1 Episode skeleton
THE ASK THE ACKNOWLEDGEMENT THE JAM THE REFINEMENT THE RECEIPT THE LEDGER Hard out
### 2.2 Founder's on-camera role and exact shot list
operator's boss Minimum 45% of runtime Inverted-hierarchy beat S0 A1 V1 S1 S2 S3 A2 S4 A3 A4 S5 A5
### 2.3 The formulation pattern for every demo
ASK → ACKNOWLEDGEMENT → REFINEMENT → RECEIPT
1. **ASK.** 2. **ACKNOWLEDGEMENT.** exactly one clarifying question
3. **REFINEMENT.** 4. **RECEIPT.**
## 3. The solo production kit
### 3.1 Gear
### 3.2 Capture
### 3.3 Edit + template
### 3.4 Captions
### 3.5 Music / audio
### 3.6 Pacing numbers
### 3.7 Automation
### 3.8 Receipts archive
## 4. First three episode briefs
### 4.1 EP001 Dain Bot
Outcome ASK JAM REFINEMENT RECEIPT one
`, "/tmp/one-episode-substitute.md");
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.checks.find((check) => check.id === "three_distinct_episode_briefs").status, "fail");
});

test("distinct episode content is required, not repeated headings", () => {
  const common = "Outcome ASK JAM REFINEMENT RECEIPT";
  const repeated = `## 4. First three episode briefs
### 4.1 EP001 Dain Bot
${common}
### 4.2 EP002 Basin
${common}
### 4.3 EP003 RevenueFloor
${common}
## 5. The floor`;
  const result = inspectChannelFormat(repeated, "/tmp/repeated-briefs.md");
  assert.equal(result.checks.find((check) => check.id === "three_distinct_episode_briefs").status, "fail");
});
