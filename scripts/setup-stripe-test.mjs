#!/usr/bin/env node

const OFFER = Object.freeze({
  marker: "glowhum_one_episode_v1",
  productName: "Glowhum One Episode",
  productDescription: "One long form episode and three vertical cuts from your topic or report.",
  lookupKey: "glowhum_one_episode_199_aed_test_v1",
  currency: "aed",
  unitAmount: 19_900,
});

const API_BASE = process.env.NODE_ENV === "test"
  ? process.env.STRIPE_API_BASE_URL || "https://api.stripe.com/v1"
  : "https://api.stripe.com/v1";

function args(argv) {
  const values = new Set(argv);
  return {
    apply: values.has("--apply"),
    confirm: argv.find((value) => value.startsWith("--confirm="))?.slice("--confirm=".length) || "",
  };
}

function plan() {
  return {
    mode: "dry-run",
    network_calls: 0,
    mutation_calls: 0,
    offer: OFFER,
    apply_gate: `Run with --apply --confirm=${OFFER.marker} and a test Stripe key.`,
    live_keys_allowed: false,
    webhook_events: ["checkout.session.completed", "charge.refunded"],
  };
}

function form(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }
  return body;
}

async function stripe(key, method, resource, values, idempotencyKey) {
  const response = await fetch(`${API_BASE}${resource}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? form(values) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `Stripe returned HTTP ${response.status}`);
  return json;
}

async function listAll(key, resource) {
  const rows = [];
  let startingAfter = "";
  for (;;) {
    const query = form({ limit: 100, starting_after: startingAfter || undefined });
    const page = await stripe(key, "GET", `/${resource}?${query}`);
    rows.push(...(page.data || []));
    if (!page.has_more || !page.data?.length) return rows;
    startingAfter = page.data.at(-1).id;
  }
}

function oneOrNone(rows, label) {
  if (rows.length > 1) throw new Error(`Refusing ambiguous Stripe state. ${rows.length} ${label} records match.`);
  return rows[0] || null;
}

function matchingProduct(value) {
  return value?.metadata?.glowhum_product === OFFER.marker && value?.metadata?.is_test === "true";
}

function validProduct(product) {
  return matchingProduct(product) && product.active !== false && product.name === OFFER.productName;
}

function validPrice(price, productId) {
  return price?.active !== false
    && price.type === "one_time"
    && price.lookup_key === OFFER.lookupKey
    && price.currency === OFFER.currency
    && price.unit_amount === OFFER.unitAmount
    && (typeof price.product === "string" ? price.product : price.product?.id) === productId
    && price.metadata?.glowhum_product === OFFER.marker
    && price.metadata?.is_test === "true";
}

async function apply() {
  const input = args(process.argv.slice(2));
  if (!input.apply) return console.log(JSON.stringify(plan(), null, 2));
  if (input.confirm !== OFFER.marker) throw new Error(`Apply requires --confirm=${OFFER.marker}.`);
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!/^(sk|rk)_test_/.test(key)) throw new Error("STRIPE_SECRET_KEY must be a Stripe test key. Live keys are refused.");

  const products = await listAll(key, "products");
  let product = oneOrNone(products.filter(matchingProduct), "product");
  let productOperation = "reused";
  if (product && !validProduct(product)) throw new Error("The existing Glowhum test product conflicts with the pinned offer.");
  if (!product) {
    product = await stripe(key, "POST", "/products", {
      name: OFFER.productName,
      description: OFFER.productDescription,
      "metadata[glowhum_product]": OFFER.marker,
      "metadata[is_test]": "true",
    }, "glowhum-test-product-v1");
    productOperation = "created";
  }

  const prices = await listAll(key, "prices");
  let price = oneOrNone(prices.filter((value) => value.lookup_key === OFFER.lookupKey), "price");
  let priceOperation = "reused";
  if (price && !validPrice(price, product.id)) throw new Error("The existing Glowhum test price conflicts with the pinned offer.");
  if (!price) {
    price = await stripe(key, "POST", "/prices", {
      product: product.id,
      currency: OFFER.currency,
      unit_amount: OFFER.unitAmount,
      lookup_key: OFFER.lookupKey,
      nickname: "Glowhum one episode test",
      "metadata[glowhum_product]": OFFER.marker,
      "metadata[is_test]": "true",
    }, "glowhum-test-price-199-aed-v1");
    priceOperation = "created";
  }

  const productReadback = await stripe(key, "GET", `/products/${encodeURIComponent(product.id)}`);
  const priceReadback = await stripe(key, "GET", `/prices/${encodeURIComponent(price.id)}`);
  if (!validProduct(productReadback) || !validPrice(priceReadback, product.id)) {
    throw new Error("Stripe readback did not match the Glowhum test offer.");
  }

  console.log(JSON.stringify({
    mode: "apply-test",
    product: { id: product.id, operation: productOperation, verified: true },
    price: {
      id: price.id,
      operation: priceOperation,
      verified: true,
      currency: OFFER.currency,
      unit_amount: OFFER.unitAmount,
    },
    app_configuration: { STRIPE_PRICE_ID: price.id },
    webhook_events: ["checkout.session.completed", "charge.refunded"],
    live_activation: false,
  }, null, 2));
}

apply().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
