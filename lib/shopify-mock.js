// In-memory stand-in for the Shopify Admin API.
//
// Exists so the full payment flow is testable before you have an Admin API token.
// It mimics only what this integration touches, including the behaviour that
// matters most: a draft order that is already "completed" cannot be completed
// again. That is what the webhook's idempotency check relies on.

const store = new Map();
// Whatever annotateOrder stamped onto a completed order, keyed by order id.
const orderAnnotations = new Map();

// Seeded from the clock, NOT a fixed constant. With a fixed seed every restart
// reissues the same draft-order ids, and /order-status — which looks orders up in
// the append-only audit log — would find last run's verdict for this run's order.
// You'd click "decline" and be told the payment succeeded.
// Millisecond seed plus jitter, so two runs started in the same second can't
// collide either. Stays well under Number.MAX_SAFE_INTEGER.
let nextId = Date.now() * 1000 + Math.floor(Math.random() * 1000);

const clone = (o) => JSON.parse(JSON.stringify(o));

// Deliberately fake prices — the real total comes from Shopify, which applies
// your actual product pricing, shipping and tax rules.
const PRICE_PER_UNIT = 1200.0;

// Mirrors the rates configured in the real store's Serbia zone, so the mock
// exercises the same shapes: a flat rate, a pricier express one, and a
// conditional free rate that only appears above a threshold. The handles are
// opaque strings here; in production they are Shopify-signed JWTs.
const FREE_DELIVERY_OVER = 50000;
const RATES = [
  { handle: "mock-standard", title: "Стандардна", price: "359.00" },
  { handle: "mock-express", title: "Ekspresna dostava", price: "1490.00" },
];
const FREE_RATE = { handle: "mock-free", title: "Besplatna dostava", price: "0.00" };

const subtotalOf = (lineItems) =>
  (lineItems || []).reduce((sum, li) => sum + PRICE_PER_UNIT * li.quantity, 0);

module.exports = {
  async getShippingRates({ lineItems, shippingAddress }) {
    const country = (shippingAddress?.country_code || shippingAddress?.countryCode || "").toUpperCase();
    const subtotal = subtotalOf(lineItems);
    // Anywhere but Serbia has no zone, exactly as the live store behaves for an
    // address outside its enabled market.
    const rates = country === "RS" ? [...(subtotal >= FREE_DELIVERY_OVER ? [FREE_RATE] : []), ...RATES] : [];
    return { subtotal: subtotal.toFixed(2), total: subtotal.toFixed(2), tax: (subtotal / 6).toFixed(2), rates };
  },

  async createDraftOrder({ lineItems, customer, shippingAddress, note, tags, shippingRateHandle }) {
    const id = nextId++;
    const items = (lineItems || []).map((li) => ({
      variant_id: li.variant_id,
      quantity: li.quantity,
      price: PRICE_PER_UNIT.toFixed(2),
    }));
    const subtotal = subtotalOf(lineItems);

    const rate = shippingRateHandle
      ? [FREE_RATE, ...RATES].find((r) => r.handle === shippingRateHandle)
      : null;
    const shipping = rate ? Number(rate.price) : 0;

    const draft = {
      id,
      status: "open",
      // The status page ages an open draft from this when the audit log is
      // missing, so the mock has to carry it too.
      created_at: new Date().toISOString(),
      currency: "RSD",
      subtotal_price: subtotal.toFixed(2),
      total_price: (subtotal + shipping).toFixed(2),
      total_shipping_price: shipping.toFixed(2),
      shipping_line: rate ? { title: rate.title, price: rate.price, custom: false } : null,
      line_items: items,
      email: customer?.email,
      shipping_address: shippingAddress,
      note,
      tags: tags || "",
      order_id: null,
    };
    store.set(String(id), draft);
    return clone(draft);
  },

  async getDraftOrder(id) {
    const d = store.get(String(id));
    if (!d) {
      const err = new Error(`mock Shopify: draft order ${id} not found`);
      err.status = 404;
      throw err;
    }
    return clone(d);
  },

  async completeDraftOrder(id) {
    const d = store.get(String(id));
    if (!d) {
      const err = new Error(`mock Shopify: draft order ${id} not found`);
      err.status = 404;
      throw err;
    }
    if (d.status === "completed") {
      const err = new Error(`mock Shopify: draft order ${id} is already completed`);
      err.status = 422;
      throw err;
    }
    d.status = "completed";
    d.order_id = d.id + 1;
    return clone(d);
  },

  async updateDraftOrder(id, fields) {
    const d = store.get(String(id));
    if (!d) {
      const err = new Error(`mock Shopify: draft order ${id} not found`);
      err.status = 404;
      throw err;
    }
    Object.assign(d, fields);
    return clone(d);
  },

  async deleteDraftOrder(id) {
    store.delete(String(id));
  },

  async annotateOrder(orderId, { transactionId, orderRef }) {
    orderAnnotations.set(String(orderId), { transactionId, orderRef, tags: "otp-paid" });
    return { order: { id: orderId } };
  },

  _annotationFor(orderId) {
    return orderAnnotations.get(String(orderId)) || null;
  },

  _reset() {
    store.clear();
    orderAnnotations.clear();
  },
};
