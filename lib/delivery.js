// Which delivery rate a given cart gets charged.
//
// The prices themselves are NOT here — they live in Shopify under
// Settings > Shipping and delivery, and are read back per cart via
// shopify.getShippingRates(). This file only decides *which* of the rates
// Shopify offers gets applied, and refuses to guess when it cannot tell.
//
// Why this exists at all: a Shopify draft order never applies a delivery rate
// by itself. Create one with a full Serbian address and shipping_line comes
// back null, total == goods total. Nordis Garden has had a 359 RSD domestic
// rate configured the whole time, so every order this bridge created was
// undercharging by exactly that much and looking completely healthy doing it.
//
// The failure mode to design against is therefore silence, not errors: anything
// this module is unsure about must stop the checkout, never fall through to
// "no delivery charge".

const { config } = require("./config");

class DeliveryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DeliveryError";
    this.status = 400;
    this.code = code;
  }
}

// A shipping address is only useful to us if it has enough in it for Shopify to
// match a delivery zone. Country is what actually selects the zone; the rest is
// for the courier. An address that is present but empty is worse than none —
// it looks like the customer supplied one.
function hasUsableAddress(a) {
  return !!(a && (a.country_code || a.countryCode) && (a.city || a.zip));
}

// Pick from what Shopify offered for THIS cart and THIS address.
//
// The client may name a rate, but only by title, and only one that appears in
// the list Shopify just returned. It can never send a price. A rate handle is a
// Shopify-signed JWT carrying the price, so even a handle echoed back by a
// hostile client is price-safe — but it could be a handle from a *different*
// cart (a cheap cart's free-shipping handle replayed onto an expensive one), so
// handles from the client are not accepted either.
function selectRate(rates, requestedTitle) {
  if (requestedTitle) {
    const match = rates.find((r) => r.title === requestedTitle);
    if (!match) {
      throw new DeliveryError(
        `delivery option "${requestedTitle}" is not available for this cart`,
        "rate_not_available"
      );
    }
    return match;
  }
  // No preference: charge the least. If the cart qualifies for free delivery,
  // that is what free delivery means.
  return rates.slice().sort((a, b) => Number(a.price) - Number(b.price))[0];
}

// Returns { handle, title, price } to apply, or null when delivery is switched off.
// Throws DeliveryError when delivery is required but cannot be determined —
// which the caller must surface, not swallow.
async function resolve({ shopify, lineItems, shippingAddress, shippingRateTitle }) {
  if (config.delivery.mode === "off") return null;

  if (!hasUsableAddress(shippingAddress)) {
    throw new DeliveryError(
      "a delivery address (country and city or postcode) is required before payment",
      "address_required"
    );
  }

  const { rates } = await shopify.getShippingRates({ lineItems, shippingAddress });

  if (!rates.length) {
    // Shopify has no zone covering this address. Confirmed with a German
    // address: rates come back empty AND tax drops to 0, so proceeding would
    // ship a sofa abroad for the price of the sofa alone.
    throw new DeliveryError(
      "we do not deliver to that address",
      "no_rates_for_address"
    );
  }

  const chosen = selectRate(rates, shippingRateTitle);
  return { handle: chosen.handle, title: chosen.title, price: chosen.price };
}

module.exports = { resolve, selectRate, hasUsableAddress, DeliveryError };
