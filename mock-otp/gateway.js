// A fake OTP hosted payment page.
//
// This exists so the entire payment flow — redirect, customer decision, signed
// server-to-server callback, order completion — can be exercised today, weeks
// before OTP issues sandbox credentials. It deliberately behaves like a real
// hosted IPG in the ways that matter:
//
//   * it verifies the signature on the inbound request (so a mistake in our
//     signing code fails here, loudly, instead of silently at the bank)
//   * it delivers the result via a server-to-server callback, NOT the redirect
//   * it retries the callback if we don't answer 200
//   * it can decline, and it can abandon (customer closes the tab)
//
// THIS IS NOT OTP. It proves our side of the contract is coherent. When the real
// spec arrives, lib/otp-adapter.js changes and this mock gets retired.

const express = require("express");
const fetch = require("node-fetch");
const { config } = require("../lib/config");
const otp = require("../lib/otp-adapter");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Pending "payments" the customer has been shown but not yet decided on.
const sessions = new Map();

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// --- Landing page -----------------------------------------------------------
// You cannot browse to /pay directly — a hosted payment page is only ever reached
// via a signed redirect. Say so, instead of leaving "Cannot GET /".
app.get("/", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock OTP gateway</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<div style="background:#fee;border:1px solid #c00;padding:.5rem .75rem;border-radius:4px;font-size:.8rem">
  <strong>MOCK GATEWAY</strong> — stands in for OTP banka. No real card is ever charged.
</div>
<h1 style="font-size:1.2rem">This is the fake bank, not your app.</h1>
<p>It's running and waiting for payment requests. There is nothing to see here directly:
   <code>/pay</code> can only be opened through a <em>signed</em> redirect from the bridge,
   the same way OTP's real page works.</p>
<p><strong>To start a payment, go to the bridge instead:</strong></p>
<p style="font-size:1.05rem"><a href="${config.appBaseUrl}/">${config.appBaseUrl}/</a></p>
<p style="font-size:.85rem;color:#666">Click "Start checkout" there and you'll be redirected back here with valid parameters.</p>
</body>`);
});

// --- The hosted payment page ------------------------------------------------
app.get("/pay", (req, res) => {
  const q = req.query;

  // Distinguish "you browsed here directly" from "the signature is actually wrong".
  // Conflating the two sends you debugging crypto when nothing is broken.
  const REQUIRED = ["merchantId", "orderRef", "amount", "currency", "returnUrl", "callbackUrl", "signature"];
  const missing = REQUIRED.filter((k) => !q[k]);
  if (missing.length) {
    return res.status(400).set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock OTP gateway</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.2rem">Nothing to pay for yet</h1>
<p>This page needs payment parameters, and you've opened it without any${missing.length < REQUIRED.length ? ` (missing: <code>${missing.join("</code>, <code>")}</code>)` : ""}.
   That's expected — a hosted payment page is only ever reached through a signed redirect.</p>
<p><strong>Nothing is broken.</strong> Start a payment from the bridge:</p>
<p style="font-size:1.05rem"><a href="${config.appBaseUrl}/">${config.appBaseUrl}/</a></p>
</body>`);
  }

  // Recompute the request signature exactly as the adapter built it.
  const expected = otp._sign(q, ["merchantId", "orderRef", "amount", "currency", "returnUrl", "callbackUrl"]);
  if (q.signature !== expected) {
    console.error("[mock-otp] REJECTED: request signature mismatch");
    console.error("  received:", q.signature);
    console.error("  expected:", expected);
    return res.status(400).set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><title>Signature mismatch</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.2rem">Signature mismatch</h1>
<p>All parameters are present, but the signature doesn't verify. This is a genuine
   bug in the signing recipe — check <code>lib/otp-adapter.js</code>.</p>
<p style="font-size:.85rem;color:#666">The server log shows the received and expected values.
   The most common cause is the two processes using different <code>OTP_SECRET_KEY</code>
   values — make sure both were started from the same <code>.env</code>.</p>
</body>`);
  }

  sessions.set(String(q.orderRef), {
    merchantId: q.merchantId,
    orderRef: q.orderRef,
    amount: q.amount,
    currency: q.currency,
    returnUrl: q.returnUrl,
    callbackUrl: q.callbackUrl,
  });

  // The form below also carries every field as a signed hidden input, so /decide
  // can rebuild the session without the in-memory map. Otherwise restarting this
  // process (which `node --watch` does on every file save) orphans any payment
  // page already open in a browser, and clicking Plati just 404s.
  const hidden = ["merchantId", "orderRef", "amount", "currency", "returnUrl", "callbackUrl", "signature"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q[k])}">`)
    .join("\n    ");

  console.log(`[mock-otp] payment page shown for order ${q.orderRef}, ${q.amount} ${q.currency}`);

  res.set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOCK OTP banka — plaćanje</title>
<body style="font-family:system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem">
  <div style="background:#fee;border:1px solid #c00;padding:.5rem .75rem;border-radius:4px;font-size:.8rem;margin-bottom:1.5rem">
    <strong>MOCK GATEWAY</strong> — simulation only, no real card is charged.
  </div>
  <h1 style="font-size:1.1rem">Plaćanje karticom</h1>
  <table style="font-size:.9rem;color:#444;margin:1rem 0">
    <tr><td style="padding-right:1rem">Porudžbina</td><td><code>${esc(q.orderRef)}</code></td></tr>
    <tr><td>Iznos</td><td><strong>${esc(q.amount)} ${esc(q.currency)}</strong></td></tr>
  </table>
  <form method="POST" action="${req.baseUrl}/decide" style="display:flex;flex-direction:column;gap:.5rem">
    ${hidden}
    <button name="decision" value="approve" style="padding:.7rem;background:#0a0;color:#fff;border:0;border-radius:4px;font-size:1rem;cursor:pointer">Plati (approve)</button>
    <button name="decision" value="decline" style="padding:.7rem;background:#c00;color:#fff;border:0;border-radius:4px;font-size:1rem;cursor:pointer">Odbij (decline)</button>
    <button name="decision" value="abandon" style="padding:.7rem;background:#eee;color:#333;border:0;border-radius:4px;font-size:1rem;cursor:pointer">Odustani (close tab — no callback)</button>
  </form>
</body>`);
});

// --- Customer decides -------------------------------------------------------
app.post("/decide", async (req, res) => {
  const { orderRef, decision } = req.body;

  // Prefer the in-memory session, but fall back to rebuilding it from the signed
  // hidden fields so a gateway restart doesn't strand an open payment page.
  let session = sessions.get(String(orderRef));
  if (!session) {
    const b = req.body;
    const expected = otp._sign(b, ["merchantId", "orderRef", "amount", "currency", "returnUrl", "callbackUrl"]);
    if (b.signature && b.signature === expected) {
      session = {
        merchantId: b.merchantId,
        orderRef: b.orderRef,
        amount: b.amount,
        currency: b.currency,
        returnUrl: b.returnUrl,
        callbackUrl: b.callbackUrl,
      };
      console.log(`[mock-otp] rebuilt session for ${orderRef} from signed form fields (gateway restarted?)`);
    }
  }

  if (!session) {
    return res.status(404).set("Content-Type", "text/html; charset=utf-8").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment session expired</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.2rem">Payment session expired</h1>
<p>This payment page is stale — it was opened before the gateway restarted, and its
   hidden fields no longer verify.</p>
<p><strong>Nothing is broken in the bridge.</strong> Start a fresh checkout:</p>
<p style="font-size:1.05rem"><a href="${config.appBaseUrl}/">${config.appBaseUrl}/</a></p>
</body>`);
  }

  if (decision === "abandon") {
    // Realistic: the customer closes the tab. No callback is ever sent, and the
    // draft order is left dangling. This is the case people forget to handle.
    console.log(`[mock-otp] order ${orderRef} ABANDONED — no callback sent`);
    sessions.delete(String(orderRef));
    return res.redirect(session.returnUrl + `?orderRef=${encodeURIComponent(orderRef)}&status=abandoned`);
  }

  const outcome = await sendCallback(session, decision === "approve" ? "approved" : "declined");
  sessions.delete(String(orderRef));

  res.redirect(session.returnUrl + `?orderRef=${encodeURIComponent(orderRef)}&status=${outcome.status}`);
});

// --- Programmatic driver for the smoke test ---------------------------------
// POST /simulate { orderRef, decision } -> performs the decision without a browser.
app.post("/simulate", async (req, res) => {
  const { orderRef, decision } = req.body;
  const session = sessions.get(String(orderRef));
  if (!session) return res.status(404).json({ error: "no such payment session" });

  if (decision === "abandon") {
    sessions.delete(String(orderRef));
    return res.json({ status: "abandoned", callbackDelivered: false });
  }

  const outcome = await sendCallback(session, decision === "approve" ? "approved" : "declined");
  sessions.delete(String(orderRef));
  res.json(outcome);
});

// Replay an already-sent callback, to prove our webhook is idempotent.
app.post("/replay", async (req, res) => {
  const { orderRef, status } = req.body;
  const session = lastSent.get(String(orderRef));
  if (!session) return res.status(404).json({ error: "nothing to replay" });
  const outcome = await sendCallback(session, status || "approved");
  res.json(outcome);
});

const lastSent = new Map();

// --- Signed server-to-server callback, with retries -------------------------
async function sendCallback(session, status) {
  lastSent.set(String(session.orderRef), session);

  const payload = {
    merchantId: session.merchantId,
    orderRef: String(session.orderRef),
    amount: session.amount,
    currency: session.currency,
    status,
    transactionId: "MOCK" + Math.random().toString(36).slice(2, 10).toUpperCase(),
  };
  payload.signature = otp._sign(payload, otp._CALLBACK_SIGNATURE_FIELDS);

  // Real gateways retry a non-200. Doing the same here is what catches a webhook
  // that is accidentally non-idempotent.
  const MAX_ATTEMPTS = 3;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(session.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      lastStatus = res.status;
      lastBody = await res.text();
      console.log(`[mock-otp] callback attempt ${attempt} -> ${res.status} ${lastBody}`);
      if (res.status === 200) break;
      if (res.status >= 400 && res.status < 500) break; // permanent, don't retry
    } catch (err) {
      lastBody = err.message;
      console.error(`[mock-otp] callback attempt ${attempt} failed:`, err.message);
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 300));
  }

  return { status, transactionId: payload.transactionId, callbackStatus: lastStatus, callbackBody: lastBody };
}

// Test hook: simulate this process restarting and losing its in-memory sessions.
app._clearSessions = () => sessions.clear();

if (require.main === module) {
  // Locally MOCK_OTP_PORT is set (4000) and wins, so the gateway and the bridge
  // do not fight over a port. When this is deployed as its own service the host
  // injects PORT and MOCK_OTP_PORT is left unset, so it binds where the platform
  // expects. config.mockPort is last because it defaults to 4000 even when
  // nothing is configured, which would make a deployed instance unreachable.
  const listenPort = Number(process.env.MOCK_OTP_PORT || process.env.PORT || config.mockPort);
  app.listen(listenPort, () =>
    console.log(`MOCK OTP gateway listening on :${listenPort} /pay  (simulation only)`)
  );
}

module.exports = app;
