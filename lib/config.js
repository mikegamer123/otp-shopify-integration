// Central config + boot-time validation.
//
// Two independent "mock" switches let you test one half of the system at a time:
//   SHOPIFY_MOCK=1  -> use an in-memory fake Shopify (no Admin token needed)
//   OTP_MOCK=1      -> use the local fake gateway in mock-otp/ (no OTP contract needed)
// Both default to ON so `npm run smoke` works on a clean checkout with no secrets.

require("dotenv").config();

const bool = (v, dflt) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

const port = Number(process.env.PORT || 3000);
const mockPort = Number(process.env.MOCK_OTP_PORT || 4000);

const config = {
  port,
  mockPort,
  appBaseUrl: (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ""),

  shopifyMock: bool(process.env.SHOPIFY_MOCK, true),
  otpMock: bool(process.env.OTP_MOCK, true),

  shopify: {
    store: process.env.SHOPIFY_STORE,
    token: process.env.SHOPIFY_ADMIN_TOKEN,
    // Pin the API version. Shopify deprecates versions on a 12-month cycle;
    // bump this deliberately, never let it float.
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-01",
  },

  otp: {
    merchantId: process.env.OTP_MERCHANT_ID,
    secretKey: process.env.OTP_SECRET_KEY,
    // When mocked and nothing is configured, point at the fake gateway that
    // server.js mounts in-process. It has to be an absolute URL because the
    // customer's browser is redirected to it — and it must not be localhost, or
    // a deployed instance would send every customer to their own machine.
    // That exact bug shipped once: callbackUrl read http://localhost:10000.
    gatewayUrl:
      process.env.OTP_GATEWAY_URL ||
      (bool(process.env.OTP_MOCK, true)
        ? `${(process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "")}/mock-gateway/pay`
        : ""),
  },

  // The theme snippet calls /api/checkout from your storefront's origin, which is a
  // different domain than this service — so the browser sends a CORS preflight.
  // List every origin your storefront is served from (myshopify domain AND any
  // custom domain), comma-separated. Never use "*" here: this endpoint creates
  // draft orders, so any site on the internet could spam your admin with them.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),

  // Delivery. Two modes, both explicit — there is deliberately no "figure it out"
  // option, because the thing that goes wrong here goes wrong quietly.
  //   require -> every checkout must resolve a delivery rate from Shopify's own
  //              shipping settings. No address, or no rate for that address,
  //              fails the checkout instead of shipping for free.
  //   off     -> never attach a delivery charge. Correct only if delivery really
  //              is free or is arranged and paid outside the shop.
  delivery: {
    mode: /^off$/i.test(String(process.env.DELIVERY_MODE || "require")) ? "off" : "require",
  },

  // RSD is the only currency OTP's domestic acquiring settles in. If you sell in
  // another presentment currency, you must convert before building the payment
  // request — confirm the expected currency code format with OTP (numeric 941 vs "RSD").
  currency: process.env.STORE_CURRENCY || "RSD",
};

// Problems that must be fixed before this config can take a real payment.
function validate() {
  const errors = [];
  const warnings = [];

  if (!config.shopifyMock) {
    if (!config.shopify.store) errors.push("SHOPIFY_STORE is not set");
    else if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(config.shopify.store)) {
      errors.push(`SHOPIFY_STORE should look like your-store.myshopify.com (got "${config.shopify.store}")`);
    }
    if (!config.shopify.token) errors.push("SHOPIFY_ADMIN_TOKEN is not set");
    else if (!/^shpat_/.test(config.shopify.token)) {
      warnings.push("SHOPIFY_ADMIN_TOKEN does not start with shpat_ — is that an Admin API access token?");
    }
  } else {
    warnings.push("SHOPIFY_MOCK is on — draft orders are in-memory and will NOT appear in your Shopify admin.");
  }

  if (!config.otpMock) {
    if (!config.otp.merchantId) errors.push("OTP_MERCHANT_ID is not set");
    if (!config.otp.secretKey) errors.push("OTP_SECRET_KEY is not set");
    if (!config.otp.gatewayUrl) errors.push("OTP_GATEWAY_URL is not set");
  } else {
    warnings.push("OTP_MOCK is on — payments are simulated by mock-otp/gateway.js. No real money moves.");
  }

  if (!config.otpMock && !config.appBaseUrl.startsWith("https://")) {
    errors.push("APP_BASE_URL must be a public https:// URL — OTP cannot reach localhost to deliver the webhook.");
  }

  if (config.delivery.mode === "off") {
    warnings.push(
      "DELIVERY_MODE=off — no delivery charge is added to any order. If Settings > Shipping " +
        "and delivery has priced rates, every customer is being undercharged by that amount."
    );
  }

  if (config.allowedOrigins.length === 0) {
    warnings.push("ALLOWED_ORIGINS is empty — browser calls from your storefront will be blocked by CORS.");
  }

  return { errors, warnings };
}

module.exports = { config, validate };
