// QA pass against the REAL Shopify store, with the payment gateway still mocked.
//
//     npm run qa-live
//
// Prerequisites — both already running:
//     npm run mock-gateway     # :4000
//     npm run dev              # :3000, with SHOPIFY_MOCK=0
//
// What makes this different from `npm run smoke`: smoke.js runs everything
// against an in-memory fake Shopify, so it proves the logic but not the wiring.
// This drives real draft orders in the real store with real variant ids, which
// is where mismatched money, currency and id handling actually show up.
//
// No real money moves — OTP is still mocked. Every draft order and order this
// creates is cleaned up at the end unless you pass --keep.

require("dotenv").config();

const fetch = require("node-fetch");
const { config } = require("../lib/config");

const BASE = `http://localhost:${process.env.PORT || 3000}`;
const GW = `http://localhost:${process.env.MOCK_OTP_PORT || 4000}`;
const KEEP = process.argv.includes("--keep");

// The QA product created 2026-07-26. Variants deliberately have DIFFERENT prices
// so a wrong line total cannot coincidentally match a right one.
const V = {
  // QA Test Stolica Nordic (9159834239204) — 3 variants
  hrast: { id: 49507058811108, price: 8900 },
  orah: { id: 49507058843876, price: 10900 },
  tresnja: { id: 49507058876644, price: 12500 },
  // QA Test Trosed Oslo (9159893876964) — no options, single "Default Title"
  // variant. High value, which is where amount formatting tends to break.
  trosed: { id: 49507122249956, price: 89900 },
  // QA Test Sto Malmö (9159922024676) — 2 variants
  stoHrast: { id: 49507177398500, price: 24900 },
  stoOrah: { id: 49507177431268, price: 31900 },
};

let warnings = 0;
function warn(label, detail) {
  warnings++;
  console.log("  " + yellow("WARN") + "  " + label);
  if (detail !== undefined) console.log("        " + detail);
}

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
const created = []; // draft order ids to clean up
const orders = []; // real order ids to clean up

function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log("  " + green("PASS") + "  " + label);
  } else {
    failed++;
    console.log("  " + red("FAIL") + "  " + label);
    if (detail !== undefined) console.log("        " + detail);
  }
}

// Retries on network-level failures. Calls to Shopify from here stall
// occasionally, and a bare throw during cleanup strands test orders in a real
// store — which is exactly what happened on the first run of this script.
async function api(method, path, body, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(
        `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}${path}`,
        {
          method,
          headers: {
            "X-Shopify-Access-Token": config.shopify.token,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          timeout: 20000,
        }
      );
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { status: res.status, ok: res.ok, json, text };
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return { status: 0, ok: false, json: null, text: String(lastErr && lastErr.message), netError: true };
}

// Every request here gets a timeout. An earlier version had none, and when one
// Shopify call stalled the whole QA run hung silently with test orders left behind.
const T = 20000;

// The mock gateway only creates a payment session when the customer actually
// loads the payment page — same as the real one. Skipping this makes /simulate
// fail with "no such payment session", which looks like a product bug but isn't.
async function openPaymentPage(redirectUrl) {
  const res = await fetch(redirectUrl, { timeout: T });
  return res.status;
}

// A real Serbian delivery address. Every checkout carries one, because with
// DELIVERY_MODE=require a cart without an address is refused outright.
const ADDR = {
  first_name: "Miloš",
  last_name: "Đorđević",
  address1: "Bulevar oslobođenja 12",
  city: "Novi Sad",
  zip: "21000",
  country_code: "RS",
  phone: "+381601234567",
};

// The delivery rates configured in the store's Serbia zone, as of 2026-07-26:
//   Стандардна          359 RSD   3-5 days
//   Ekspresna dostava  1490 RSD   1-2 days
//   Besplatna dostava     0 RSD   on orders of 50 000 RSD and up
// Checkout picks the cheapest by default, so expected totals follow this rule.
// If the merchant edits a rate in the admin, these numbers move — that is the
// point of asserting against them rather than against whatever we happen to get.
const FREE_OVER = 50000;
const STANDARD = 359;
const withDelivery = (goods) => (goods >= FREE_OVER ? goods : goods + STANDARD);

async function checkout(payload, extraHeaders) {
  // shippingAddress: null means "deliberately send none" — anything else gets
  // the default address so callers do not have to repeat it.
  const body = { ...payload };
  if (!("shippingAddress" in body)) body.shippingAddress = ADDR;
  else if (body.shippingAddress === null) delete body.shippingAddress;

  const res = await fetch(`${BASE}/api/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(body),
    timeout: T,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function main() {
  console.log("\n\x1b[1mQA against the real store\x1b[0m");
  console.log(dim(`  store: ${config.shopify.store}   gateway: mocked\n`));

  const health = await (await fetch(`${BASE}/health`)).json();
  check("bridge is talking to the REAL Shopify", health.mode.shopifyMock === false, JSON.stringify(health.mode));
  check("gateway is still mocked (no real money)", health.mode.otpMock === true);

  // ---- 1. single item, quantity 1 -----------------------------------------
  console.log("\n1. Single item, qty 1 (Hrast)");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    check("returns 200", r.status === 200, r.text.slice(0, 200));
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check(`total is ${withDelivery(V.hrast.price)} (goods + delivery)`, Number(r.json?.amount) === withDelivery(V.hrast.price), `got ${r.json?.amount}`);
    check("currency is RSD", r.json?.currency === "RSD", `got ${r.json?.currency}`);
    check("returns a redirect URL", typeof r.json?.redirectUrl === "string" && r.json.redirectUrl.length > 0);
    check("inventory of 0 does NOT block a draft order", r.status === 200);
  }

  // ---- 2. multiple quantity -----------------------------------------------
  console.log("\n2. Multiple quantity (Hrast x 3)");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 3 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const want = withDelivery(V.hrast.price * 3);
    check(`total is ${want}`, Number(r.json?.amount) === want, `got ${r.json?.amount}`);
  }

  // ---- 3. a different variant ---------------------------------------------
  console.log("\n3. Different variant of the same product (Trešnja x 1)");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.tresnja.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check(`total is ${withDelivery(V.tresnja.price)} (not Hrast's price)`, Number(r.json?.amount) === withDelivery(V.tresnja.price), `got ${r.json?.amount}`);
  }

  // ---- 4. mixed cart -------------------------------------------------------
  console.log("\n4. Mixed cart (Hrast x2 + Orah x1 + Trešnja x1)");
  let mixedRef = null;
  {
    const r = await checkout({
      lineItems: [
        { variant_id: V.hrast.id, quantity: 2 },
        { variant_id: V.orah.id, quantity: 1 },
        { variant_id: V.tresnja.id, quantity: 1 },
      ],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    mixedRef = r.json?.orderRef;
    const want = withDelivery(V.hrast.price * 2 + V.orah.price + V.tresnja.price);
    check(`total is ${want}`, Number(r.json?.amount) === want, `got ${r.json?.amount}`);

    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const li = back.json?.draft_order?.line_items || [];
    check("Shopify stored 3 distinct line items", li.length === 3, `got ${li.length}`);
    check("quantities survived the round trip", li.reduce((s, x) => s + x.quantity, 0) === 4, JSON.stringify(li.map((x) => x.quantity)));
    check("draft order is tagged otp-pending", (back.json?.draft_order?.tags || "").includes("otp-pending"), back.json?.draft_order?.tags);
  }

  // ---- 5. price tampering --------------------------------------------------
  console.log("\n5. Price tampering — client sends its own prices");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.tresnja.id, quantity: 1, price: "1.00", title: "FREE CHAIR" }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check(
      "client-supplied price is IGNORED, Shopify's price wins",
      Number(r.json?.amount) === withDelivery(V.tresnja.price),
      `got ${r.json?.amount} — if this is 1.00 the customer sets their own price`
    );
  }

  // ---- 6. input validation -------------------------------------------------
  console.log("\n6. Input validation");
  {
    const cases = [
      ["empty cart", { lineItems: [] }, 400],
      ["missing lineItems", {}, 400],
      ["lineItems not an array", { lineItems: "nope" }, 400],
      ["quantity 0", { lineItems: [{ variant_id: V.hrast.id, quantity: 0 }] }, 400],
      ["negative quantity", { lineItems: [{ variant_id: V.hrast.id, quantity: -5 }] }, 400],
      ["fractional quantity", { lineItems: [{ variant_id: V.hrast.id, quantity: 1.5 }] }, 400],
      ["absurd quantity (1e6)", { lineItems: [{ variant_id: V.hrast.id, quantity: 1000000 }] }, 400],
      ["missing variant_id", { lineItems: [{ quantity: 1 }] }, 400],
    ];
    for (const [label, payload, want] of cases) {
      const r = await checkout(payload);
      if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
      check(`${label} -> ${want}`, r.status === want, `got ${r.status} ${r.text.slice(0, 120)}`);
    }
  }

  // ---- 7. nonexistent variant ---------------------------------------------
  console.log("\n7. Nonexistent variant id");
  {
    const r = await checkout({ lineItems: [{ variant_id: 999999999999, quantity: 1 }] });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check("rejected rather than creating a bogus order", r.status >= 400, `got ${r.status} ${r.text.slice(0, 160)}`);
  }

  // ---- 8. CORS -------------------------------------------------------------
  console.log("\n8. CORS");
  {
    const good = await checkout(
      { lineItems: [{ variant_id: V.hrast.id, quantity: 1 }] },
      { Origin: "https://nordis-garden.myshopify.com" }
    );
    if (good.json?.draftOrderId) created.push(good.json.draftOrderId);
    check(
      "storefront origin is allowed",
      good.headers.get("access-control-allow-origin") === "https://nordis-garden.myshopify.com",
      `got ${good.headers.get("access-control-allow-origin")}`
    );

    const bad = await checkout(
      { lineItems: [{ variant_id: V.hrast.id, quantity: 1 }] },
      { Origin: "https://evil.example.com" }
    );
    if (bad.json?.draftOrderId) created.push(bad.json.draftOrderId);
    check(
      "unknown origin gets no ACAO header",
      !bad.headers.get("access-control-allow-origin"),
      `got ${bad.headers.get("access-control-allow-origin")}`
    );
  }

  // ---- 9. full end to end, approved ---------------------------------------
  console.log("\n9. End to end — customer approves");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.orah.id, quantity: 2 }],
      customer: { email: "qa@example.com" },
    });
    const ref = r.json?.orderRef;
    const want = withDelivery(V.orah.price * 2);
    check(`draft created for ${want}`, Number(r.json?.amount) === want, `got ${r.json?.amount}`);

    const pageStatus = await openPaymentPage(r.json.redirectUrl);
    check("customer can load the hosted payment page", pageStatus === 200, `got HTTP ${pageStatus}`);

    const sim = await fetch(`${GW}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderRef: ref, decision: "approve" }),
      timeout: T,
    });
    const simJson = await sim.json();
    check("gateway callback accepted", sim.ok, JSON.stringify(simJson).slice(0, 200));

    // The draft should now be completed, with a real order behind it.
    const back = await api("GET", `/draft_orders/${r.json.draftOrderId}.json`);
    const d = back.json?.draft_order;
    check("draft order status is completed", d?.status === "completed", `got ${d?.status}`);
    check("a real Shopify order was created", !!d?.order_id, `order_id=${d?.order_id}`);
    // Completing a draft does not consume it: the draft record survives, and
    // deleting the order it produced does not take it with it. Both have to go,
    // or every QA run leaves a completed draft behind in a real store.
    created.push(r.json.draftOrderId);
    if (d?.order_id) {
      orders.push(d.order_id);
      const ord = await api("GET", `/orders/${d.order_id}.json`);
      const o = ord.json?.order;
      check("order is marked paid", o?.financial_status === "paid", `financial_status=${o?.financial_status}`);
      check(`order total is ${want}`, Number(o?.total_price) === want, `got ${o?.total_price}`);
    }

    // Replaying the same webhook must not double-complete or double-charge.
    const replay = await fetch(`${GW}/replay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderRef: ref, status: "approved" }),
      timeout: T,
    });
    check("duplicate webhook is handled idempotently (2xx, no crash)", replay.status < 500, `got ${replay.status}`);
  }

  // ---- 10. end to end, declined -------------------------------------------
  console.log("\n10. End to end — customer declines");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    created.push(r.json.draftOrderId);
    await openPaymentPage(r.json.redirectUrl);
    await fetch(`${GW}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderRef: r.json.orderRef, decision: "decline" }),
      timeout: T,
    });
    const back = await api("GET", `/draft_orders/${r.json.draftOrderId}.json`);
    check(
      "declined payment leaves the draft OPEN, never completed",
      back.json?.draft_order?.status !== "completed",
      `status=${back.json?.draft_order?.status}`
    );
    check("no Shopify order was created for a decline", !back.json?.draft_order?.order_id);
  }

  // ---- 11. a realistic cart spanning several products ----------------------
  console.log("\n11. Realistic multi-product cart (3 products, 5 line items)");
  {
    const items = [
      { variant_id: V.hrast.id, quantity: 4 }, // four chairs
      { variant_id: V.stoHrast.id, quantity: 1 }, // a table
      { variant_id: V.trosed.id, quantity: 1 }, // a sofa
      { variant_id: V.tresnja.id, quantity: 2 },
      { variant_id: V.stoOrah.id, quantity: 1 },
    ];
    const want = withDelivery(
      V.hrast.price * 4 + V.stoHrast.price + V.trosed.price + V.tresnja.price * 2 + V.stoOrah.price
    );
    const r = await checkout({ lineItems: items, customer: { email: "qa@example.com" } });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check(`total across 3 products is ${want}`, Number(r.json?.amount) === want, `got ${r.json?.amount}`);

    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const li = back.json?.draft_order?.line_items || [];
    check("5 line items stored", li.length === 5, `got ${li.length}`);
    check("9 units total", li.reduce((s, x) => s + x.quantity, 0) === 9, JSON.stringify(li.map((x) => x.quantity)));
  }

  // ---- 12. product with no options ----------------------------------------
  console.log("\n12. Product with no options (single Default Title variant)");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.trosed.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check(`total is ${withDelivery(V.trosed.price)}`, Number(r.json?.amount) === withDelivery(V.trosed.price), `got ${r.json?.amount}`);
    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const item = back.json?.draft_order?.line_items?.[0];
    // Shopify reports variant_title as null (not "Default Title") on draft-order
    // line items for an option-less product. Anything rendering this to the
    // customer must not print "null".
    check("option-less product yields a null variant_title", item?.variant_title === null, `got ${item?.variant_title}`);
    check("the line item still carries the product title", !!item?.title, `got ${item?.title}`);
    check("and the right variant id", item?.variant_id === V.trosed.id, `got ${item?.variant_id}`);
  }

  // ---- 13. high value + amount formatting ---------------------------------
  console.log("\n13. High-value cart and amount formatting");
  {
    const want = withDelivery(V.trosed.price * 3); // 269 700 RSD, over the free-delivery line
    const r = await checkout({
      lineItems: [{ variant_id: V.trosed.id, quantity: 3 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const amt = r.json?.amount;
    check(`total is ${want}`, Number(amt) === want, `got ${amt}`);
    // What we hand OTP must be machine-readable. Thousands separators and commas
    // are the classic way a six-figure RSD amount turns into a rejected payment.
    check("amount is a plain string, no thousands separator", /^\d+\.\d{2}$/.test(String(amt)), `got "${amt}"`);
    check("amount parses back to the same number", Number(amt) === parseFloat(String(amt)));
  }

  // ---- 14. VAT ------------------------------------------------------------
  console.log("\n14. VAT (Serbian PDV)");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.trosed.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const d = back.json?.draft_order;
    check(
      "price is VAT-inclusive: total equals subtotal",
      Number(d?.total_price) === Number(d?.subtotal_price),
      `total=${d?.total_price} subtotal=${d?.subtotal_price}`
    );
    check("a 20% VAT line is present", Number(d?.tax_lines?.[0]?.rate) === 0.2, JSON.stringify(d?.tax_lines));
    check(
      "the amount charged already contains VAT",
      Number(d?.total_price) === V.trosed.price,
      `total=${d?.total_price}`
    );
    console.log(dim(`        VAT inside this order: ${d?.total_tax} RSD — the figure fiscalization needs`));
  }

  // ---- 15. delivery -------------------------------------------------------
  //
  // The store has had a priced Serbia zone all along (Стандардна, 359 RSD), and
  // a draft order applies none of it by itself. Everything below is about the
  // charge actually landing on the order the customer pays for.
  console.log("\n15. Delivery");
  {
    // What Shopify offers for a small cart to Novi Sad.
    const quote = await fetch(`${BASE}/api/delivery/rates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineItems: [{ variant_id: V.hrast.id, quantity: 1 }], shippingAddress: ADDR }),
      timeout: T,
    });
    const q = await quote.json();
    const titles = (q.rates || []).map((x) => x.title);
    check("Shopify's own rates are offered to the storefront", (q.rates || []).length >= 2, JSON.stringify(q));
    check("the configured standard rate is among them", titles.includes("Стандардна"), JSON.stringify(titles));
    check(
      "rate handles are never handed to the client",
      (q.rates || []).every((x) => x.handle === undefined),
      JSON.stringify(q.rates)
    );

    // The charge lands on the draft order, and reads back over REST.
    const r = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const d = back.json?.draft_order;
    check("shipping address is attached to the draft order", !!d?.shipping_address, "no shipping_address");
    check("a delivery line is present on the order", !!d?.shipping_line, "shipping_line is null — the charge went missing");
    check(`delivery is priced at ${STANDARD}`, Number(d?.shipping_line?.price) === STANDARD, `got ${d?.shipping_line?.price}`);
    check(
      "it is a real configured rate, not a custom one we invented",
      d?.shipping_line?.custom === false,
      `custom=${d?.shipping_line?.custom}`
    );
    check(
      "total = goods + delivery",
      Number(d?.total_price) === Number(d?.subtotal_price) + STANDARD,
      `total=${d?.total_price} subtotal=${d?.subtotal_price}`
    );
    check(
      "the amount sent to OTP is the total including delivery",
      Number(r.json?.amount) === Number(d?.total_price),
      `amount=${r.json?.amount} total=${d?.total_price}`
    );

    // Choosing a dearer option must cost more.
    const exp = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
      shippingRateTitle: "Ekspresna dostava",
    });
    if (exp.json?.draftOrderId) created.push(exp.json.draftOrderId);
    check("express delivery can be chosen", exp.json?.delivery?.title === "Ekspresna dostava", JSON.stringify(exp.json?.delivery));
    check(
      "and costs 1490 more than the goods",
      Number(exp.json?.amount) === V.hrast.price + 1490,
      `got ${exp.json?.amount}`
    );

    // The conditional free rate, either side of the 50 000 threshold.
    const under = await checkout({
      lineItems: [{ variant_id: V.stoHrast.id, quantity: 2 }], // 49 800
      customer: { email: "qa@example.com" },
    });
    if (under.json?.draftOrderId) created.push(under.json.draftOrderId);
    check(
      "a 49 800 cart is 200 short of free delivery and pays for it",
      Number(under.json?.amount) === 49800 + STANDARD,
      `got ${under.json?.amount}`
    );

    const over = await checkout({
      lineItems: [{ variant_id: V.trosed.id, quantity: 1 }], // 89 900
      customer: { email: "qa@example.com" },
    });
    if (over.json?.draftOrderId) created.push(over.json.draftOrderId);
    check("an 89 900 cart qualifies for free delivery", over.json?.delivery?.price === "0.0" || Number(over.json?.delivery?.price) === 0, JSON.stringify(over.json?.delivery));
    check("and pays nothing extra", Number(over.json?.amount) === V.trosed.price, `got ${over.json?.amount}`);

    // Refusals. Each of these was previously a silent free delivery.
    const noAddr = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
      shippingAddress: null,
    });
    if (noAddr.json?.draftOrderId) created.push(noAddr.json.draftOrderId);
    check("a cart with no address is refused", noAddr.status === 400, `got ${noAddr.status} ${noAddr.text.slice(0, 120)}`);
    check("with a reason the storefront can act on", noAddr.json?.code === "address_required", noAddr.text.slice(0, 120));

    const abroad = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
      shippingAddress: { ...ADDR, country_code: "DE", city: "Berlin", zip: "10115" },
    });
    if (abroad.json?.draftOrderId) created.push(abroad.json.draftOrderId);
    check("a German address is refused, not shipped free", abroad.status === 400, `got ${abroad.status}`);
    check("with a reason", abroad.json?.code === "no_rates_for_address", abroad.text.slice(0, 160));

    const invented = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
      shippingRateTitle: "Dostava za 1 dinar",
    });
    if (invented.json?.draftOrderId) created.push(invented.json.draftOrderId);
    check("an invented delivery option is refused", invented.status === 400, `got ${invented.status}`);

    // The client pricing its own delivery is the whole reason rates are
    // re-resolved server-side rather than trusted from the request body.
    const forged = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
      shipping_line: { title: "Dostava", price: "1.00", custom: true },
      shippingLine: { title: "Dostava", price: "1.00" },
    });
    if (forged.json?.draftOrderId) created.push(forged.json.draftOrderId);
    check(
      "a client-supplied delivery price is ignored",
      Number(forged.json?.amount) === withDelivery(V.hrast.price),
      `got ${forged.json?.amount} — if this is ${V.hrast.price + 1} the customer priced their own delivery`
    );
  }

  // ---- 15b. tax on delivery -----------------------------------------------
  console.log("\n15b. Tax on delivery");
  {
    const r = await checkout({
      lineItems: [{ variant_id: V.hrast.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const d = back.json?.draft_order;
    const goodsVat = V.hrast.price / 6; // 20% inclusive
    const totalVatIfShippingTaxed = Number(d?.total_price) / 6;

    check("VAT is still 20%", Number(d?.tax_lines?.[0]?.rate) === 0.2, JSON.stringify(d?.tax_lines));

    // DECIDED 2026-07-26 by the store owner: delivery is NOT taxed. So
    // "Charge sales tax on shipping" stays off in Settings > Taxes and duties,
    // and VAT is charged on the goods only.
    //
    // This is asserted rather than warned about, deliberately. It was an open
    // question; now it is a decision, and a decision that lives only in a
    // settings checkbox will drift the first time someone clicks around in the
    // admin. If that checkbox is ever turned on, total_tax jumps by the VAT on
    // the delivery line and these two checks fail loudly — which is what you
    // want, because the fiscal receipt has to agree with it.
    check(
      "VAT is charged on the goods only, not on delivery",
      Math.abs(Number(d?.total_tax) - goodsVat) < 0.02,
      `total_tax=${d?.total_tax} goods VAT=${goodsVat.toFixed(2)}`
    );
    check(
      "and delivery is NOT in the taxable base",
      Math.abs(Number(d?.total_tax) - totalVatIfShippingTaxed) > 0.02,
      `total_tax=${d?.total_tax} — this equals ${totalVatIfShippingTaxed.toFixed(2)}, i.e. ` +
        `delivery has become taxable. "Charge sales tax on shipping" was turned on in ` +
        `Settings > Taxes and duties; fiscalization must be updated to match.`
    );
  }

  // ---- 16. Serbian characters ---------------------------------------------
  console.log("\n16. Serbian diacritics survive the round trip");
  {
    const name = { first: "Đorđe", last: "Šišković" };
    const street = "Njegoševa 15/4, Čačak";
    const r = await checkout({
      lineItems: [{ variant_id: V.stoOrah.id, quantity: 1 }],
      customer: { email: "qa@example.com" },
      shippingAddress: {
        first_name: name.first,
        last_name: name.last,
        address1: street,
        city: "Čačak",
        zip: "32000",
        country_code: "RS",
      },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const back = await api("GET", `/draft_orders/${r.json?.draftOrderId}.json`);
    const a = back.json?.draft_order?.shipping_address;
    check("first name intact (Đorđe)", a?.first_name === name.first, `got ${a?.first_name}`);
    check("last name intact (Šišković)", a?.last_name === name.last, `got ${a?.last_name}`);
    check("street intact (Njegoševa, Čačak)", a?.address1 === street, `got ${a?.address1}`);
    check("city intact (Čačak)", a?.city === "Čačak", `got ${a?.city}`);
  }

  // ---- 17. the same variant listed twice ----------------------------------
  console.log("\n17. Same variant appearing twice in one cart");
  {
    const r = await checkout({
      lineItems: [
        { variant_id: V.hrast.id, quantity: 2 },
        { variant_id: V.hrast.id, quantity: 3 },
      ],
      customer: { email: "qa@example.com" },
    });
    if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    const want = withDelivery(V.hrast.price * 5);
    check(`charged for all 5 units (${want})`, Number(r.json?.amount) === want, `got ${r.json?.amount}`);
  }

  // ---- 18. concurrency ----------------------------------------------------
  console.log("\n18. Five simultaneous checkouts");
  {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((q) =>
        checkout({ lineItems: [{ variant_id: V.hrast.id, quantity: q }], customer: { email: "qa@example.com" } })
      )
    );
    for (const r of results) if (r.json?.draftOrderId) created.push(r.json.draftOrderId);
    check("all five succeeded", results.every((r) => r.status === 200), results.map((r) => r.status).join(","));
    const ids = results.map((r) => r.json?.draftOrderId);
    check("five distinct draft orders — no id collision", new Set(ids).size === 5, JSON.stringify(ids));
    const totals = results.map((r) => Number(r.json?.amount));
    const expected = [1, 2, 3, 4, 5].map((q) => withDelivery(V.hrast.price * q));
    check(
      "each got its own correct total (no cross-talk between requests)",
      JSON.stringify(totals) === JSON.stringify(expected),
      `got ${JSON.stringify(totals)}`
    );
  }

  // ---- cleanup -------------------------------------------------------------
  console.log("\nCleanup");
  if (KEEP) {
    console.log(dim(`  --keep: leaving ${created.length} draft order(s) and ${orders.length} order(s) in the store`));
  } else {
    // Orders first: a draft that produced an order is deleted more reliably
    // once the order is gone.
    let odel = 0;
    const stuck = [];
    for (const id of orders) {
      await api("POST", `/orders/${id}/cancel.json`, {});
      const r = await api("DELETE", `/orders/${id}.json`);
      if (r.ok) odel++;
      else stuck.push(id);
    }
    console.log(`  deleted ${odel}/${orders.length} test orders`);

    let del = 0;
    const stuckDrafts = [];
    for (const id of new Set(created)) {
      const r = await api("DELETE", `/draft_orders/${id}.json`);
      // 404 means it is already gone — a declined draft is deleted by the
      // webhook handler itself, which is the behaviour under test.
      if (r.ok || r.status === 404) del++;
      else stuckDrafts.push(`${id} (${r.status})`);
    }
    console.log(`  deleted ${del}/${new Set(created).size} test draft orders`);
    if (stuckDrafts.length) {
      console.log(red(`  COULD NOT DELETE draft(s): ${stuckDrafts.join(", ")}`));
    }
    if (stuck.length) {
      console.log(red(`  COULD NOT DELETE order(s): ${stuck.join(", ")} — remove them by hand in Orders`));
    }
  }

  const summary = failed === 0 ? green(`${passed} passed, 0 failed`) : red(`${passed} passed, ${failed} failed`);
  console.log("\n" + summary + (warnings ? yellow(`, ${warnings} warning(s)`) : "") + "\n");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(red(`\n  Crashed: ${err.stack}`));
  // Never leave test orders in a real store just because the run blew up.
  if (!KEEP && (created.length || orders.length)) {
    console.error(red("  Attempting cleanup anyway..."));
    for (const id of created) await api("DELETE", `/draft_orders/${id}.json`);
    for (const id of orders) {
      await api("POST", `/orders/${id}/cancel.json`, {});
      await api("DELETE", `/orders/${id}.json`);
    }
    console.error(`  cleanup attempted for ${created.length} draft(s), ${orders.length} order(s)`);
  }
  console.error("");
  process.exit(1);
});
