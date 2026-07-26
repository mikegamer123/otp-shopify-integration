# Setup & action steps

Ordered by what unblocks what. Steps marked **YOU** need your login, your money, or
your credentials — I can't and won't do those.

Current state: the whole payment flow is built and passing 67 end-to-end tests
against mock versions of both Shopify and OTP. Nothing below is blocked on OTP
except Phase 4.

Store facts confirmed from the admin on 2026-07-25: **Nordis Garden**, Serbia,
**RSD**, timezone Belgrade, no custom domain yet, storefront password protection
**on**.

**The store answers on two hostnames and they are not interchangeable.** From
`GET /shop.json` (shop id `83109249252`, confirmed 2026-07-26):

| Field | Value | Use it for |
|---|---|---|
| `myshopify_domain` | `i4g1zh-4e.myshopify.com` | `SHOPIFY_STORE` — Admin API, OAuth `shop`, webhooks |
| `domain` | `nordis-garden.myshopify.com` | `ALLOWED_ORIGINS` — the storefront customers load |

Getting this backwards fails in two different ways: the wrong value in
`SHOPIFY_STORE` makes OAuth reject the callback with "Wrong shop", and omitting
the storefront domain from `ALLOWED_ORIGINS` makes the theme's `fetch()` to
`/api/checkout` fail CORS on every real checkout.

---

## Right now — no credentials needed

### 1. See the flow work (2 minutes)

```bash
npm run smoke
```

67 checks: successful payment, duplicate webhook, decline, abandonment, forged
signature, tampered amount, unknown order, the customer-facing status page for
every outcome, gateway restart mid-payment, input validation, delivery pricing and refusals, the customer being handed off to Shopify, and the mock gateway vanishing when OTP_MOCK=0. All should pass.

### 1b. QA against the real store (2 minutes)

```bash
npm run mock-gateway     # terminal 1
npm run dev              # terminal 2
npm run qa-live          # terminal 3
```

78 checks. Unlike `npm run smoke`, this uses **real draft orders in the real
store** with real variant ids — money, currency, encoding and id handling are
where mocks lie to you. The gateway stays mocked, so no money moves. Everything
it creates is deleted at the end, including on crash; pass `--keep` to inspect it
in the admin instead.

Covers: single item, multiple quantity, each variant, mixed cart, a 5-line cart
spanning all three products, an option-less product, a 269 700 RSD cart, amount
formatting, VAT, VAT on delivery, delivery pricing and the free-delivery
threshold either side, undeliverable addresses, Serbian diacritics, the same
variant listed twice, price tampering, delivery-price tampering, 8 validation
cases, an unknown variant, CORS both ways, five simultaneous checkouts, and full
approve / decline / duplicate-webhook flows.

It uses three QA products whose prices are deliberately all *different*, so a
wrong line total cannot coincidentally match a right one:

| Product | Variant | id | price |
|---|---|---|---|
| QA Test Stolica Nordic `9159834239204` | Hrast | `49507058811108` | 8 900 |
| | Orah | `49507058843876` | 10 900 |
| | Trešnja | `49507058876644` | 12 500 |
| QA Test Sto Malmö `9159922024676` | Hrast | `49507177398500` | 24 900 |
| | Orah | `49507177431268` | 31 900 |
| QA Test Trosed Oslo `9159893876964` | *(no options)* | `49507122249956` | 89 900 |

If you delete or edit those, update `V` at the top of
[scripts/qa-live.js](scripts/qa-live.js).

**VAT is already handled.** The store is tax-inclusive at 20%, so `total_price`
is what the customer pays and what OTP should charge. On an 89 900 RSD sofa the
embedded PDV is 14 983.33 — that is the figure fiscalization will need.

### 1c. Delivery

A Shopify draft order **never applies a delivery rate by itself.** Create one
with a full Serbian address and `shipping_line` comes back `null` and the total
equals the goods total — no error, nothing in the logs. The store's Serbia zone
has had a priced rate configured the whole time, so before this was wired up,
every order the bridge created undercharged by exactly that amount.

Worse, REST *accepts* a rate and throws it away. Both of these return success
and produce a draft order with no delivery on it:

```
POST /draft_orders.json  { shipping_line: { handle } }   -> 201, shipping_line null
PUT  /draft_orders/:id   { shipping_line: { handle } }   -> 200, shipping_line null
```

So rate lookup and draft creation go over **GraphQL** (`draftOrderCalculate`,
`draftOrderCreate`), which honours the handle; everything else stays REST. That
is the only reason this project touches GraphQL at all — see the comment block in
[lib/shopify.js](lib/shopify.js).

Rates live in the Shopify admin under **Settings → Shipping and delivery**, not
in this codebase, so you can change prices without a deploy:

| Zone | Option | Price | Transit |
|---|---|---|---|
| Serbia | Besplatna dostava (orders ≥ 50 000) | free | 5–8 days |
| Serbia | Стандардна | 359 | 3–5 days |
| Serbia | Ekspresna dostava | 1 490 | 1–2 days |
| International | International — *market not enabled, so no rates are returned* | 2 000 | — |

`/api/checkout` charges the **cheapest** available option unless the request
names one via `shippingRateTitle`. A client can never send a delivery *price*:
prices are re-read from Shopify server-side for that exact cart and address.

`DELIVERY_MODE=require` (the default) means a checkout that cannot resolve a rate
**fails** rather than shipping free — no address gives `400 address_required`, a
foreign address gives `400 no_rates_for_address`. Set `DELIVERY_MODE=off` only if
delivery really is free; it warns at boot.

> **This blocks storefront testing.** The theme snippet does not collect an
> address yet, so it will get `400 address_required`. Shopify returns no rates at
> all for a cart with no destination, so there is no way around it: the theme
> needs an address step (post to `/api/delivery/rates`, let the customer choose,
> then send `shippingAddress` + `shippingRateTitle`) before Phase 3 can proceed.

**Tax treatment — decided 2026-07-26: delivery is NOT taxed.** *"Charge sales tax
on shipping"* stays **off** in Settings → Taxes and duties. Goods carry PDV at 20%
and, because prices are tax-inclusive, that VAT is already inside `total_price`;
the delivery line carries none.

`npm run qa-live` asserts this on every run rather than warning about it, so if
that checkbox is ever switched on the suite fails instead of the change going
unnoticed. On a 9 259 RSD order the reported VAT is **1 483.33** (goods only); it
would be 1 543.17 if delivery were taxable.

**Phase 5 depends on this.** The fiscal receipt must use the same split — take the
goods VAT from `order.total_tax` and label the shipping line untaxed. Recomputing
VAT from `total_price` would silently tax delivery and put the fiscal record at
odds with the Shopify order on every order that has a delivery charge.

### 2. Click through it yourself (5 minutes)

Two terminals:

```bash
npm run mock-gateway     # terminal 1 — fake OTP payment page on :4000
npm run dev              # terminal 2 — the bridge on :3000
```

Then open **<http://localhost:3000>** and click **Start checkout**.

That's the whole thing. You'll be redirected to a mock payment page offering
**approve / decline / abandon** — pick one and watch both terminals. You can see the
draft order created, the signed callback arrive, and the order complete. This is
exactly the shape the real flow will have.

Try all three buttons — each is a distinct code path and each should tell the
customer something different:

| Button | Expected page |
|---|---|
| **Plati** | "Uplata potvrđena" — order completed in Shopify |
| **Odbij** | "Uplata nije odobrena" + *you have not been charged* + retry link |
| **Odustani** | "Uplata nije završena" after the timeout, + retry link |

To see the abandon path without waiting 15 minutes, set `ORDER_TIMEOUT_MINUTES=0`
in `.env` and restart.

Three things worth knowing so nothing looks broken:

- **<http://localhost:4000> is the fake bank, not your app.** Start from :3000.
- **You can't browse to `/pay` directly.** A hosted payment page is only ever
  reachable through a signed redirect — that's true of OTP's real page too. Opening
  it by hand gives you a "nothing to pay for yet" page, which is correct behaviour,
  not a failure.
- **A payment page left open across a server restart still works.** Both servers run
  under `node --watch` and restart whenever a file is saved. The payment page carries
  its state in signed hidden fields, so it survives that. If it's *genuinely* stale
  you get a "payment session expired" page telling you to start over — never a bare 404.

### 3. **YOU** — send OTP the spec questions

Open [QUESTIONS-FOR-OTP.md](QUESTIONS-FOR-OTP.md), copy the Serbian email, send it
to your OTP contact. Do this before the credentials arrive, not after — their
integration teams answer slowly and in batches.

The single most valuable thing to get from them is a **test vector**: sample input
fields plus the signature they expect. With that I can verify our signing is correct
before you ever have sandbox access, which removes the usual multi-day
"signature mismatch" debugging loop.

### 4. ~~Publish Elmora~~ — DONE 2026-07-25

**Elmora 1.0.4 is live** (theme id `162051817700`), published while the storefront
password was still on, so it cost nothing and every test from here runs against the
markup customers will actually get. Horizon 4.1.3 (id `162051358948`) is now a draft.

**Elmora's cart markup is now confirmed** — read from the Admin API on 2026-07-26
via `read_themes`, so no console-pasting was needed. Elmora is the only theme left
on the store; Horizon is gone.

There are two checkout buttons and both are already matched by
[theme-checkout-snippet.js](theme-checkout-snippet.js):

| Where | Button | Form |
|---|---|---|
| Cart page (`sections/main-cart-items.liquid`) | `#checkout` `.cart__checkout-button` `[name=checkout]` | `form#cart` |
| Cart drawer (`snippets/cart-drawer.liquid`) | `#CartDrawer-Checkout` `.cart__checkout-button` `[name=checkout]` | `form#CartDrawer-Form` |

The important detail: **both buttons sit outside their `<form>`** and are wired up
with the HTML `form=` attribute. The checkout button is also the *only* submit
button attached to the cart form, so pressing Enter in a quantity field makes it
the default submitter and posts to `/cart` with `checkout` set — landing on
Shopify's own checkout and skipping OTP entirely. The snippet's Enter-key guard
used `form.querySelector()`, which only sees descendants and so never fired.
Fixed on 2026-07-26 by switching to `event.submitter` plus a `form.elements` scan.

### 5. **YOU** — deploy it

Two hard requirements:

1. **A public HTTPS URL** for `/api/otp/webhook` — OTP's servers must reach it.
2. **HTTPS specifically.** The storefront sends
   `Content-Security-Policy: block-all-mixed-content; upgrade-insecure-requests`,
   so a plain-http backend is blocked from a customer's browser. `http://localhost`
   is exempt (that is why local testing works), but nothing else is.

Everything needed is in the repo: [Dockerfile](Dockerfile), [render.yaml](render.yaml),
`/health` for the platform health check, and `PORT` read from the environment.

#### Free tier, and what it actually costs you

Free hosting has two properties that matter for a payment bridge:

| | Effect | Handled? |
|---|---|---|
| Sleeps after ~15 min idle, 30–60s cold start | OTP's webhook may time out before we wake | **Partly.** Keep it awake with a 5-min external pinger (below). The platform can still restart at any time, so this is mitigation, not a fix. |
| Ephemeral filesystem | `data/payments.jsonl` wiped on restart/redeploy | **Yes.** `/order-status` falls back to Shopify's own draft-order state, so a wiped log degrades to "still processing" instead of telling a paying customer their order does not exist. Covered by smoke §10b. |

This is fine for the OTP **sandbox** phase, where no real money moves. Before the
first real card, move to an always-on instance (Render Starter ~$7/mo, or a ~€4/mo
VPS) and mount a volume at `/app/data`. That is on the go-live checklist.

**Keep-alive.** Not from Shopify — Flow is event-driven and its scheduled trigger
is too coarse, and a storefront ping only fires when someone visits, which is
circular on a quiet store. Use [uptimerobot.com](https://uptimerobot.com) free:
new HTTP(s) monitor → your `/health` URL → 5 minute interval. You get downtime
alerts for the payment bridge as a side effect, which is worth having anyway.
24/7 is ~730 instance-hours, inside Render's 750/month free allowance for one
service.

#### Deploy to Render

The repo is already a git repo with a clean initial commit and `.env` ignored.

```bash
# 1. Create an empty repo on github.com (private is fine), then:
git remote add origin https://github.com/<you>/otp-shopify-integration.git
git push -u origin main
```

Then in Render: **New → Blueprint → connect the repo**. It reads `render.yaml`
and creates the service. Set the secrets it asks for (`sync: false` in the
blueprint) in **Environment**:

```
SHOPIFY_STORE          i4g1zh-4e.myshopify.com
SHOPIFY_ADMIN_TOKEN    (from .env — never paste it into a chat or a PR)
OTP_MERCHANT_ID        (blank until OTP send credentials)
OTP_SECRET_KEY         (blank until OTP send credentials)
OTP_GATEWAY_URL        (blank until OTP send credentials)
```

`APP_BASE_URL` wires itself to the service's public URL. `OTP_MOCK` stays `1`
until OTP's sandbox credentials arrive — flipping it to `0` is what makes real
money move.

Finally, point the storefront at it and reinstall the snippet:

```bash
# .env: APP_BASE_URL=https://otp-shopify-bridge.onrender.com
npm run install-snippet
```

`install-snippet` rewrites `BACKEND_URL` from `APP_BASE_URL` on the way out, so
the theme copy always matches wherever this is deployed.

#### The demo gateway is deployed too

Anyone can run the full flow without this laptop: the mock bank is mounted **inside**
the bridge at `/mock-gateway`, so it is public and HTTPS like the rest of it.

    https://otp-shopify-integration.onrender.com/mock-gateway/

It is deliberately in-process rather than a second Render service, because Render
wants a verified payment card for a second service even on the free plan. It is
gated on `OTP_MOCK`, so the moment real payments are switched on it stops
existing — smoke asserts that in a separate process (`/mock-gateway/pay` and the
dev console both 404 with `OTP_MOCK=0`). A live store must never serve a page
with an "approve" button that completes orders without taking money.

`OTP_GATEWAY_URL` now defaults to `APP_BASE_URL/mock-gateway/pay`. When OTP send
credentials, set `OTP_MERCHANT_ID`, `OTP_SECRET_KEY` and `OTP_GATEWAY_URL` in the
Render dashboard and flip `OTP_MOCK` to `0`.

#### Or skip hosting for now

```bash
npx cloudflared tunnel --url http://localhost:3000
```
A temporary public HTTPS URL pointing at your laptop. Put it in `APP_BASE_URL`
and re-run `npm run install-snippet`. Fine for a sandbox test session; the URL
changes every restart.

---

## Phase 2 — Shopify (unblocks as soon as you make the token)

### 6. ~~Create the app~~ — DONE 2026-07-25

**`OTP Payment Bridge` is created and installed on nordis-garden.** Active version
`oauth-redirect-localhost`, scopes `write_draft_orders`, `read_draft_orders`,
`write_orders`, `read_orders`, `read_products`, `read_themes`. Non-embedded.

It lives in the **`niklux17@gmail.com`** dev organization (org `227862844`,
app `402373574657`) — not the store-owner address. Whoever holds that account
controls these credentials.

#### 6a. **YOU** — get the token (2 minutes)

Dev Dashboard apps do **not** hand out a static `shpat_` token the way legacy
custom apps did. They only expose a **Client ID** and **Secret**; the access token
has to be fetched over OAuth. There's a script for it:

1. `cp .env.example .env`
2. Open <https://dev.shopify.com/dashboard/227862844/apps/402373574657/settings>
   → **Credentials**, and copy **Client ID** and **Secret** into `.env` as
   `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`.
3. Stop `npm run dev` if it's running — the script needs port 3000.
4. Run:
   ```bash
   npm run get-token
   ```
5. It prints one URL. Open it while signed in to the Nordis Garden admin.
   The app is already installed, so Shopify bounces straight back.

If it fails with **"Wrong shop"**, `SHOPIFY_STORE` is not this store's permanent
domain — see the note at the top of this file. The script refuses to save a token
issued for a shop other than the one it asked about; that check is the reason a
wrong domain costs you a retry instead of a token bound to someone else's store.

The script verifies Shopify's HMAC and the CSRF nonce, exchanges the code for the
token, writes `SHOPIFY_ADMIN_TOKEN` into `.env`, and flips `SHOPIFY_MOCK=0`.
**It never prints the token** — nothing to accidentally paste or screenshot.

Then verify:
```bash
npm run check-shopify
```

<details>
<summary>The old instructions, for reference</summary>

### ~~6-legacy. verify your dev account, then create the app~~

Nordis Garden is on Shopify's **Dev Dashboard**. The old
*Settings → Apps → Develop apps* flow no longer exists on this store — that page
now only links out to the Dev Dashboard.

**6a. Verify the email.** Shopify has already created a dev account for you and
sent a verification mail to **web.nordisgarden@gmail.com**. Nothing works until
you click that link. Check spam — it's easy to miss.

**6b. Create the app** at <https://dev.shopify.com/dashboard>:

1. **Apps** → **Create app** → name it `OTP Payment Bridge`
2. **API access** / **Admin API scopes** → tick:
   - `write_draft_orders`  ← required
   - `read_draft_orders`   ← required
   - `write_orders`        ← required
   - `read_products`       *(optional — lets the check script pick a test product)*
   - `read_themes`         *(optional, read-only — lets me read your cart template
     directly instead of you pasting console output)*
3. **Save**
4. Install it on the **nordis-garden** store when prompted
5. Reveal the **Admin API access token** (starts with `shpat_`) — shown once

**6c. Put it in `.env`** (the file doesn't exist yet):

```bash
cd C:\Users\mihal\Desktop\otp-shopify-integration
cp .env.example .env
```

Then edit `.env` and set:
```
SHOPIFY_MOCK=0
SHOPIFY_ADMIN_TOKEN=shpat_...
```
`SHOPIFY_STORE` and `ALLOWED_ORIGINS` are already filled in for this store.

Paste the token into `.env` only — never into chat. It's gitignored.

> **This turned out to be wrong.** Step 5 above does not exist on the Dev
> Dashboard: there is no "reveal Admin API access token" screen, only a Client ID
> and Secret. That is why step 6a and `npm run get-token` exist. Kept here only so
> the correction is legible.

</details>

### 7. Verify the Shopify half alone

```bash
npm run check-shopify
```

This checks the token, checks the scopes, creates a real draft order in your store,
reads it back, and deletes it. Add `--keep` to leave it visible in
**Orders → Drafts**.

If it fails it tells you which of those four things broke and what to fix.

---

## Phase 3 — Theme wiring

### 8. **YOU** — log into Shopify CLI

```bash
npm install -g @shopify/cli@latest
shopify auth login
```

Opens a browser for you to approve. Then:

```bash
shopify theme list --store your-store.myshopify.com
shopify theme pull --store your-store.myshopify.com --theme <THEME_ID>
```

Tell me when the theme files are down and I'll adapt the snippet to Elmora's real
markup.

### 9. Test on a preview theme first — never the live one

```bash
shopify theme dev --store your-store.myshopify.com
```

Serves your local theme at a preview URL against real store data, without touching
what customers see. The checkout button will hit your local backend.

Only after that works do we push, and only to an **unpublished** theme:
```bash
shopify theme push --unpublished --theme "OTP test"
```
You publish it yourself, later, when you're ready.

---

## Phase 4 — OTP (blocked on credentials)

### 10. When the sandbox credentials arrive

Put them in `.env`:
```
OTP_MOCK=0
OTP_MERCHANT_ID=...
OTP_SECRET_KEY=...
OTP_GATEWAY_URL=https://...
APP_BASE_URL=https://your-tunnel-or-host
```

Then give me their docs and I'll rewrite [lib/otp-adapter.js](lib/otp-adapter.js).
That's the only file that changes — everything else, including the whole test suite,
stays as-is.

### 11. Re-run the same tests against the real sandbox

The smoke test cases were written to be gateway-agnostic. Same seven scenarios, real
test cards. We work through them one at a time and I'll tell you what a correct
result looks like for each.

---

## Phase 5 — Fiscalization & go-live

### 12. Fiscalization

Serbian law requires a fiscal receipt on every completed retail sale, through a
licensed L-PFR provider. `issueFiscalReceipt()` in [server.js](server.js) is the hook
— send me your provider's docs when you have them.

Note the failure handling is already built: if fiscalization fails, the order still
completes (the customer's money is already taken, refusing the order would be worse)
and the failure is written to the audit log as
`fiscal.FAILED_NEEDS_MANUAL_RETRY` for you to action.

### 13. Go-live checklist

Nothing here happens until a real sandbox purchase has completed end-to-end.

- [ ] `npm run smoke` green against OTP **sandbox**, not mocks
- [ ] `OTP_MOCK=0`, `SHOPIFY_MOCK=0` in production env
- [ ] `APP_BASE_URL` is the real public HTTPS URL
- [ ] `ALLOWED_ORIGINS` lists your real storefront domains
- [ ] `OTP_GATEWAY_URL` switched from sandbox to production
- [ ] Webhook URL registered with OTP for the production merchant ID
- [ ] Audit log pointed at durable storage, not local disk
- [ ] One real card, one real small purchase, by you
- [ ] Refund that purchase and confirm the refund path works
- [ ] Fiscal receipt actually issued for that purchase
- [ ] **Then** remove the store password

---

## What's mocked vs real

| Piece | State |
|---|---|
| Shopify draft order create/complete/delete | Real API calls, mockable via `SHOPIFY_MOCK` |
| Webhook signature verification | Real, but the recipe is a guess until OTP confirms |
| Idempotency, decline, abandonment handling | Real and tested |
| OTP request/callback field names | **Placeholder** — see `SPEC:` markers in `lib/otp-adapter.js` |
| Fiscalization | **Stub** |
| Audit log durability | Dev-only (local file) |
