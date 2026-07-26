# OTP banka + Shopify payment integration

A backend service that sits between a Shopify store and OTP banka Srbija's payment
gateway (iPay). Shopify Payments doesn't support Serbia, so this service owns the
payment step: it creates a draft order in Shopify, sends the customer to OTP's
hosted payment page, and completes the order when OTP sends back a signed result.

It is **not** a Shopify app and doesn't need certification. Shopify is used purely
as the order/inventory system of record.

## Start here

**[SETUP.md](SETUP.md)** — ordered action steps, marked with which ones need your
credentials.

## Run it now, with no credentials

```bash
npm install
npm run smoke
```

Mock implementations of both Shopify and the OTP gateway are included, so the full
flow — redirect, payment, signed callback, order completion — is testable today.

```bash
npm run mock-gateway   # fake OTP hosted payment page on :4000
npm run dev            # the bridge on :3000
npm run check-shopify  # verify your real Shopify token (after step 6 of SETUP.md)
```

## Layout

```
server.js                     routes and payment orchestration
lib/config.js                 env loading + boot-time validation
lib/otp-adapter.js            >>> ALL OTP-specific logic. The only file that
                                  changes when their real spec arrives. <<<
lib/shopify.js                Admin API client (throws on non-2xx)
lib/shopify-mock.js           in-memory Shopify for credential-free testing
lib/audit.js                  append-only payment event log
mock-otp/gateway.js           fake hosted IPG: approve / decline / abandon, retries
scripts/smoke.js              18-check end-to-end test of the payment flow
scripts/check-shopify.js      standalone Shopify connectivity + scope check
scripts/find-checkout-button.js   browser-console snippet to identify theme markup
theme-checkout-snippet.js     storefront checkout interceptor
QUESTIONS-FOR-OTP.md          the spec questions to send OTP, with answer mapping
```

## Design rules this code follows

- **The webhook is the only source of truth.** The browser redirect never completes
  an order — a customer can close the tab, replay the URL, or edit it.
- **The webhook is idempotent.** Gateways retry until they get a 200. Shopify's own
  draft-order status is the lock, so no extra database is needed.
- **Completion failures return 5xx**, so the gateway retries. Returning 200 on a
  failed completion strands a customer who has already paid — the most expensive
  bug available in this design.
- **The browser never sends prices.** Only variant ids and quantities. The total
  comes from Shopify.
- **Declined payments leave no orphaned draft orders.**
- **Signatures are computed over an explicit ordered field list**, never
  `Object.values()`, whose order depends on JSON key insertion order.

## Status

| | |
|---|---|
| Payment flow, error handling, tests | Built, 18/18 passing against mocks |
| Shopify integration | Real, needs your Admin API token to verify |
| OTP field names / signing recipe | **Placeholder** until their docs arrive — see `SPEC:` markers in `lib/otp-adapter.js` |
| Fiscalization | Stub — Phase 5 |
