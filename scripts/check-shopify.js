// Verifies the Shopify half of the integration, on its own, with no OTP involved.
//
// Run this the moment your Admin API token is in .env:
//     npm run check-shopify
//
// It answers, in order, the questions that actually block Phase 2:
//   1. Is the token valid at all?
//   2. Does it have the scopes this integration needs?
//   3. Can it create a draft order your store will accept?
//   4. Does that draft order really show up in the admin?
//
// By default the test draft order is deleted again. Pass --keep to leave it so
// you can eyeball it in Orders > Drafts.

process.env.SHOPIFY_MOCK = "0";

const fetch = require("node-fetch");
const { config } = require("../lib/config");

const KEEP = process.argv.includes("--keep");
const variantArg = process.argv.find((a) => a.startsWith("--variant="));

const REQUIRED_SCOPES = ["write_draft_orders", "read_draft_orders", "write_orders", "read_orders"];
const NICE_TO_HAVE = ["read_products", "read_themes"];

// Shopify subsumes read_x into write_x: ask for both and access_scopes.json
// reports only write_x. Comparing the raw list would fail on scopes we do hold.
function hasScope(granted, want) {
  if (granted.includes(want)) return true;
  return want.startsWith("read_") && granted.includes("write_" + want.slice(5));
}

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// Paths starting with "/admin" are used verbatim (the scopes endpoint is not
// versioned); everything else is resolved against the versioned Admin API base.
async function api(method, path, body) {
  const url = path.startsWith("/admin")
    ? `https://${config.shopify.store}${path}`
    : `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": config.shopify.token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  console.log("\n\x1b[1mShopify connection check\x1b[0m\n");

  if (!config.shopify.store || !config.shopify.token) {
    console.log(red("  .env is missing SHOPIFY_STORE or SHOPIFY_ADMIN_TOKEN."));
    console.log("  Copy .env.example to .env and fill those two in first. See SETUP.md step 2.\n");
    process.exit(1);
  }
  console.log(`  Store: ${config.shopify.store}`);
  console.log(`  API version: ${config.shopify.apiVersion}\n`);

  // --- 1. token valid? ---
  const shop = await api("GET", "/shop.json");
  if (shop.status === 401 || shop.status === 403) {
    console.log(red("  FAIL  Token rejected (401/403)."));
    console.log("        The token is wrong, or the app was never installed on the store.");
    console.log("        Re-run `npm run get-token` to mint a fresh one (SETUP.md step 6a).\n");
    process.exit(1);
  }
  if (!shop.ok) {
    console.log(red(`  FAIL  Unexpected ${shop.status} from /shop.json: ${shop.text.slice(0, 300)}`));
    process.exit(1);
  }
  console.log(green(`  PASS  Token is valid — connected to "${shop.json.shop.name}"`));
  console.log(`        Store currency: ${shop.json.shop.currency}  |  Country: ${shop.json.shop.country_name}`);
  if (shop.json.shop.currency !== "RSD") {
    console.log(yellow(`        NOTE  Store currency is ${shop.json.shop.currency}, not RSD. OTP settles in RSD —`));
    console.log(yellow("              confirm which currency the payment request must carry."));
  }

  // --- 2. scopes ---
  const scopesRes = await api("GET", "/admin/oauth/access_scopes.json");
  let granted = [];
  if (scopesRes.ok && Array.isArray(scopesRes.json.access_scopes)) {
    granted = scopesRes.json.access_scopes.map((s) => s.handle);
    const missing = REQUIRED_SCOPES.filter((s) => !hasScope(granted, s));
    if (missing.length) {
      console.log(red(`  FAIL  Missing required scopes: ${missing.join(", ")}`));
      console.log("        Add them in the Shopify Dev Dashboard > your app > API access,");
      console.log("        then SAVE and reinstall the app on the store.\n");
      process.exit(1);
    }
    console.log(green(`  PASS  All required scopes granted (${REQUIRED_SCOPES.join(", ")})`));
    console.log(`        Reported by Shopify: ${granted.join(", ")}`);
    const missingNice = NICE_TO_HAVE.filter((s) => !hasScope(granted, s));
    if (missingNice.length) {
      console.log(yellow(`        Optional scope not granted: ${missingNice.join(", ")} (only used by this script)`));
    }
  } else {
    console.log(yellow("  SKIP  Could not read the scope list; continuing to the live test."));
  }

  // --- 3. find a variant to test with ---
  let variantId = variantArg ? variantArg.split("=")[1] : null;
  let variantLabel = "(supplied on the command line)";
  if (!variantId) {
    const products = await api("GET", "/products.json?limit=1&status=active");
    const variant = products.ok && products.json.products?.[0]?.variants?.[0];
    if (variant) {
      variantId = variant.id;
      variantLabel = `${products.json.products[0].title} — ${variant.title} @ ${variant.price}`;
    }
  }

  // A draft order accepts a custom line item (title + price, no variant), so an
  // empty catalog does not block this check. Real checkouts always carry a
  // variant_id; this path only exercises the API round-trip.
  const lineItem = variantId
    ? { variant_id: Number(variantId), quantity: 1 }
    : { title: "OTP connection test", price: "100.00", quantity: 1 };

  if (variantId) {
    console.log(`\n  Testing with variant ${variantId}: ${variantLabel}`);
  } else {
    console.log(yellow("\n  No active product in the store — testing with a custom line item instead."));
    console.log(yellow("  Add a product before testing the real storefront checkout flow."));
  }

  // --- 4. create a real draft order ---
  const created = await api("POST", "/draft_orders.json", {
    draft_order: {
      line_items: [lineItem],
      // example.com is IANA-reserved and passes Shopify's domain validation;
      // example.rs is not a registered domain and gets rejected with a 422.
      email: "test@example.com",
      note: "TEST draft order created by npm run check-shopify — safe to delete",
      tags: "otp-connection-test",
    },
  });

  if (!created.ok) {
    console.log(red(`  FAIL  Draft order creation returned ${created.status}`));
    console.log(`        ${created.text.slice(0, 500)}`);
    if (created.status === 422) {
      console.log("        422 usually means the variant is out of stock, unpublished, or the id is wrong.");
    }
    console.log("");
    process.exit(1);
  }

  const draft = created.json.draft_order;
  console.log(green("  PASS  Draft order created"));
  console.log(`        id:       ${draft.id}`);
  console.log(`        total:    ${draft.total_price} ${draft.currency}`);
  console.log(`        status:   ${draft.status}`);
  console.log(`        admin:    https://${config.shopify.store.replace(".myshopify.com", "")}.myshopify.com/admin/draft_orders/${draft.id}`);

  // --- 5. read it back ---
  const readBack = await api("GET", `/draft_orders/${draft.id}.json`);
  console.log(readBack.ok ? green("  PASS  Draft order reads back correctly") : red("  FAIL  Could not read the draft order back"));

  if (KEEP) {
    console.log(yellow(`\n  Left draft order ${draft.id} in place (--keep). Delete it manually when done.`));
  } else {
    const del = await api("DELETE", `/draft_orders/${draft.id}.json`);
    console.log(del.ok ? green("  PASS  Test draft order cleaned up") : yellow("  WARN  Could not delete the test draft order — remove it manually"));
  }

  console.log(green("\n  Shopify half is working. Phase 2 done.\n"));
}

main().catch((err) => {
  console.error(red(`\n  Crashed: ${err.message}\n`));
  process.exit(1);
});
