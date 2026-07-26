#!/usr/bin/env node
// Upload theme-checkout-snippet.js to the theme as assets/otp-checkout.js, and
// make sure theme.liquid loads it.
//
//   npm run install-snippet -- --theme <id>   # defaults to the published theme
//   npm run install-snippet -- --dry-run
//
// Why a script and not a copy-paste into the theme code editor: the snippet is
// going to change while OTP's spec settles, and a file that lives in two places
// drifts. This makes the repo the single source of truth — re-run it after any
// edit and the theme matches what is in git.
//
// BACKEND_URL is rewritten on the way out from APP_BASE_URL, so the copy in the
// theme always points at wherever this bridge is actually deployed. The
// placeholder in the repo file is never what ships.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { config } = require("../lib/config");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const DRY = process.argv.includes("--dry-run");
const themeArg = process.argv.indexOf("--theme");
const THEME_OVERRIDE = themeArg > -1 ? process.argv[themeArg + 1] : null;

const ASSET_KEY = "assets/otp-checkout.js";
// A marker so we can tell our own <script> tag from anything else in the layout,
// and replace it rather than appending a second copy on every run.
const TAG_START = "<!-- otp-checkout: added by scripts/install-snippet.js -->";
const TAG_END = "<!-- /otp-checkout -->";

async function api(method, pathname, body) {
  const res = await fetch(
    `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}${pathname}`,
    {
      method,
      headers: {
        "X-Shopify-Access-Token": config.shopify.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      timeout: 30000,
    }
  );
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

async function main() {
  if (!config.shopify.token) {
    console.error(red("\n  SHOPIFY_ADMIN_TOKEN is not set. Run: npm run get-token\n"));
    process.exit(1);
  }

  // 1. Which theme?
  const { themes } = await api("GET", "/themes.json");
  const theme = THEME_OVERRIDE
    ? themes.find((t) => String(t.id) === String(THEME_OVERRIDE))
    : themes.find((t) => t.role === "main");
  if (!theme) {
    console.error(red(`\n  Theme not found. Available:`));
    themes.forEach((t) => console.error(`    ${t.id}  ${t.name}  (${t.role})`));
    process.exit(1);
  }
  console.log(`\n  Theme: ${theme.name} (${theme.id}, role=${theme.role})`);
  if (theme.role === "main") {
    console.log(yellow("  This is the PUBLISHED theme — the one real customers see."));
  }

  // 2. Read the snippet and point it at this deployment.
  const src = fs.readFileSync(path.join(__dirname, "..", "theme-checkout-snippet.js"), "utf8");
  const backend = config.appBaseUrl;
  const patched = src.replace(
    /var BACKEND_URL = "[^"]*";/,
    `var BACKEND_URL = ${JSON.stringify(backend)};`
  );
  if (patched === src) {
    console.error(red("\n  Could not find the BACKEND_URL line to rewrite — refusing to upload."));
    process.exit(1);
  }
  console.log(`  BACKEND_URL -> ${backend}`);
  if (!/^https:/.test(backend) && !/localhost/.test(backend)) {
    console.log(yellow("  Warning: not https and not localhost. Browsers will block this."));
  }

  // 3. Upload the asset.
  if (DRY) {
    console.log(dim(`\n  --dry-run: would upload ${patched.length} bytes to ${ASSET_KEY}`));
  } else {
    await api("PUT", `/themes/${theme.id}/assets.json`, {
      asset: { key: ASSET_KEY, value: patched },
    });
    console.log(green(`  PASS  uploaded ${ASSET_KEY} (${patched.length} bytes)`));
  }

  // 4. Make sure layout/theme.liquid loads it, exactly once.
  const layoutRes = await api("GET", `/themes/${theme.id}/assets.json?asset[key]=layout/theme.liquid`);
  const layout = layoutRes.asset.value;

  const block =
    `${TAG_START}\n` +
    `  {{ 'otp-checkout.js' | asset_url | script_tag }}\n` +
    `  ${TAG_END}`;

  let next;
  const existing = new RegExp(`${TAG_START}[\\s\\S]*?${TAG_END}`);
  if (existing.test(layout)) {
    next = layout.replace(existing, block);
    console.log("  script tag already present — refreshed in place");
  } else if (/<\/head>/i.test(layout)) {
    next = layout.replace(/<\/head>/i, `  ${block}\n</head>`);
    console.log("  script tag inserted before </head>");
  } else {
    console.error(red("\n  No </head> in layout/theme.liquid — add the script tag by hand:"));
    console.error(`  ${block}`);
    process.exit(1);
  }

  if (next === layout) {
    console.log(dim("  layout unchanged"));
  } else if (DRY) {
    console.log(dim("  --dry-run: would update layout/theme.liquid"));
  } else {
    await api("PUT", `/themes/${theme.id}/assets.json`, {
      asset: { key: "layout/theme.liquid", value: next },
    });
    console.log(green("  PASS  layout/theme.liquid updated"));
  }

  console.log(`\n  Done. Storefront will load ${backend}/api/checkout on checkout.\n`);
}

main().catch((err) => {
  console.error(red(`\n  Failed: ${err.message}\n`));
  process.exit(1);
});
