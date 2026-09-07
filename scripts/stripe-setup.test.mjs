import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const script = new URL("./setup-stripe-test.mjs", import.meta.url);

function run(args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script.pathname, ...args], {
      env: { PATH: process.env.PATH || "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("Stripe test offer setup defaults to a zero network dry run and refuses live keys", async () => {
  const dryRun = await run();
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const plan = JSON.parse(dryRun.stdout);
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.network_calls, 0);
  assert.equal(plan.mutation_calls, 0);
  assert.equal(plan.offer.unitAmount, 19_900);
  assert.equal(plan.live_keys_allowed, false);

  const refused = await run(["--apply", "--confirm=glowhum_one_episode_v1"], {
    STRIPE_SECRET_KEY: ["sk", "live", "value_must_never_be_used"].join("_"),
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Live keys are refused/);
});

test("Stripe test offer setup creates one pinned product and price then verifies readback", async () => {
  const calls = [];
  const product = {
    id: "prod_test_glowhum",
    object: "product",
    active: true,
    name: "Glowhum One Episode",
    metadata: { glowhum_product: "glowhum_one_episode_v1", is_test: "true" },
  };
  const price = {
    id: "price_test_glowhum",
    object: "price",
    active: true,
    type: "one_time",
    lookup_key: "glowhum_one_episode_199_aed_test_v1",
    currency: "aed",
    unit_amount: 19_900,
    product: product.id,
    metadata: { glowhum_product: "glowhum_one_episode_v1", is_test: "true" },
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8"), idempotency: req.headers["idempotency-key"] });
    let response;
    if (req.method === "GET" && req.url.startsWith("/products?")) response = { data: [], has_more: false };
    else if (req.method === "POST" && req.url === "/products") response = product;
    else if (req.method === "GET" && req.url.startsWith("/prices?")) response = { data: [], has_more: false };
    else if (req.method === "POST" && req.url === "/prices") response = price;
    else if (req.method === "GET" && req.url === `/products/${product.id}`) response = product;
    else if (req.method === "GET" && req.url === `/prices/${price.id}`) response = price;
    else {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "unexpected fake request" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const result = await run(["--apply", "--confirm=glowhum_one_episode_v1"], {
      NODE_ENV: "test",
      STRIPE_SECRET_KEY: "sk_test_server_only",
      STRIPE_API_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.mode, "apply-test");
    assert.deepEqual(receipt.product, { id: product.id, operation: "created", verified: true });
    assert.equal(receipt.price.id, price.id);
    assert.equal(receipt.price.unit_amount, 19_900);
    assert.equal(receipt.app_configuration.STRIPE_PRICE_ID, price.id);
    assert.equal(receipt.live_activation, false);
    assert.equal(calls.filter((call) => call.method === "POST").length, 2);
    assert.equal(calls.find((call) => call.url === "/products").idempotency, "glowhum-test-product-v1");
    assert.equal(calls.find((call) => call.url === "/prices").idempotency, "glowhum-test-price-199-aed-v1");
    const priceBody = new URLSearchParams(calls.find((call) => call.url === "/prices").body);
    assert.equal(priceBody.get("currency"), "aed");
    assert.equal(priceBody.get("unit_amount"), "19900");
    assert.equal(priceBody.get("metadata[is_test]"), "true");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
