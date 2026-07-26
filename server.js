// Shopify + OTP banka (iPay) payment bridge.
//
// Flow: theme checkout button -> POST /api/checkout -> Shopify draft order created
//       -> browser redirected to OTP's hosted page -> customer pays
//       -> OTP POSTs a signed callback to /api/otp/webhook  (AUTHORITATIVE)
//       -> we complete the Shopify draft order into a real paid order
//       -> browser lands back on /api/otp/return (cosmetic only)
//
// The browser redirect never completes an order. A customer can close the tab,
// edit the return URL, or replay it — only the server-to-server callback counts.
//
// All gateway-specific details live in lib/otp-adapter.js. See that file when
// OTP's real spec arrives.

const express = require("express");
const { config, validate } = require("./lib/config");
const shopify = require("./lib/shopify");
const otp = require("./lib/otp-adapter");
const audit = require("./lib/audit");
const delivery = require("./lib/delivery");

const app = express();

const esc = (s) =>
  String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

// Capture the raw body during parsing. Some gateways sign the exact bytes they
// sent, so re-serialising the parsed object would produce a different signature.
const keepRaw = (req, _res, buf) => {
  req.rawBody = buf;
};
app.use(express.json({ verify: keepRaw }));
// Hosted IPGs commonly post callbacks as form data rather than JSON — accept both.
app.use(express.urlencoded({ extended: false, verify: keepRaw }));

// --- CORS, locked to your storefront origins -------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Dev console at / ------------------------------------------------------
// Only mounted while something is mocked, so it can never appear in production.
// Without this, opening http://localhost:3000 just says "Cannot GET /", which
// tells you nothing about whether the service is actually alive.
if (config.shopifyMock || config.otpMock) {
  app.get("/", (_req, res) => {
    const { errors, warnings } = validate();
    res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OTP bridge — dev console</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.2rem;margin-bottom:.25rem">OTP &lt;-&gt; Shopify bridge</h1>
<p style="color:#666;margin-top:0">Dev console. Not served in production.</p>

<table style="font-size:.9rem;border-collapse:collapse;margin:1.5rem 0">
  <tr><td style="padding:.25rem 1rem .25rem 0">Shopify</td><td><strong>${config.shopifyMock ? "MOCK (in-memory)" : config.shopify.store}</strong></td></tr>
  <tr><td style="padding:.25rem 1rem .25rem 0">Gateway</td><td><strong>${config.otpMock ? "MOCK" : "LIVE"}</strong> — ${esc(config.otp.gatewayUrl)}</td></tr>
  <tr><td style="padding:.25rem 1rem .25rem 0">Config</td><td>${errors.length ? `<span style="color:#c00">${errors.length} error(s)</span>` : '<span style="color:#0a0">no errors</span>'}</td></tr>
</table>

${warnings.length ? `<ul style="font-size:.85rem;color:#a60;background:#fffbf0;border:1px solid #fd8;padding:.75rem 1rem .75rem 2rem;border-radius:4px">${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
${errors.length ? `<ul style="font-size:.85rem;color:#c00;background:#fff5f5;border:1px solid #fbb;padding:.75rem 1rem .75rem 2rem;border-radius:4px">${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}

<h2 style="font-size:1rem;margin-top:2rem">Start a test checkout</h2>
<p style="font-size:.85rem;color:#666">
  Creates a draft order and sends you to the payment page — the same path a real
  customer takes.${config.otpMock ? " The gateway is mocked, so no money moves." : ""}
</p>
<form id="f" style="display:flex;gap:.5rem;align-items:flex-end;flex-wrap:wrap">
  <label style="font-size:.8rem">Variant ID<br><input name="variant" value="123" style="padding:.4rem;width:12rem"></label>
  <label style="font-size:.8rem">Qty<br><input name="qty" value="1" type="number" min="1" style="padding:.4rem;width:4rem"></label>
  <button style="padding:.5rem 1rem;background:#111;color:#fff;border:0;border-radius:4px;cursor:pointer">Start checkout</button>
</form>
<p style="font-size:.8rem;color:#888">${config.shopifyMock ? "Any variant ID works while Shopify is mocked." : "Must be a real variant ID from your store."}</p>
<pre id="out" style="background:#f6f6f6;padding:.75rem;border-radius:4px;font-size:.75rem;overflow-x:auto;white-space:pre-wrap"></pre>

<p style="font-size:.85rem;margin-top:2rem"><a href="/health">/health</a> — machine-readable status</p>

<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = document.getElementById("out");
  out.textContent = "Creating draft order...";
  try {
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lineItems: [{ variant_id: Number(e.target.variant.value), quantity: Number(e.target.qty.value) }],
        customer: { email: "test@example.com" }
      })
    });
    const data = await res.json();
    out.textContent = JSON.stringify(data, null, 2);
    if (data.redirectUrl) {
      out.textContent += "\\n\\nRedirecting to the payment page...";
      setTimeout(() => { window.location.href = data.redirectUrl; }, 800);
    }
  } catch (err) {
    out.textContent = "Failed: " + err.message;
  }
});
</script>
</body>`);
  });
}

// --- Health check ----------------------------------------------------------
app.get("/health", (_req, res) => {
  const { errors, warnings } = validate();
  res.json({
    ok: errors.length === 0,
    mode: { shopifyMock: config.shopifyMock, otpMock: config.otpMock },
    errors,
    warnings,
  });
});

// ---------------------------------------------------------------------------
// 1. Start checkout: create an unpaid draft order, hand back the gateway URL.
// ---------------------------------------------------------------------------
// Delivery options for a cart, so the storefront can show them and let the
// customer pick before paying. Prices come straight from Shopify's shipping
// settings; nothing here is quotable by the client.
app.post("/api/delivery/rates", async (req, res) => {
  try {
    const { lineItems, shippingAddress } = req.body || {};
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: "cart is empty" });
    }
    if (!delivery.hasUsableAddress(shippingAddress)) {
      return res.status(400).json({ error: "address required", code: "address_required" });
    }
    const { rates } = await shopify.getShippingRates({ lineItems, shippingAddress });
    // The handle is deliberately not returned. It is a signed token and the
    // client has no use for it — /api/checkout re-resolves rates server-side.
    res.json({ rates: rates.map((r) => ({ title: r.title, price: r.price, currency: r.currency })) });
  } catch (err) {
    console.error("delivery rates error:", err);
    res.status(500).json({ error: "could not load delivery options" });
  }
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { lineItems, customer, shippingAddress, shippingRateTitle } = req.body || {};

    // Validate what the browser sent. The client never sends prices — Shopify
    // computes the total from its own catalogue, so a tampered cart cannot
    // change what the customer is charged. It could still send junk variant ids.
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: "cart is empty" });
    }
    for (const li of lineItems) {
      if (!li || li.variant_id === undefined || li.variant_id === null) {
        return res.status(400).json({ error: "line item missing variant_id" });
      }
      if (!Number.isInteger(li.quantity) || li.quantity < 1 || li.quantity > 1000) {
        return res.status(400).json({ error: "invalid quantity" });
      }
    }

    const items = lineItems.map((li) => ({ variant_id: li.variant_id, quantity: li.quantity }));

    // Resolve delivery BEFORE creating the draft order, so a cart we cannot
    // deliver never becomes an order at all. Throws rather than returning null
    // when it is unsure — see lib/delivery.js.
    const chosenRate = await delivery.resolve({
      shopify,
      lineItems: items,
      shippingAddress,
      shippingRateTitle,
    });

    const draft = await shopify.createDraftOrder({
      lineItems: items,
      customer,
      shippingAddress,
      note: "Payment via OTP banka (iPay)",
      tags: "otp-pending",
      shippingRateHandle: chosenRate?.handle,
    });

    // Belt and braces. REST silently drops a shipping rate handle, and if a
    // future change routes this back through REST the only visible symptom
    // would be customers paying slightly too little, forever. Assert instead.
    if (chosenRate && Number(chosenRate.price) > 0) {
      const applied = Number(draft.shipping_line?.price ?? 0);
      if (applied !== Number(chosenRate.price)) {
        await shopify.deleteDraftOrder(draft.id).catch(() => {});
        throw new Error(
          `delivery charge was not applied: expected ${chosenRate.price}, got ${applied}`
        );
      }
    }

    const orderRef = String(draft.id);
    const payment = otp.buildPaymentRequest({
      orderRef,
      amount: draft.total_price,
      currency: draft.currency || config.currency,
      returnUrl: `${config.appBaseUrl}/api/otp/return`,
      callbackUrl: `${config.appBaseUrl}/api/otp/webhook`,
      customer,
    });

    audit.write("checkout.started", {
      orderRef,
      amount: draft.total_price,
      currency: draft.currency,
      email: customer?.email,
      delivery: chosenRate ? { title: chosenRate.title, price: chosenRate.price } : null,
    });

    res.json({
      draftOrderId: draft.id,
      orderRef,
      amount: draft.total_price,
      currency: draft.currency,
      // What the customer is paying for delivery, so the storefront can show it
      // on the confirmation step rather than a total that appears out of thin air.
      delivery: chosenRate ? { title: chosenRate.title, price: chosenRate.price } : null,
      // method is "GET" -> set window.location. If the adapter switches to "POST",
      // the front end must build and submit a hidden form with `fields`.
      method: payment.method,
      redirectUrl: payment.url,
      fields: payment.method === "POST" ? payment.fields : undefined,
    });
  } catch (err) {
    // "We don't deliver there" and "give us an address" are answers to the
    // customer, not server faults. A 500 here would make the storefront show a
    // generic failure and the customer retry the same doomed cart.
    if (err instanceof delivery.DeliveryError) {
      audit.write("checkout.delivery_unavailable", { code: err.code, message: err.message });
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error("checkout error:", err);
    audit.write("checkout.failed", { error: err.message, status: err.status });
    // Surface Shopify's real complaint in dev; stay vague in production.
    const detail = config.shopifyMock || process.env.NODE_ENV !== "production" ? err.message : undefined;
    res.status(500).json({ error: "checkout failed", detail });
  }
});

// ---------------------------------------------------------------------------
// 2. The authoritative payment result. This is the only place an order is
//    marked paid.
//
//    Contract with the gateway:
//      200 -> we have durably handled this, stop retrying
//      4xx -> the message is bad, retrying will not help
//      5xx -> we failed transiently, PLEASE retry
//    Returning 200 on a failure would silently strand a paid customer.
// ---------------------------------------------------------------------------
app.post("/api/otp/webhook", async (req, res) => {
  const body = req.body || {};

  if (!otp.verifyCallback(body)) {
    audit.write("webhook.rejected", { reason: "bad signature", body });
    return res.status(400).send("invalid signature");
  }

  const result = otp.parseCallback(body);
  audit.write("webhook.received", { ...result, body });

  if (!result.orderRef) {
    return res.status(400).send("missing order reference");
  }

  try {
    const draft = await shopify.getDraftOrder(result.orderRef);

    // Idempotency: gateways retry until they get a 200, and a customer double-
    // clicking can also produce duplicates. Shopify's own draft status is the
    // lock — no extra database needed.
    if (draft.status === "completed") {
      audit.write("webhook.duplicate", { orderRef: result.orderRef });
      return res.status(200).send("already processed");
    }

    if (result.status === otp.STATUS.APPROVED) {
      // Guard against a callback claiming a different amount than the order.
      // The signature already covers the amount, but this catches a mis-mapped
      // amount format (minor units vs decimal) before it becomes a real loss.
      const expected = otp.formatAmount(draft.total_price);
      if (result.amount != null && String(result.amount) !== expected) {
        audit.write("webhook.amount_mismatch", {
          orderRef: result.orderRef,
          expected,
          received: result.amount,
        });
        return res.status(400).send("amount mismatch");
      }

      const completed = await shopify.completeDraftOrder(result.orderRef);

      // Shopify's own order-status page is where the customer should end up:
      // it shows the real order, itemised, on the merchant's domain. This
      // service is plumbing and the customer should never dwell on it.
      //
      // The URL carries a token and is only knowable after the order exists, so
      // it is captured here and recorded in the audit log for /api/otp/return
      // to redirect to. Failing to get it is not fatal — the customer falls
      // back to our own status page, which still tells them the truth.
      let orderStatusUrl;
      if (completed.order_id) {
        try {
          const order = await shopify.getOrder(completed.order_id);
          orderStatusUrl = order?.order_status_url;
        } catch (err) {
          console.error("could not read order_status_url:", err.message);
        }
      }

      audit.write("order.completed", {
        orderRef: result.orderRef,
        shopifyOrderId: completed.order_id,
        transactionId: result.transactionId,
        orderStatusUrl,
      });

      // Record which OTP payment this order belongs to, and retag it from
      // otp-pending to otp-paid so the admin can tell settled orders from
      // abandoned drafts at a glance.
      //
      // Deliberately non-fatal, for the same reason as fiscalization below: the
      // money has already moved and the order already exists. Throwing here would
      // return a 5xx, OTP would retry, and the retry would hit the "already
      // processed" branch above — so the annotation would never happen anyway,
      // and we would have made the gateway retry a completed payment for nothing.
      if (completed.order_id) {
        try {
          await shopify.annotateOrder(completed.order_id, {
            transactionId: result.transactionId,
            orderRef: result.orderRef,
          });
        } catch (annotateErr) {
          audit.write("order.annotate_failed", {
            orderRef: result.orderRef,
            shopifyOrderId: completed.order_id,
            transactionId: result.transactionId,
            error: annotateErr.message,
          });
          console.error("could not stamp transaction id on order:", completed.order_id, annotateErr.message);
        }
      }

      // Fiscalization is a legal requirement but a SEPARATE system. If it fails
      // we must not 500 — that would make OTP retry, and the retry would hit the
      // "already processed" branch above and never fiscalize anyway. Instead the
      // failure is recorded for retry by the operator.
      try {
        await issueFiscalReceipt(result.orderRef, result);
        audit.write("fiscal.issued", { orderRef: result.orderRef });
      } catch (fiscalErr) {
        audit.write("fiscal.FAILED_NEEDS_MANUAL_RETRY", {
          orderRef: result.orderRef,
          error: fiscalErr.message,
        });
        console.error("FISCAL RECEIPT FAILED — manual action required:", result.orderRef, fiscalErr);
      }

      return res.status(200).send("ok");
    }

    if (result.status === otp.STATUS.PENDING) {
      // Not final yet — acknowledge but change nothing.
      audit.write("payment.pending", { orderRef: result.orderRef });
      return res.status(200).send("ok");
    }

    await markDraftOrderFailed(result.orderRef, result);
    audit.write("payment.declined", { orderRef: result.orderRef, rawStatus: result.rawStatus });
    return res.status(200).send("ok");
  } catch (err) {
    console.error("webhook processing error:", err);
    audit.write("webhook.error", { orderRef: result.orderRef, error: err.message, status: err.status });
    // 404 means the draft order does not exist — retrying will never fix that.
    if (err.status === 404) return res.status(400).send("unknown order");
    return res.status(500).send("processing error");
  }
});

// ---------------------------------------------------------------------------
// 3. Browser comes back from the hosted page. Cosmetic only.
//    Accept both verbs — gateways differ on whether they GET or POST the return.
// ---------------------------------------------------------------------------
// Where the customer's browser comes back to. Cosmetic only — the webhook has
// already decided everything by now, or will shortly.
//
// The goal is that this service is invisible: a successful customer should land
// on Shopify's own order-status page, on the shop's domain, showing their real
// itemised order. We only render our own page when Shopify has nothing to show
// yet (webhook still in flight) or nothing to show at all (declined).
app.all("/api/otp/return", async (req, res) => {
  const params = { ...req.query, ...(req.body || {}) };
  const ref = params.orderRef || params.oid || "";
  if (!ref) return res.redirect("/order-status");

  // Deliberately ignores any status the gateway put in this request — the
  // customer can edit it. State comes from the verified webhook via the audit
  // log, or from Shopify itself.
  const { state } = await resolveOrderState(ref);

  if (state === "paid") {
    const url = shopifyOrderStatusUrl(ref);
    if (url) return res.redirect(url);
  }

  if (state === "declined" || state === "abandoned") {
    // Nothing exists on Shopify to look at, so send them back to their cart
    // with a flag the theme snippet turns into a message. Still their domain,
    // still not ours.
    const back = storefrontUrl();
    if (back) return res.redirect(`${back}/cart?otp_status=${state}`);
  }

  res.redirect(`/order-status?ref=${encodeURIComponent(ref)}`);
});

// The order-status URL Shopify minted for this order, recorded by the webhook.
function shopifyOrderStatusUrl(ref) {
  const done = audit.eventsFor(ref).find((e) => e.event === "order.completed" && e.orderStatusUrl);
  return done?.orderStatusUrl;
}

// The customer-facing storefront. Falls back to the first allowed origin, which
// is already the storefront the theme calls us from.
function storefrontUrl() {
  const explicit = process.env.STOREFRONT_URL;
  const url = (explicit || config.allowedOrigins[0] || "").replace(/\/+$/, "");
  return url || null;
}

// ---------------------------------------------------------------------------
// 4. Status page.
//
// Deliberately does NOT trust the status the gateway put in the redirect URL —
// the customer can edit it. State is derived from the audit log (written only by
// the verified webhook) plus Shopify's own order status.
//
// The four outcomes a customer can actually land here with:
//   paid       - webhook confirmed, order exists
//   declined   - webhook said declined; the draft order is gone by design
//   processing - webhook hasn't arrived yet; genuinely worth refreshing
//   abandoned  - they left the payment page and nothing is ever coming
//
// Getting this wrong is not cosmetic: telling a declined customer "we couldn't
// find your order" makes them think their money vanished, and spinning forever
// on "confirming your payment" makes them retry and double-pay.
// ---------------------------------------------------------------------------

// How long to wait for a webhook before calling the attempt dead. Should be at
// least as long as OTP's payment-session lifetime — ask them (QUESTIONS-FOR-OTP.md
// section 6). Set ORDER_TIMEOUT_MINUTES=1 in .env to exercise this path quickly.
// Read per-request rather than at module load, so tests can exercise both the
// "still processing" and "timed out" branches in one process.
const orderTimeoutMs = () => Number(process.env.ORDER_TIMEOUT_MINUTES ?? 15) * 60 * 1000;
// Stop the meta-refresh well before the timeout so an abandoned tab isn't
// hammering the server all afternoon.
const AUTO_REFRESH_MS = 2 * 60 * 1000;

// When the audit log has nothing, ask Shopify directly.
//
// The audit log is a file. On the free hosting tiers this is likely to run on,
// the filesystem is ephemeral — wiped on every restart and redeploy. Without
// this fallback, a restart between "customer pays" and "customer lands on the
// status page" would tell someone who has genuinely just been charged that we
// cannot find their order. That is the single worst thing this page can say.
//
// Shopify's own draft-order state survives all of that, so it is the better
// authority anyway; the log is really just a fast local cache plus history.
async function resolveFromShopify(ref) {
  try {
    const draft = await shopify.getDraftOrder(ref);
    if (draft.status === "completed") return { state: "paid", elapsed: 0 };
    // Still open. Age it from Shopify's own timestamp rather than the audit log,
    // so the abandoned/processing split also survives a wiped log.
    const created = draft.created_at ? new Date(draft.created_at).getTime() : Date.now();
    const elapsed = Date.now() - created;
    return { state: elapsed > orderTimeoutMs() ? "abandoned" : "processing", elapsed };
  } catch (err) {
    // 404 means the draft is gone. That is ambiguous: a declined payment deletes
    // the draft by design, but so does never having existed. "Unknown" is the
    // honest answer — and it is safe, because a declined customer was not
    // charged either way.
    return { state: "unknown" };
  }
}

async function resolveOrderState(ref) {
  const events = audit.eventsFor(ref);
  if (events.length === 0) return resolveFromShopify(ref);

  const has = (name) => events.some((e) => e.event === name);
  const started = events.find((e) => e.event === "checkout.started");
  const elapsed = started ? Date.now() - new Date(started.at).getTime() : 0;

  if (has("order.completed")) return { state: "paid", elapsed };
  if (has("payment.declined")) return { state: "declined", elapsed };
  if (has("webhook.amount_mismatch")) return { state: "problem", elapsed };

  // No verdict yet. Confirm against Shopify in case the webhook landed while an
  // audit write failed — Shopify is the more authoritative of the two.
  try {
    const draft = await shopify.getDraftOrder(ref);
    if (draft.status === "completed") return { state: "paid", elapsed };
  } catch {
    // Draft is gone and no decline was recorded — treat as unresolved.
  }

  return { state: elapsed > orderTimeoutMs() ? "abandoned" : "processing", elapsed };
}

app.get("/order-status", async (req, res) => {
  const ref = req.query.ref;
  const { state, elapsed = 0 } = ref ? await resolveOrderState(ref) : { state: "unknown" };

  // The auto-refresh loop lands here while the webhook is still in flight. As
  // soon as it arrives, hand the customer over to Shopify rather than showing
  // our own "confirmed" page — this service should be a stop, not a destination.
  if (state === "paid" && ref) {
    const url = shopifyOrderStatusUrl(ref);
    if (url) return res.redirect(url);
  }

  const COPY = {
    paid: {
      title: "Uplata potvrđena",
      body: "Hvala! Vaša uplata je uspešno obrađena i porudžbina je primljena.<br><span style='color:#666'>Thank you — your payment is confirmed and your order is placed.</span>",
      color: "#0a7d28",
    },
    declined: {
      title: "Uplata nije odobrena",
      body: "Vaša banka je odbila transakciju. <strong>Novac vam nije naplaćen.</strong> Možete pokušati ponovo, drugom karticom.<br><span style='color:#666'>Your bank declined the payment. You have not been charged — you can try again.</span>",
      color: "#c00",
      retry: true,
    },
    processing: {
      title: "Obrađujemo uplatu",
      body: "Čekamo potvrdu od banke. Ova stranica se automatski osvežava.<br><span style='color:#666'>Waiting for confirmation from the bank. This page refreshes automatically.</span>",
      color: "#a60",
    },
    abandoned: {
      title: "Uplata nije završena",
      body: "Nismo dobili potvrdu o uplati. <strong>Novac vam nije naplaćen.</strong> Vaša korpa je sačuvana — pokušajte ponovo.<br><span style='color:#666'>We never received a payment confirmation. You have not been charged; your cart is still saved.</span>",
      color: "#a60",
      retry: true,
    },
    problem: {
      title: "Problem sa uplatom",
      body: "Došlo je do neslaganja u iznosu i porudžbina je zadržana radi provere. Kontaktiraćemo vas.<br><span style='color:#666'>There was a mismatch in the amount and the order is on hold for review. We'll be in touch.</span>",
      color: "#c00",
    },
    unknown: {
      title: "Porudžbina nije pronađena",
      body: "Nismo pronašli ovu porudžbinu.<br><span style='color:#666'>We couldn't find this order.</span>",
      color: "#666",
    },
  };

  const copy = COPY[state] || COPY.unknown;
  const autoRefresh = state === "processing" && elapsed < AUTO_REFRESH_MS;

  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${autoRefresh ? '<meta http-equiv="refresh" content="4">' : ""}
<title>${esc(copy.title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6">
<h1 style="font-size:1.25rem;color:${copy.color};margin-bottom:.5rem">${esc(copy.title)}</h1>
<p>${copy.body}</p>
${copy.retry ? '<p style="margin-top:1.5rem"><a href="/cart" style="display:inline-block;padding:.6rem 1.2rem;background:#111;color:#fff;text-decoration:none;border-radius:4px">Pokušajte ponovo / Try again</a></p>' : ""}
${state === "processing" && !autoRefresh ? '<p style="margin-top:1.5rem"><a href="">Osveži / Refresh</a></p>' : ""}
<p style="color:#999;font-size:.8rem;margin-top:2.5rem">Ref: ${ref ? esc(ref) : "—"}</p>
</body>`);
});

// --- Side effects still to be wired up -------------------------------------

async function markDraftOrderFailed(draftOrderId, result) {
  // A declined payment must not leave an orphaned draft order sitting in the
  // admin looking like a real sale. Tag it so it is filterable, then delete it —
  // the customer can simply check out again from their (still intact) cart.
  try {
    await shopify.updateDraftOrder(draftOrderId, { tags: "otp-declined" });
  } catch (err) {
    console.error("could not tag declined draft order:", err.message);
  }
  try {
    await shopify.deleteDraftOrder(draftOrderId);
  } catch (err) {
    console.error("could not delete declined draft order:", err.message);
  }
}

async function issueFiscalReceipt(orderRef, paymentInfo) {
  // PHASE 5 — not yet implemented. Serbian law requires a fiscal receipt for every
  // completed retail sale, issued through a licensed L-PFR/V-PFR provider.
  //
  // Left as a no-op rather than a throw so the mock flow runs green; swap in the
  // real provider call and the failure path above starts doing its job.
  if (process.env.FISCAL_PROVIDER_URL) {
    throw new Error("fiscalization provider configured but not implemented yet");
  }
}

// --- Boot ------------------------------------------------------------------
if (require.main === module) {
  const { errors, warnings } = validate();
  warnings.forEach((w) => console.warn(`[warn] ${w}`));
  errors.forEach((e) => console.error(`[ERROR] ${e}`));

  app.listen(config.port, () => {
    console.log(`OTP <-> Shopify bridge on http://localhost:${config.port}`);
    console.log(`  Shopify: ${config.shopifyMock ? "MOCK (in-memory)" : config.shopify.store}`);
    console.log(`  Gateway: ${config.otpMock ? "MOCK" : "LIVE"} -> ${config.otp.gatewayUrl}`);
    if (errors.length) console.error(`  ${errors.length} config error(s) — real payments will not work.`);
  });
}

module.exports = app;
