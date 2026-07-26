// ===========================================================================
// PASTE THIS INTO YOUR BROWSER CONSOLE ON YOUR STOREFRONT'S CART PAGE.
// ===========================================================================
// It reports what Elmora's checkout button actually looks like, so we adapt the
// snippet to real markup instead of guessing. It only reads the page — it does
// not click anything, submit anything, or contact your backend.
//
// How to run it:
//   1. Open your store, add a product to the cart, open the cart / cart drawer.
//      (If the store password page appears, enter your password first.)
//   2. Press F12 -> Console tab.
//   3. Paste this whole file, press Enter.
//   4. Copy the output back to me.
// ===========================================================================

(function () {
  var CANDIDATES = [
    '[name="checkout"]',
    'button[name="checkout"]',
    'input[name="checkout"]',
    '[href="/checkout"]',
    'a[href$="/checkout"]',
    ".cart__checkout-button",
    ".cart__checkout",
    "#checkout",
  ];

  console.log("%c--- OTP checkout-button discovery ---", "font-weight:bold;font-size:14px");
  console.log("Theme:", window.Shopify && window.Shopify.theme ? window.Shopify.theme : "(unknown)");
  console.log("Shop:", window.Shopify ? window.Shopify.shop : "(unknown)");
  console.log("Currency:", window.Shopify ? window.Shopify.currency : "(unknown)");

  var found = [];
  CANDIDATES.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      if (found.indexOf(el) === -1) found.push(el);
    });
  });

  // Also catch anything whose visible text looks like a checkout action, in case
  // Elmora uses markup none of the standard selectors match.
  var TEXT = /checkout|plaćanje|placanje|nastavi|kasa|naruči|naruci/i;
  document.querySelectorAll("button, a, input[type=submit]").forEach(function (el) {
    var label = (el.textContent || el.value || "").trim();
    if (TEXT.test(label) && found.indexOf(el) === -1) found.push(el);
  });

  if (found.length === 0) {
    console.warn("No checkout button found. Is the cart open and non-empty?");
    return;
  }

  console.log("\nFound " + found.length + " candidate(s):\n");
  found.forEach(function (el, i) {
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && path.length < 5) {
      var part = node.tagName.toLowerCase();
      if (node.id) part += "#" + node.id;
      if (node.className && typeof node.className === "string") {
        part += "." + node.className.trim().split(/\s+/).slice(0, 3).join(".");
      }
      path.unshift(part);
      node = node.parentElement;
    }
    console.log(
      "[" + (i + 1) + "] <" + el.tagName.toLowerCase() + ">",
      "\n     text:      " + JSON.stringify((el.textContent || el.value || "").trim().slice(0, 60)),
      "\n     name:      " + (el.getAttribute("name") || "—"),
      "\n     id:        " + (el.id || "—"),
      "\n     class:     " + (el.className || "—"),
      "\n     href:      " + (el.getAttribute("href") || "—"),
      "\n     in form:   " + (el.closest("form") ? el.closest("form").getAttribute("action") : "—"),
      "\n     in drawer: " + (el.closest("[class*=drawer], [id*=drawer], dialog") ? "YES" : "no"),
      "\n     dom path:  " + path.join(" > ")
    );
  });

  // Is there anywhere to collect an email on this page?
  var emailFields = document.querySelectorAll("input[type=email], #customer-email, [name*=email]");
  console.log("\nEmail input fields on this page: " + emailFields.length);
  emailFields.forEach(function (el) {
    console.log("     name=" + (el.name || "—") + " id=" + (el.id || "—") + " type=" + el.type);
  });

  console.log(
    "\nLogged-in customer: " +
      (window.__st && window.__st.cid ? "yes (id " + window.__st.cid + ")" : "no / unknown")
  );
  console.log("\n--- copy everything above this line ---");
})();
