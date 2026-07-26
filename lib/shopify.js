// Shopify Admin API client.
//
// Every call checks the HTTP status and throws a ShopifyError carrying the real
// response body. The original starter kit ignored response status, which meant a
// failed draft-order completion looked identical to a successful one — the customer
// pays, OTP gets a 200 "ok", and no order ever appears. That is the single most
// expensive bug in this kind of integration, so it is guarded here.

const fetch = require("node-fetch");
const https = require("https");
const { config } = require("./config");
const mock = require("./shopify-mock");

// Reuse connections to Shopify.
//
// node-fetch defaults to Node's global agent, which has keepAlive:false — so
// every single API call opens a fresh TCP+TLS connection and then tears it down.
// In a long-running server that piles up sockets in TIME_WAIT, and once that
// backlog is deep enough new connections simply stall. That is not theoretical:
// during the live QA run, three of five concurrent checkouts timed out after
// 15s, while the identical requests fired from a short-lived script all
// succeeded in under a second. Reusing connections also skips a TLS handshake
// per call, which is the bulk of the latency on a payment path.
const agent = new https.Agent({
  keepAlive: process.env.SHOPIFY_NO_KEEPALIVE !== "1",
  keepAliveMsecs: 10000,
  maxSockets: 25,
  timeout: 30000,
});

class ShopifyError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ShopifyError";
    this.status = status;
    this.body = body;
  }
}

// Without this, node-fetch waits forever. A single stalled connection to Shopify
// would then hang the customer's checkout request until their browser gives up,
// with the socket held open the whole time. Found during the live QA run, where
// exactly that happened partway through a batch of draft-order creates.
const TIMEOUT_MS = Number(process.env.SHOPIFY_TIMEOUT_MS || 15000);

// Retry only where a retry cannot cost the customer money.
//
// A connection-level failure (timeout, reset) means we never saw a response, so
// we cannot know whether Shopify processed the request. That is fine to retry
// for reads and deletes, and acceptable for creating a draft order — a stray
// duplicate draft is not an order and not a charge, and we only ever use the one
// we get back. It is NOT fine for completing a draft order, which is the step
// that turns into a real, paid order: that one is left to the webhook contract,
// which already returns 5xx so the gateway retries with its own idempotency.
const ATTEMPTS = 3;

function isRetryable(method, path, err, res) {
  const completing = /\/complete\.json/.test(path);
  if (completing) return false;
  // GraphQL calls all share one URL, so the check above cannot see which mutation
  // is being run. graphql() tags the path with the operation name for this reason:
  // if draft-order completion is ever moved off REST, it must stay un-retryable.
  if (/draftOrderComplete/.test(path)) return false;
  if (err) {
    // No response was seen at all.
    return err.type === "request-timeout" || ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "ENOTFOUND"].includes(err.code);
  }
  // Shopify throttling or a transient fault on their side.
  return res.status === 429 || res.status >= 500;
}

async function call(method, path, body) {
  // The operation tag graphql() appends is for isRetryable's benefit only — strip
  // it before it reaches the wire.
  const url = `https://${config.shopify.store}/admin/api/${config.shopify.apiVersion}${path.split("#")[0]}`;
  let res;
  let lastErr;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    res = undefined;
    lastErr = undefined;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Shopify-Access-Token": config.shopify.token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        timeout: TIMEOUT_MS,
        agent,
      });
    } catch (err) {
      lastErr = err;
    }

    if (attempt < ATTEMPTS && isRetryable(method, path, lastErr, res)) {
      const wait = 400 * attempt;
      console.warn(
        `[shopify] ${method} ${path} attempt ${attempt}/${ATTEMPTS} failed ` +
          `(${lastErr ? lastErr.type || lastErr.code || lastErr.message : "HTTP " + res.status}), retrying in ${wait}ms`
      );
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    break;
  }

  if (lastErr) {
    // node-fetch raises a FetchError of type "request-timeout" when it fires.
    // Surface it as a 504 so callers can tell "Shopify never answered" apart
    // from "Shopify said no" — the two need different handling on a payment path.
    if (lastErr.type === "request-timeout") {
      throw new ShopifyError(`Shopify ${method} ${path} timed out after ${TIMEOUT_MS}ms`, 504, {});
    }
    throw lastErr;
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    // 401/403 = bad token or missing scope. 422 = invalid line items (e.g. variant
    // sold out or not published to the sales channel). 429 = rate limited.
    throw new ShopifyError(
      `Shopify ${method} ${path} failed with ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      parsed
    );
  }
  return parsed;
}

// --- GraphQL --------------------------------------------------------------
//
// Almost everything here is REST, but two things are impossible over REST and
// this was confirmed against the live store, not assumed:
//
//   POST /draft_orders.json  { shipping_line: { handle } }  -> 201, shipping_line NULL
//   PUT  /draft_orders/:id   { shipping_line: { handle } }  -> 200, shipping_line NULL
//
// REST accepts a rate handle and silently discards it. No error, no warning —
// the draft is simply created with no delivery charge on it. That is the worst
// possible failure shape on a payment path: it looks like it worked. The same
// handle passed to GraphQL draftOrderCreate applies correctly (total 8900 ->
// 9259, custom:false), and the result reads back over REST perfectly.
//
// So: rate lookup and draft creation go over GraphQL; everything else stays REST.
async function graphql(operation, query, variables) {
  const body = await call("POST", `/graphql.json#${operation}`, { query, variables });
  if (body.errors?.length) {
    throw new ShopifyError(`Shopify GraphQL ${operation} failed: ${JSON.stringify(body.errors).slice(0, 400)}`, 400, body);
  }
  const payload = body.data?.[operation];
  // userErrors are Shopify saying "your input was wrong" with a 200 status. Left
  // unchecked they read as success and produce a null draft order.
  if (payload?.userErrors?.length) {
    throw new ShopifyError(
      `Shopify GraphQL ${operation} rejected the input: ${payload.userErrors.map((e) => e.message).join("; ")}`,
      422,
      payload.userErrors
    );
  }
  return payload;
}

// Shopify wants camelCase and a countryCode enum here, while REST wants
// snake_case and country_code. Same address, two spellings.
function toGraphqlAddress(a) {
  if (!a) return undefined;
  const out = {
    firstName: a.first_name ?? a.firstName,
    lastName: a.last_name ?? a.lastName,
    address1: a.address1,
    address2: a.address2,
    city: a.city,
    zip: a.zip,
    province: a.province,
    phone: a.phone,
    company: a.company,
    countryCode: (a.country_code ?? a.countryCode ?? "").toUpperCase() || undefined,
  };
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

const toGid = (id) => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/ProductVariant/${id}`);
const fromGid = (gid) => String(gid).split("/").pop();

const CALCULATE = `
mutation draftOrderCalculate($input: DraftOrderInput!) {
  draftOrderCalculate(input: $input) {
    calculatedDraftOrder {
      subtotalPrice
      totalPrice
      totalTax
      totalShippingPrice
      availableShippingRates { handle title price { amount currencyCode } }
    }
    userErrors { field message }
  }
}`;

const CREATE = `
mutation draftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      currencyCode
      subtotalPrice
      totalPrice
      totalTax
      totalShippingPrice
      shippingLine { title originalPriceSet { shopMoney { amount } } }
    }
    userErrors { field message }
  }
}`;

const real = {
  // What delivery options does Shopify itself offer for this cart and address?
  //
  // Deliberately asks Shopify rather than keeping our own price table: the rates
  // live in Settings > Shipping and delivery, which is where the merchant edits
  // them. A local copy would drift silently the first time they change a price.
  async getShippingRates({ lineItems, shippingAddress }) {
    const payload = await graphql("draftOrderCalculate", CALCULATE, {
      input: {
        lineItems: lineItems.map((li) => ({ variantId: toGid(li.variant_id), quantity: li.quantity })),
        shippingAddress: toGraphqlAddress(shippingAddress),
      },
    });
    const c = payload?.calculatedDraftOrder;
    return {
      subtotal: c?.subtotalPrice,
      total: c?.totalPrice,
      tax: c?.totalTax,
      rates: (c?.availableShippingRates || []).map((r) => ({
        handle: r.handle,
        title: r.title,
        price: r.price.amount,
        currency: r.price.currencyCode,
      })),
    };
  },

  async createDraftOrder({ lineItems, customer, shippingAddress, note, tags, shippingRateHandle }) {
    // Only GraphQL can attach a configured delivery rate, so any order that has
    // one goes down this path. Orders without delivery stay on the REST call
    // below, which is well-tested and returns the shape the rest of the app uses.
    if (shippingRateHandle) {
      const payload = await graphql("draftOrderCreate", CREATE, {
        input: {
          lineItems: lineItems.map((li) => ({ variantId: toGid(li.variant_id), quantity: li.quantity })),
          shippingAddress: toGraphqlAddress(shippingAddress),
          shippingLine: { shippingRateHandle },
          email: customer?.email || undefined,
          note,
          tags: tags ? String(tags).split(",").map((t) => t.trim()) : undefined,
        },
      });
      const d = payload?.draftOrder;
      if (!d) throw new ShopifyError("Shopify returned no draft_order", 200, {});
      // Normalised to the REST shape so callers do not have to care which API
      // created the draft.
      return {
        id: Number(fromGid(d.id)),
        name: d.name,
        status: "open",
        currency: d.currencyCode,
        subtotal_price: d.subtotalPrice,
        total_price: d.totalPrice,
        total_tax: d.totalTax,
        total_shipping_price: d.totalShippingPrice,
        shipping_line: d.shippingLine
          ? { title: d.shippingLine.title, price: d.shippingLine.originalPriceSet.shopMoney.amount, custom: false }
          : null,
      };
    }
    return real._createDraftOrderRest({ lineItems, customer, shippingAddress, note, tags });
  },

  async _createDraftOrderRest({ lineItems, customer, shippingAddress, note, tags }) {
    const draft_order = {
      line_items: lineItems,
      note,
      tags,
    };
    if (customer?.email) draft_order.email = customer.email;
    if (shippingAddress) draft_order.shipping_address = shippingAddress;

    const { draft_order: created } = await call("POST", "/draft_orders.json", { draft_order });
    if (!created) throw new ShopifyError("Shopify returned no draft_order", 200, {});
    return created;
  },

  async getDraftOrder(id) {
    const { draft_order } = await call("GET", `/draft_orders/${id}.json`);
    return draft_order;
  },

  // payment_pending=false marks the order as paid immediately, which is what we
  // want: OTP has already captured the funds by the time the webhook arrives.
  async completeDraftOrder(id) {
    const { draft_order } = await call("PUT", `/draft_orders/${id}/complete.json?payment_pending=false`);
    return draft_order;
  },

  async updateDraftOrder(id, fields) {
    const { draft_order } = await call("PUT", `/draft_orders/${id}.json`, { draft_order: fields });
    return draft_order;
  },

  async deleteDraftOrder(id) {
    await call("DELETE", `/draft_orders/${id}.json`);
  },

  // Stamp the gateway's transaction id onto the finished order.
  //
  // Completing a draft order produces a "manual" transaction with a null
  // authorization, so nothing on the Shopify order says which OTP payment paid
  // for it. That is fine until the first chargeback or the first month-end
  // reconciliation against OTP's settlement report, at which point the only link
  // between an order and a transaction lives in our audit log — searchable by
  // draft-order id, which is not what anyone has in front of them.
  //
  // note_attributes shows up in the admin order page and exports, so it is the
  // cheapest durable place to put it.
  async annotateOrder(orderId, { transactionId, orderRef }) {
    const attrs = [];
    if (transactionId) attrs.push({ name: "OTP transaction", value: String(transactionId) });
    if (orderRef) attrs.push({ name: "OTP order ref", value: String(orderRef) });
    return call("PUT", `/orders/${orderId}.json`, {
      order: { id: orderId, note_attributes: attrs, tags: "otp-paid" },
    });
  },
};

// Swap the whole client for the in-memory fake when SHOPIFY_MOCK is on.
module.exports = { ...(config.shopifyMock ? mock : real), ShopifyError };
