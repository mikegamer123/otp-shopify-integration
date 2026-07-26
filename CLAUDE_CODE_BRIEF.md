# Claude Code — Project Brief: Shopify + OTP banka payment integration

## Context

I run a Shopify store based in Serbia. Shopify Payments does not support Serbia,
so I'm integrating **OTP banka Srbija's** payment gateway (processed via iPay)
using a **draft-order + hosted-redirect + webhook** pattern. This avoids needing
Shopify Payments App certification — my backend owns the payment step and uses
Shopify only as the order/inventory system of record.

My storefront uses a standard Shopify theme (**Elmora** — corrected 2026-07-25;
an earlier draft of this brief said Horizon, which was wrong).
The store is currently password-protected while we build. Do NOT tell me to
remove the password until a full sandbox test passes.

This folder already contains a starter kit:
- `server.js` — the backend bridge (Express). Shopify Admin API calls are real;
  the OTP request/response fields are PLACEHOLDERS shaped like a standard Serbian
  hosted-IPG gateway. They must be replaced with OTP's real spec once I have it.
- `theme-checkout-snippet.js` — front-end snippet that intercepts checkout, reads
  the cart via Shopify's `/cart.js`, and POSTs it to the backend.
- `package.json`, `.env.example`, `README.md`.

## How I want you to work

You build and test locally. You do NOT log into my accounts or deploy to live
services yourself. Whenever a step needs my credentials, my money, or my account
login, STOP and hand me the exact command or click-path to do it myself, then
wait for me to confirm before continuing. Specifically, these are MINE to do:

- Logging into Shopify CLI (browser auth)
- Creating the Shopify custom app and pasting the Admin API token into `.env`
- Signing into and approving any deployment (Vercel/Netlify/etc.)
- Entering the OTP merchant ID / secret key when they arrive
- Removing the store password / going live

Never ask me to paste a token or secret into the chat — tell me to put it in
`.env` directly. Never commit `.env` to git (add it to `.gitignore` if missing).

## Task order — do these in sequence, pausing where noted

**Phase 1 — Local setup & sanity check (you can do most of this)**
1. Run `npm install`. Confirm the server starts with `npm run dev` (it'll warn
   about missing env vars — that's expected).
2. Create a `.gitignore` that excludes `.env` and `node_modules` if not present.
3. Review `server.js` and explain, in plain terms, what each endpoint does before
   we change anything.

**Phase 2 — Shopify connection (I do the login/token steps)**
4. Tell me exactly how to create a Shopify custom app and which Admin API scopes
   to enable (`write_draft_orders`, `read_draft_orders`, `write_orders`), how to
   install it, and where to copy the Admin API access token from. Wait while I
   put it in `.env`.
5. Once my token is in `.env`, test ONLY the Shopify half: simulate a cart and
   confirm a draft order actually appears in my Shopify admin's Orders tab. Do
   NOT involve OTP yet. Fix anything until this works cleanly.

**Phase 3 — Theme wiring (you edit, via Shopify CLI after I log in)**
6. Walk me through logging into Shopify CLI myself. Then pull my live theme down
   locally.
7. Locate the actual checkout button markup in my theme (Elmora — confirm the
   real selector; don't assume). Adapt `theme-checkout-snippet.js` to that theme's
   real button and cart structure, and to where I collect customer email.
8. Explain how to test the snippet locally/on a preview theme BEFORE pushing to
   the live theme. Push only after I approve.

**Phase 4 — OTP integration (blocked until my sandbox credentials arrive)**
9. When I bring OTP's developer docs + sandbox credentials, replace the placeholder
   OTP fields in `server.js` (endpoint URL, field names, signing algorithm) with
   the real spec. Ask me for any doc details you need that I haven't given you.
10. Implement robust handling for: successful payment, declined payment, and
    abandoned/timeout. Ensure failed payments never leave orphaned draft orders.
11. Test end-to-end against OTP's sandbox using their test cards. Walk me through
    each test case and what a correct result looks like.

**Phase 5 — Fiscalization & deploy (I approve deploy & go-live)**
12. Wire `issueFiscalReceipt()` to call my fiscalization provider's API (I'll give
    you its docs). This is a Serbian legal requirement on every completed sale.
13. Recommend a serverless host, and hand me the deploy steps to run myself. Make
    sure `/api/otp/webhook` is reachable at a public HTTPS URL, since that's the
    authoritative payment confirmation — not the browser redirect.
14. Give me a final go-live checklist. Do NOT tell me to remove the store password
    until a real sandbox purchase has completed successfully end-to-end.

## Safety rules (important — payment code)

- Treat the webhook as the single source of truth for payment success. Never mark
  an order paid based on the browser redirect alone (a customer can spoof or
  abandon that).
- Always verify the OTP webhook signature before acting on it.
- Test every case against the sandbox before any real card is used.
- When in doubt about anything involving real money, real cards, or going live,
  stop and ask me rather than proceeding.

Start with Phase 1 and check in with me after each phase.
