// ============================================================================
// THE SWAP POINT
// ============================================================================
// Every OTP/iPay-specific assumption in this project lives in this one file:
// field names, amount format, signature recipe, status vocabulary, redirect
// method. Nothing else in the codebase knows that the gateway is called "OTP".
//
// When your sandbox credentials and developer docs arrive, you edit THIS FILE
// ONLY. server.js, the Shopify client, and the smoke test stay untouched.
//
// Everything marked `SPEC:` below is a guess based on the standard Serbian
// hosted-IPG pattern (Assseco/Payten-style, which OTP's iPay is built on).
// Confirm each one against OTP's real docs — see QUESTIONS-FOR-OTP.md for the
// exact list of things to ask them.
// ============================================================================

const crypto = require("crypto");
const { config } = require("./config");

// --- Normalised status vocabulary the rest of the app uses -----------------
const STATUS = {
  APPROVED: "approved",
  DECLINED: "declined",
  PENDING: "pending",
};

// SPEC: how the gateway spells each outcome in its callback.
// Payten-family gateways typically use ProcReturnCode "00" for success plus a
// Response field of "Approved"/"Declined"/"Error".
const STATUS_MAP = {
  approved: STATUS.APPROVED,
  success: STATUS.APPROVED,
  "00": STATUS.APPROVED,
  declined: STATUS.DECLINED,
  failure: STATUS.DECLINED,
  error: STATUS.DECLINED,
  pending: STATUS.PENDING,
  waiting: STATUS.PENDING,
};

// --- Signature recipe -------------------------------------------------------
// SPEC: the exact fields, in the exact order, that get concatenated and hashed.
// This MUST be an explicit ordered list, never Object.values() — JS object key
// order depends on insertion order, so the original starter kit would compute a
// different signature depending on how the gateway happened to order its JSON.
// That fails intermittently and is miserable to debug.
const REQUEST_SIGNATURE_FIELDS = [
  "merchantId",
  "orderRef",
  "amount",
  "currency",
  "returnUrl",
  "callbackUrl",
  // The itemised basket is SIGNED, deliberately.
  //
  // A basket shown on the payment page but left out of the signature is worse
  // than showing nothing: the customer edits one query parameter and the bank's
  // page confidently displays "1 x Stolica — 890 RSD" while charging 8 900. The
  // amount would still be right, so nothing would fail — they would simply have
  // been shown a lie at the moment they authorise the payment.
  //
  // SPEC: ask OTP whether their basket/stavke parameter is covered by their
  // signature. If it is not, do NOT send it — an unsigned basket is a liability.
  "basket",
];

const CALLBACK_SIGNATURE_FIELDS = [
  "merchantId",
  "orderRef",
  "amount",
  "currency",
  "status",
  "transactionId",
];

// SPEC: separator between concatenated fields. Some gateways use "|", some use
// no separator at all, some append the secret key to the end of the string and
// hash it plain (SHA-512 over "field1field2...secret") rather than using HMAC.
const SEPARATOR = "|";

function sign(fields, order) {
  const base = order.map((k) => (fields[k] === undefined ? "" : String(fields[k]))).join(SEPARATOR);
  // SPEC: algorithm and encoding. HMAC-SHA256/hex here; Payten-family gateways
  // commonly use SHA-512 base64 instead.
  return crypto.createHmac("sha256", config.otp.secretKey || "mock-secret").update(base, "utf8").digest("hex");
}

// SPEC: amount format. Options seen in the wild:
//   "1234.56"  decimal point, 2 places   <- assumed here
//   "1234,56"  decimal comma (Serbian locale)
//   "123456"   minor units (para), no separator
// Getting this wrong usually shows up as a signature mismatch, not a wrong
// charge — but verify it, because the amount is what the customer actually pays.
function formatAmount(totalPrice) {
  return Number(totalPrice).toFixed(2);
}

// SPEC: currency encoding. ISO-4217 alpha ("RSD") vs numeric ("941").
function formatCurrency(code) {
  return code;
}

// ---------------------------------------------------------------------------
// Build the request that sends the customer to the hosted payment page.
//
// Returns { method, url, fields }. If method is "POST" the front end must render
// a self-submitting form rather than setting window.location — many hosted IPGs
// require a form POST and will reject a GET with query params.
// ---------------------------------------------------------------------------
// How many lines to itemise before collapsing the rest into one summary row.
// A GET redirect carries this in the query string, and long URLs get truncated
// or rejected by proxies well before the browser complains. 20 lines of Serbian
// product names lands around 1.2 kB encoded, which is comfortable; an unbounded
// basket is not.
const MAX_BASKET_LINES = 20;

// SPEC: basket/stavke encoding. JSON here because our mock reads it. Real
// gateways vary wildly — repeated indexed params (item[0].name), a delimited
// string, or no basket support at all. Confirm with OTP before relying on it.
function encodeBasket(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return undefined;

  const shown = lines.slice(0, MAX_BASKET_LINES);
  const hidden = lines.length - shown.length;
  const rows = shown.map((l) => ({
    n: String(l.name ?? "").slice(0, 60),
    q: Number(l.quantity) || 0,
    u: formatAmount(l.unitPrice ?? 0),
    t: formatAmount(l.total ?? 0),
  }));
  if (hidden > 0) {
    const rest = lines.slice(MAX_BASKET_LINES).reduce((s, l) => s + Number(l.total || 0), 0);
    rows.push({ n: `+ još ${hidden} stavki`, q: hidden, u: "", t: formatAmount(rest) });
  }
  return JSON.stringify(rows);
}

function buildPaymentRequest({ orderRef, amount, currency, returnUrl, callbackUrl, customer, basket }) {
  const fields = {
    merchantId: config.otp.merchantId || "MOCK_MERCHANT",
    orderRef: String(orderRef),
    amount: formatAmount(amount),
    currency: formatCurrency(currency),
    returnUrl,
    callbackUrl,
  };

  // Order matters only for readability here — sign() reads by name from
  // REQUEST_SIGNATURE_FIELDS — but keep it next to the amount it itemises.
  const encoded = encodeBasket(basket);
  if (encoded) fields.basket = encoded;

  // SPEC: optional pass-through fields. Most gateways accept a customer email and
  // a language/locale code for the payment page.
  if (customer?.email) fields.email = customer.email;
  fields.lang = "sr";

  fields.signature = sign(fields, REQUEST_SIGNATURE_FIELDS);

  // SPEC: GET redirect assumed. Switch to "POST" if OTP requires a form post.
  const method = "GET";
  const url = `${config.otp.gatewayUrl}?${new URLSearchParams(fields).toString()}`;

  return { method, url, fields };
}

// ---------------------------------------------------------------------------
// Verify a callback actually came from OTP.
//
// `req.rawBody` is captured in server.js because some gateways sign the exact
// byte sequence of the body rather than the parsed fields. If OTP does that,
// verify against req.rawBody here instead of re-serialising.
// ---------------------------------------------------------------------------
function verifyCallback(body) {
  if (!config.otp.secretKey && !config.otpMock) return false;

  const received = body.signature || body.hash || body.HASH;
  if (!received || typeof received !== "string") return false;

  const expected = sign(body, CALLBACK_SIGNATURE_FIELDS);

  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, so check length first rather than
  // relying on a try/catch to mean "invalid".
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Normalise a callback body into the shape the rest of the app understands.
// ---------------------------------------------------------------------------
function parseCallback(body) {
  const rawStatus = String(body.status ?? body.Response ?? body.ProcReturnCode ?? "").toLowerCase();
  return {
    orderRef: body.orderRef ?? body.oid ?? body.orderId,
    status: STATUS_MAP[rawStatus] ?? STATUS.DECLINED,
    rawStatus,
    transactionId: body.transactionId ?? body.TransId ?? body.AuthCode ?? null,
    amount: body.amount ?? null,
    currency: body.currency ?? null,
  };
}

module.exports = {
  STATUS,
  buildPaymentRequest,
  verifyCallback,
  parseCallback,
  formatAmount,
  // exported for the mock gateway and the smoke test
  _sign: sign,
  _CALLBACK_SIGNATURE_FIELDS: CALLBACK_SIGNATURE_FIELDS,
  _REQUEST_SIGNATURE_FIELDS: REQUEST_SIGNATURE_FIELDS,
};
