// End-to-end smoke test of the payment flow against the mocks.
//
// Run: npm run smoke
//
// This is the suite that has to stay green. When OTP's real spec lands you change
// lib/otp-adapter.js and re-run this; when their sandbox is reachable you flip
// OTP_MOCK=0 and run the same cases against real test cards.
//
// Cases covered:
//   1. happy path            -> draft order becomes a paid Shopify order
//   2. duplicate callback    -> second delivery is a no-op, not a double order
//   3. declined payment      -> no orphaned draft order left behind
//   4. abandoned payment     -> draft order stays open and IS detectable as stale
//   5. forged signature      -> rejected with 400
//   6. tampered amount       -> rejected with 400
//   7. unknown order         -> rejected with 400, not retried forever
//   8. the STATUS PAGE       -> tells the customer the truth in each of those cases
//   9. gateway restart       -> an already-open payment page still works
//  10. input validation      -> junk carts rejected

// Force mock mode regardless of what's in .env — this test must never touch a
// real store or a real gateway.
process.env.SHOPIFY_MOCK = "1";
process.env.OTP_MOCK = "1";
process.env.PORT = process.env.SMOKE_PORT || "3999";
process.env.MOCK_OTP_PORT = process.env.SMOKE_MOCK_PORT || "4999";
process.env.APP_BASE_URL = `http://localhost:${process.env.PORT}`;
process.env.OTP_GATEWAY_URL = `http://localhost:${process.env.MOCK_OTP_PORT}/pay`;
process.env.OTP_SECRET_KEY = "smoke-test-secret";
process.env.OTP_MERCHANT_ID = "SMOKE_MERCHANT";

const fetch = require("node-fetch");
const app = require("../server");
const gateway = require("../mock-otp/gateway");
const shopify = require("../lib/shopify");
const otp = require("../lib/otp-adapter");
const audit = require("../lib/audit");

const BASE = process.env.APP_BASE_URL;
const GW = `http://localhost:${process.env.MOCK_OTP_PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n          ${detail}` : ""}`);
    failed++;
  }
}

const post = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

// Every checkout carries an address now: with DELIVERY_MODE=require (the
// default) a cart with no address is refused rather than shipped for free.
const ADDRESS = {
  first_name: "Miloš",
  last_name: "Đorđević",
  address1: "Bulevar oslobođenja 12",
  city: "Novi Sad",
  zip: "21000",
  country_code: "RS",
  phone: "+381601234567",
};

async function startCheckout(qty = 2) {
  const res = await post(`${BASE}/api/checkout`, {
    lineItems: [{ variant_id: 4200000001, quantity: qty }],
    customer: { email: "kupac@example.com" },
    shippingAddress: ADDRESS,
  });
  if (!res.ok) throw new Error(`checkout failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // Follow the redirect the browser would follow — this is what registers the
  // session with the gateway and validates our request signature.
  const page = await fetch(data.redirectUrl);
  if (!page.ok) throw new Error(`gateway rejected the payment request: ${await page.text()}`);
  return data;
}

async function run() {
  console.log("\n\x1b[1mOTP <-> Shopify payment flow — smoke test\x1b[0m");
  console.log(`  app:     ${BASE}`);
  console.log(`  gateway: ${GW}  (MOCK — no real money)\n`);

  // --- 0. health ---
  const health = await (await fetch(`${BASE}/health`)).json();
  check("health endpoint reports no config errors", health.errors.length === 0, JSON.stringify(health.errors));

  // --- 1. happy path ---
  console.log("\n1. Successful payment");
  const c1 = await startCheckout(2);
  check("draft order created with a total", Number(c1.amount) > 0, `amount=${c1.amount}`);
  const r1 = await (await post(`${GW}/simulate`, { orderRef: c1.orderRef, decision: "approve" })).json();
  check("gateway callback accepted with 200", r1.callbackStatus === 200, `got ${r1.callbackStatus} ${r1.callbackBody}`);
  const d1 = await shopify.getDraftOrder(c1.orderRef);
  check("draft order is now completed", d1.status === "completed", `status=${d1.status}`);
  check("a real Shopify order id was produced", !!d1.order_id);

  // Without this the only record of which OTP payment paid for an order is our
  // audit log, keyed by draft-order id — useless during a chargeback or a
  // month-end reconciliation against OTP's settlement report.
  const ann = shopify._annotationFor(d1.order_id);
  check("the OTP transaction id is stamped on the order", !!ann && !!ann.transactionId, JSON.stringify(ann));
  check("the order ref is stamped too", !!ann && String(ann.orderRef) === String(c1.orderRef), JSON.stringify(ann));
  check("and the order is retagged otp-paid", !!ann && ann.tags === "otp-paid", JSON.stringify(ann));

  // --- 2. duplicate callback ---
  console.log("\n2. Duplicate callback (gateway retry)");
  const r2 = await (await post(`${GW}/replay`, { orderRef: c1.orderRef, status: "approved" })).json();
  check("replayed callback still returns 200", r2.callbackStatus === 200, `got ${r2.callbackStatus}`);
  check("and is recognised as already processed", /already processed/.test(r2.callbackBody), r2.callbackBody);

  // --- 3. declined ---
  console.log("\n3. Declined payment");
  const c3 = await startCheckout(1);
  const r3 = await (await post(`${GW}/simulate`, { orderRef: c3.orderRef, decision: "decline" })).json();
  check("declined callback acknowledged", r3.callbackStatus === 200, `got ${r3.callbackStatus}`);
  let orphan = false;
  try {
    await shopify.getDraftOrder(c3.orderRef);
    orphan = true;
  } catch {
    orphan = false;
  }
  check("no orphaned draft order left in the admin", !orphan);

  // --- 4. abandoned ---
  console.log("\n4. Abandoned payment (customer closes the tab)");
  const c4 = await startCheckout(1);
  await post(`${GW}/simulate`, { orderRef: c4.orderRef, decision: "abandon" });
  const d4 = await shopify.getDraftOrder(c4.orderRef);
  check("draft order stays open (never silently marked paid)", d4.status === "open", `status=${d4.status}`);
  check(
    "and is tagged so stale drafts can be swept later",
    (d4.tags || "").includes("otp-pending"),
    `tags=${d4.tags}`
  );

  // --- 5. forged signature ---
  console.log("\n5. Forged callback signature");
  const c5 = await startCheckout(1);
  const forged = await post(`${BASE}/api/otp/webhook`, {
    merchantId: "SMOKE_MERCHANT",
    orderRef: c5.orderRef,
    amount: c5.amount,
    currency: c5.currency,
    status: "approved",
    transactionId: "FORGED",
    signature: "deadbeef",
  });
  check("forged signature rejected with 400", forged.status === 400, `got ${forged.status}`);
  const d5 = await shopify.getDraftOrder(c5.orderRef);
  check("forged callback did not complete the order", d5.status === "open", `status=${d5.status}`);

  // --- 6. tampered amount ---
  console.log("\n6. Correctly signed callback with the wrong amount");
  const c6 = await startCheckout(1);
  const tampered = {
    merchantId: "SMOKE_MERCHANT",
    orderRef: c6.orderRef,
    amount: "1.00", // customer pays 1 RSD for a 1200 RSD order
    currency: c6.currency,
    status: "approved",
    transactionId: "TAMPERED",
  };
  tampered.signature = otp._sign(tampered, otp._CALLBACK_SIGNATURE_FIELDS);
  const tamperRes = await post(`${BASE}/api/otp/webhook`, tampered);
  check("amount mismatch rejected with 400", tamperRes.status === 400, `got ${tamperRes.status}`);
  const d6 = await shopify.getDraftOrder(c6.orderRef);
  check("underpaid order was not completed", d6.status === "open", `status=${d6.status}`);

  // --- 7. unknown order ---
  console.log("\n7. Callback for an order that doesn't exist");
  const ghost = {
    merchantId: "SMOKE_MERCHANT",
    orderRef: "999999999999",
    amount: "100.00",
    currency: "RSD",
    status: "approved",
    transactionId: "GHOST",
  };
  ghost.signature = otp._sign(ghost, otp._CALLBACK_SIGNATURE_FIELDS);
  const ghostRes = await post(`${BASE}/api/otp/webhook`, ghost);
  check("unknown order rejected with 400 (not retried forever)", ghostRes.status === 400, `got ${ghostRes.status}`);

  // --- 8. what the CUSTOMER actually sees --------------------------------
  // (printed as section 8; the two blocks below follow)
  // These assertions exist because the first version of this suite passed 18/18
  // while the status page was telling declined customers "we couldn't find this
  // order" and spinning forever on abandoned ones. Backend state being correct is
  // not the same as the customer being told the truth, and only the second one
  // determines whether they retry, double-pay, or file a chargeback.
  console.log("\n8. Customer-facing order status page");

  // redirect:"manual" so a paid order — which now redirects to Shopify — does
  // not send this offline test out to the internet chasing the Location header.
  const statusOf = async (ref) =>
    (await fetch(`${BASE}/order-status?ref=${ref}`, { redirect: "manual" })).text();

  // A paid order no longer renders a confirmation here at all: it hands the
  // customer to Shopify's own order-status page (asserted in §8b). What matters
  // for this section is that it does NOT sit on one of our pages.
  const paidRes = await fetch(`${BASE}/order-status?ref=${c1.orderRef}`, { redirect: "manual" });
  check("paid order is handed off, not rendered by us", paidRes.status >= 300 && paidRes.status < 400, `got ${paidRes.status}`);
  check("paid order does NOT auto-refresh", !/http-equiv="refresh"/.test(await paidRes.text()));

  const declinedPage = await statusOf(c3.orderRef);
  check("declined order says declined, not 'not found'", /odbila|declined/i.test(declinedPage), declinedPage.slice(0, 200));
  check("declined order tells them they were NOT charged", /nije naplaćen|not been charged/i.test(declinedPage));
  check("declined order offers a retry", /Pokušajte ponovo|Try again/i.test(declinedPage));
  check("declined order does NOT claim we lost it", !/Nismo pronašli|couldn't find/i.test(declinedPage));

  // Abandoned: no callback ever arrives. Before the timeout it's legitimately
  // "processing"; after it, the customer must be told it failed.
  process.env.ORDER_TIMEOUT_MINUTES = "15";
  const pendingPage = await statusOf(c4.orderRef);
  check("un-resolved order reads as processing", /Obrađujemo|Waiting for confirmation/i.test(pendingPage));

  process.env.ORDER_TIMEOUT_MINUTES = "0";
  const abandonedPage = await statusOf(c4.orderRef);
  check("timed-out order says payment not completed", /nije završena|never received/i.test(abandonedPage), abandonedPage.slice(0, 200));
  check("timed-out order stops auto-refreshing", !/http-equiv="refresh"/.test(abandonedPage));
  check("timed-out order offers a retry", /Pokušajte ponovo|Try again/i.test(abandonedPage));
  delete process.env.ORDER_TIMEOUT_MINUTES;

  const unknownPage = await statusOf("000000000000");
  check("genuinely unknown ref still says not found", /Nismo pronašli|couldn't find/i.test(unknownPage));

  // --- 10. gateway restart resilience ------------------------------------
  // The mock keeps sessions in memory. `node --watch` restarts it on every file
  // save, which used to strand any open payment page with a bare 404.
  console.log("\n9. Gateway restart mid-payment");
  const c10 = await startCheckout(1);

  // Everything the payment page carries in its hidden fields.
  const q = new URL(c10.redirectUrl).searchParams;
  const form = new URLSearchParams();
  ["merchantId", "orderRef", "amount", "currency", "returnUrl", "callbackUrl", "signature"].forEach((k) =>
    form.set(k, q.get(k))
  );
  form.set("decision", "approve");

  gateway._clearSessions(); // as if the process had just restarted

  const decided = await fetch(`${GW}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    redirect: "manual",
  });
  check("stale payment page still submits (302, not 404)", decided.status === 302, `got ${decided.status}`);
  const d10 = await shopify.getDraftOrder(c10.orderRef);
  check("and the order completes normally", d10.status === "completed", `status=${d10.status}`);

  // A tampered hidden field must NOT be accepted as a rebuilt session.
  const c10b = await startCheckout(1);
  const qb = new URL(c10b.redirectUrl).searchParams;
  const evil = new URLSearchParams();
  ["merchantId", "orderRef", "currency", "returnUrl", "callbackUrl", "signature"].forEach((k) => evil.set(k, qb.get(k)));
  evil.set("amount", "1.00"); // signature no longer covers this
  evil.set("decision", "approve");
  gateway._clearSessions();
  const evilRes = await fetch(`${GW}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: evil.toString(),
    redirect: "manual",
  });
  check("tampered hidden fields are rejected", evilRes.status === 404, `got ${evilRes.status}`);

  // --- 10. input validation ---
  console.log("\n10. Checkout input validation");
  const empty = await post(`${BASE}/api/checkout`, { lineItems: [] });
  check("empty cart rejected", empty.status === 400, `got ${empty.status}`);
  const badQty = await post(`${BASE}/api/checkout`, { lineItems: [{ variant_id: 1, quantity: -5 }] });
  check("negative quantity rejected", badQty.status === 400, `got ${badQty.status}`);

  // --- 8b. the customer ends up on Shopify, not on us ----------------------
  //
  // This service is plumbing. A paying customer should land on the shop's own
  // order-status page showing their real itemised order; our pages exist only
  // for the states Shopify cannot represent.
  console.log("\n8b. Return redirects the customer to Shopify");
  {
    const noFollow = (url) => fetch(url, { redirect: "manual" });

    const paidReturn = await noFollow(`${BASE}/api/otp/return?orderRef=${c1.orderRef}`);
    const loc = paidReturn.headers.get("location") || "";
    check("a paid return is a redirect", paidReturn.status >= 300 && paidReturn.status < 400, `got ${paidReturn.status}`);
    check("and it points at Shopify's order-status page", /\/orders\/mock-token-/.test(loc), `location=${loc}`);
    check("not at our own status page", !/order-status/.test(loc), `location=${loc}`);

    // Declined: nothing exists on Shopify, so back to the cart with a flag the
    // theme turns into a message — still the merchant's domain, not ours.
    const declinedReturn = await noFollow(`${BASE}/api/otp/return?orderRef=${c3.orderRef}`);
    const dloc = declinedReturn.headers.get("location") || "";
    check("a declined return goes back to the storefront cart", /\/cart\?otp_status=declined/.test(dloc), `location=${dloc}`);

    // Still in flight: we have to render something, and it must not claim success.
    const pendingReturn = await noFollow(`${BASE}/api/otp/return?orderRef=${c4.orderRef}`);
    const ploc = pendingReturn.headers.get("location") || "";
    check("an unresolved return falls back to our status page", /order-status/.test(ploc), `location=${ploc}`);

    // And the auto-refresh loop hands over the moment the webhook lands.
    const statusPaid = await noFollow(`${BASE}/order-status?ref=${c1.orderRef}`);
    check(
      "the status page redirects to Shopify once paid",
      statusPaid.status >= 300 && statusPaid.status < 400 && /\/orders\/mock-token-/.test(statusPaid.headers.get("location") || ""),
      `status=${statusPaid.status} location=${statusPaid.headers.get("location")}`
    );
  }

  // --- 10b. the audit log is gone -----------------------------------------
  //
  // Free hosting has an ephemeral filesystem: data/payments.jsonl is wiped on
  // every restart and redeploy. Simulate that between the payment and the
  // customer reaching the status page. Before the Shopify fallback existed,
  // every one of these said "we couldn't find this order" to someone who had
  // just been charged.
  console.log("\n10b. Status page survives a wiped audit log");
  {
    const realEventsFor = audit.eventsFor;
    audit.eventsFor = () => []; // as if the log had never been written

    const paidPage2 = await statusOf(c1.orderRef); // completed draft in Shopify
    check("a paid order still reads as paid", /potvrđena|confirmed/i.test(paidPage2), paidPage2.slice(0, 200));
    check(
      "and does NOT claim we lost it",
      !/Nismo pronašli|couldn't find/i.test(paidPage2),
      paidPage2.slice(0, 200)
    );

    const openPage = await statusOf(c4.orderRef); // still-open draft in Shopify
    check("an unresolved order still reads as processing", /Obrađujemo|Waiting for confirmation/i.test(openPage), openPage.slice(0, 200));

    process.env.ORDER_TIMEOUT_MINUTES = "0";
    const stalePage = await statusOf(c4.orderRef);
    check("and ages into 'not completed' using Shopify's own timestamp", /nije završena|never received/i.test(stalePage), stalePage.slice(0, 200));
    delete process.env.ORDER_TIMEOUT_MINUTES;

    const goneePage = await statusOf("000000000000"); // no such draft
    check("a genuinely unknown ref is still unknown", /Nismo pronašli|couldn't find/i.test(goneePage));

    audit.eventsFor = realEventsFor;
  }

  // --- 11. delivery -------------------------------------------------------
  //
  // The bug these guard against: a draft order never applies a delivery rate on
  // its own, so the whole delivery charge can go missing without anything
  // failing. Every assertion here is about money actually being added.
  console.log("\n11. Delivery");
  {
    const item = { variant_id: 4200000001, quantity: 2 }; // 2 x 1200 = 2400

    const rates = await (await post(`${BASE}/api/delivery/rates`, {
      lineItems: [item],
      shippingAddress: ADDRESS,
    })).json();
    check("delivery options are offered for a Serbian address", rates.rates?.length > 0, JSON.stringify(rates));
    check(
      "rate handles are never exposed to the client",
      (rates.rates || []).every((r) => r.handle === undefined),
      JSON.stringify(rates.rates)
    );

    const withDelivery = await post(`${BASE}/api/checkout`, {
      lineItems: [item],
      customer: { email: "kupac@example.com" },
      shippingAddress: ADDRESS,
    });
    const wd = await withDelivery.json();
    check("cheapest rate is chosen by default", wd.delivery?.price === "359.00", JSON.stringify(wd.delivery));
    check("delivery is ADDED to the amount charged", Number(wd.amount) === 2400 + 359, `amount=${wd.amount}`);
    check("the chosen option is named back to the caller", wd.delivery?.title === "Стандардна", JSON.stringify(wd.delivery));

    // Naming a dearer option must actually cost more.
    const express = await (await post(`${BASE}/api/checkout`, {
      lineItems: [item],
      customer: { email: "kupac@example.com" },
      shippingAddress: ADDRESS,
      shippingRateTitle: "Ekspresna dostava",
    })).json();
    check("a named option is honoured", express.delivery?.title === "Ekspresna dostava", JSON.stringify(express.delivery));
    check("and is priced accordingly", Number(express.amount) === 2400 + 1490, `amount=${express.amount}`);

    // The threshold: 42 x 1200 = 50 400, over the 50 000 free-delivery line.
    const big = await (await post(`${BASE}/api/checkout`, {
      lineItems: [{ variant_id: 4200000001, quantity: 42 }],
      customer: { email: "kupac@example.com" },
      shippingAddress: ADDRESS,
    })).json();
    check("free delivery wins once the cart qualifies", big.delivery?.price === "0.00", JSON.stringify(big.delivery));
    check("and nothing is added to the total", Number(big.amount) === 50400, `amount=${big.amount}`);

    // A cart one unit short must NOT get free delivery. 41 x 1200 = 49 200.
    const justUnder = await (await post(`${BASE}/api/checkout`, {
      lineItems: [{ variant_id: 4200000001, quantity: 41 }],
      customer: { email: "kupac@example.com" },
      shippingAddress: ADDRESS,
    })).json();
    check(
      "a cart below the threshold still pays delivery",
      Number(justUnder.amount) === 49200 + 359,
      `amount=${justUnder.amount} delivery=${JSON.stringify(justUnder.delivery)}`
    );

    // Refusals. Each of these used to be a silent free delivery.
    const noAddress = await post(`${BASE}/api/checkout`, {
      lineItems: [item],
      customer: { email: "kupac@example.com" },
    });
    const na = await noAddress.json();
    check("no address is refused, not shipped free", noAddress.status === 400, `got ${noAddress.status}`);
    check("and says why", na.code === "address_required", JSON.stringify(na));

    const abroad = await post(`${BASE}/api/checkout`, {
      lineItems: [item],
      customer: { email: "kupac@example.com" },
      shippingAddress: { ...ADDRESS, country_code: "DE", city: "Berlin", zip: "10115" },
    });
    const ab = await abroad.json();
    check("an undeliverable address is refused", abroad.status === 400, `got ${abroad.status}`);
    check("and says why", ab.code === "no_rates_for_address", JSON.stringify(ab));

    const madeUp = await post(`${BASE}/api/checkout`, {
      lineItems: [item],
      customer: { email: "kupac@example.com" },
      shippingAddress: ADDRESS,
      shippingRateTitle: "Dostava za 1 dinar",
    });
    check("an invented delivery option is refused", madeUp.status === 400, `got ${madeUp.status}`);

    // The client must never be able to price its own delivery.
    const forged = await (await post(`${BASE}/api/checkout`, {
      lineItems: [item],
      customer: { email: "kupac@example.com" },
      shippingAddress: ADDRESS,
      shippingLine: { title: "Dostava", price: "1.00" },
      shipping_line: { title: "Dostava", price: "1.00" },
    })).json();
    check(
      "a client-supplied shipping price is ignored",
      Number(forged.amount) === 2400 + 359,
      `amount=${forged.amount} — if this is 2401 the customer sets their own delivery price`
    );
  }

  // --- 12. delivery switched off ------------------------------------------
  console.log("\n12. DELIVERY_MODE=off");
  {
    // Turning it off must be all-or-nothing: no address needed, no charge added.
    // This is the setting to use only when delivery genuinely is free.
    delete require.cache[require.resolve("../lib/config")];
    const saved = process.env.DELIVERY_MODE;
    process.env.DELIVERY_MODE = "off";
    const { config: offConfig, validate: offValidate } = require("../lib/config");
    check("mode reads as off", offConfig.delivery.mode === "off");
    check(
      "and it warns loudly, because this is how money goes missing",
      offValidate().warnings.some((w) => /DELIVERY_MODE=off/.test(w)),
      JSON.stringify(offValidate().warnings)
    );
    if (saved === undefined) delete process.env.DELIVERY_MODE;
    else process.env.DELIVERY_MODE = saved;
    delete require.cache[require.resolve("../lib/config")];
    require("../lib/config");
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m\n`);
  return failed === 0;
}

const appServer = app.listen(Number(process.env.PORT));
const gwServer = gateway.listen(Number(process.env.MOCK_OTP_PORT));

run()
  .then((ok) => {
    appServer.close();
    gwServer.close();
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("\n\x1b[31mSmoke test crashed:\x1b[0m", err);
    appServer.close();
    gwServer.close();
    process.exit(1);
  });
