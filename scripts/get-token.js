#!/usr/bin/env node
// One-time OAuth helper: turns the app's Client ID + Secret into a permanent
// Admin API access token and writes it straight into .env.
//
// WHY THIS EXISTS
// ---------------
// Nordis Garden is on Shopify's Dev Dashboard, not the legacy "Develop apps"
// flow. Legacy custom apps handed you a static shpat_ token in the admin UI.
// Dev Dashboard apps do not: they only expose a Client ID and Secret, and the
// access token has to be obtained through OAuth. This script performs that
// exchange once, locally.
//
// The token is never printed and never passes through a terminal you might
// screenshot or paste. It goes from Shopify's response directly into .env.
//
// Usage:  npm run get-token
//
// Requires in .env:  SHOPIFY_STORE, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
// Requires in the Dev Dashboard: redirect URL http://localhost:3000/auth/callback

require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const ENV_PATH = path.join(__dirname, "..", ".env");

// Must match a Redirect URL registered on the app version, byte for byte.
const CALLBACK_PORT = 3000;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

const SCOPES = [
  "write_draft_orders",
  "read_draft_orders",
  "write_orders",
  "read_orders",
  "read_products",
  "read_themes",
  // write_themes uploads assets/otp-checkout.js to the theme. Without it the
  // snippet has to be pasted by hand into the theme code editor every time it
  // changes, which is exactly the sort of manual step that drifts out of sync
  // with the file in this repo.
  "write_themes",
].join(",");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const store = process.env.SHOPIFY_STORE;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

function die(msg, hint) {
  console.error(red(`\n  ${msg}`));
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

// The permanent .myshopify.com domain, NOT the admin handle. For this store the
// two differ: the admin lives at .../store/nordis-garden but the domain is
// i4g1zh-4e.myshopify.com, and nordis-garden.myshopify.com is someone else's shop.
if (!store) die("SHOPIFY_STORE is not set in .env", "Expected: i4g1zh-4e.myshopify.com");
if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(store)) {
  die(`SHOPIFY_STORE looks wrong: ${store}`, "Use the .myshopify.com domain, not a custom domain.");
}
if (!clientId || !clientSecret) {
  die(
    "SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET are not set in .env",
    "Dev Dashboard > OTP Payment Bridge > Settings > Credentials."
  );
}

// CSRF nonce. Shopify echoes this back; a mismatch means the callback did not
// originate from the authorize request we just made.
const state = crypto.randomBytes(24).toString("hex");

/**
 * Shopify signs callback query params with the app secret. Verifying it proves
 * the redirect really came from Shopify and nobody tampered with `code`.
 * Everything except `hmac` is sorted and joined, then HMAC-SHA256'd.
 */
function verifyHmac(params) {
  const received = params.get("hmac");
  if (!received) return false;

  const pairs = [];
  for (const [k, v] of params) {
    if (k === "hmac" || k === "signature") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();

  const digest = crypto
    .createHmac("sha256", clientSecret)
    .update(pairs.join("&"), "utf8")
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(received, "utf8");
  // timingSafeEqual throws on length mismatch, so check length first.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Write (or replace) a key in .env without disturbing anything else in the file.
 * Deliberately does not log the value.
 */
function writeEnv(key, value) {
  let text = "";
  try {
    text = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    die(".env does not exist", "Run: cp .env.example .env");
  }

  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  const next = re.test(text)
    ? text.replace(re, line)
    : text.replace(/\s*$/, "\n") + line + "\n";

  fs.writeFileSync(ENV_PATH, next, "utf8");
}

async function exchangeCodeForToken(code) {
  const res = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Shopify returned ${res.status}: ${body.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`Shopify returned non-JSON: ${body.slice(0, 300)}`);
  }
  if (!json.access_token) {
    throw new Error(`No access_token in response: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

const authorizeUrl =
  `https://${store}/admin/oauth/authorize` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${state}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);

  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not the callback path.");
  }

  const params = url.searchParams;
  const page = (title, detail) =>
    `<!doctype html><meta charset="utf-8">` +
    `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;line-height:1.5">` +
    `<h1 style="font-size:1.3rem">${title}</h1><p>${detail}</p></body>`;

  const fail = (status, title, detail) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(title, detail));
    console.error(red(`\n  FAIL  ${title}`));
    console.error(`        ${detail}\n`);
    server.close();
    process.exit(1);
  };

  if (params.get("state") !== state) {
    return fail(400, "State mismatch", "This callback did not come from the link this script printed. Nothing was saved.");
  }
  if (params.get("shop") !== store) {
    return fail(400, "Wrong shop", `Callback was for ${params.get("shop")}, expected ${store}. Nothing was saved.`);
  }
  if (!verifyHmac(params)) {
    return fail(400, "Signature check failed", "The callback was not signed by Shopify with this app's secret. Nothing was saved.");
  }

  const code = params.get("code");
  if (!code) return fail(400, "No authorization code", "Shopify did not return a code.");

  try {
    const result = await exchangeCodeForToken(code);
    writeEnv("SHOPIFY_ADMIN_TOKEN", result.access_token);
    writeEnv("SHOPIFY_MOCK", "0");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page("Token saved", "Written to <code>.env</code>. You can close this tab and go back to the terminal."));

    console.log(green("\n  PASS  Access token written to .env"));
    console.log(`        Granted scopes: ${result.scope || "(not reported)"}`);
    console.log(`        SHOPIFY_MOCK set to 0 so the app now talks to the real store.`);
    console.log(dim("\n        The token was not printed anywhere. Next: npm run check-shopify\n"));

    server.close();
    process.exit(0);
  } catch (err) {
    return fail(500, "Token exchange failed", String(err.message || err));
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    die(
      `Port ${CALLBACK_PORT} is already in use.`,
      "Stop `npm run dev` first — this script needs that port for the OAuth callback."
    );
  }
  die(String(err.message || err));
});

server.listen(CALLBACK_PORT, () => {
  console.log(`\n  Waiting for Shopify on ${REDIRECT_URI}`);
  console.log("\n  Open this URL in a browser signed in to the Nordis Garden admin:\n");
  console.log(`  ${authorizeUrl}\n`);
  console.log(dim("  The app is already installed, so Shopify should bounce straight back."));
  console.log(dim("  Ctrl-C to abort — nothing is written until the exchange succeeds.\n"));
});
