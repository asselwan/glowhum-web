import { test } from "node:test";
import assert from "node:assert/strict";
import { auditBrand } from "./verify-brand.mjs";

test("Glowhum assets and branded page routes agree with one record", async () => {
  const result = await auditBrand();
  assert.equal(result.ok, true);
  assert.equal(result.checks.filter((check) => !check.passed).length, 0);
  assert.equal(result.approval_complete, false);
  assert.deepEqual(result.gaps, [{
    asset: "logo",
    status: "unproven",
    detail: "No explicit approval source for the canonical Glowhum logo was found."
  }]);
  assert.equal(result.checks.some((check) => check.check === "canonical logo has a square icon viewBox" && !check.passed), false);
  assert.equal(result.checks.some((check) => check.check === "canonical logo has a readable icon silhouette" && !check.passed), false);
});

test("strict approval mode has a visible logo approval gap", async () => {
  const result = await auditBrand();
  assert.equal(result.approval_complete, false);
  assert.equal(result.gaps[0].asset, "logo");
});
