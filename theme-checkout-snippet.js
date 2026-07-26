// Theme-side checkout interceptor.
//
// Install as assets/otp-checkout.js and load it on every page (see SETUP.md
// step 6). It replaces the native checkout button's behaviour with a call to
// your backend, which creates the draft order and returns OTP's payment URL.
//
// ---------------------------------------------------------------------------
// WHY THIS IS WRITTEN WITH EVENT DELEGATION
// ---------------------------------------------------------------------------
// The original version did `document.querySelector('[name="checkout"]')` inside
// DOMContentLoaded. That silently does nothing on any modern Shopify theme,
// because the cart is a DRAWER that gets rendered (and re-rendered on every
// quantity change) after page load — so at DOMContentLoaded the button does not
// exist yet, and after each cart update the old listener is thrown away with the
// old DOM node.
//
// Instead this listens on `document` in the CAPTURE phase, which catches the
// click before the theme's own handlers run, and keeps working no matter how
// many times the drawer re-renders. It is theme-agnostic on purpose — it should
// work on Elmora without modification, but CONFIRM the selector list below
// against your real theme using scripts/find-checkout-button.js.

(function () {
  "use strict";

  // --- Configure me ---------------------------------------------------------
  var BACKEND_URL = "https://your-backend-domain.com"; // no trailing slash

  // Every element that means "take me to checkout". Shopify themes converge on
  // these; the first two cover the overwhelming majority.
  var CHECKOUT_SELECTORS = [
    '[name="checkout"]',
    'button[name="checkout"]',
    'input[name="checkout"]',
    '[href="/checkout"]',
    'a[href$="/checkout"]',
    ".cart__checkout-button",
    ".cart__checkout",
    "#checkout",
  ].join(",");

  var busy = false;

  document.addEventListener(
    "click",
    function (event) {
      var node = event.target;
      if (!node || !node.closest) return; // text/document targets have no closest()
      var target = node.closest(CHECKOUT_SELECTORS);
      if (!target) return;

      event.preventDefault();
      event.stopPropagation(); // keep the theme from also navigating to /checkout
      startPayment(target);
    },
    true // capture phase — run before the theme's own listeners
  );

  // Pressing Enter in the cart form submits it without a click event.
  //
  // CONFIRMED AGAINST ELMORA 2026-07-26: both checkout buttons sit OUTSIDE their
  // <form> and are wired up with the HTML form= attribute —
  //   cart page: <form id="cart"> closes, then <button name="checkout" form="cart">
  //   drawer:    <form id="CartDrawer-Form"> closes, then <button form="CartDrawer-Form">
  // so form.querySelector() (descendants only) finds nothing. That matters
  // because the checkout button is the ONLY submit button associated with the
  // cart form, so hitting Enter in a quantity field makes it the default
  // submitter and posts to /cart with checkout set — i.e. straight to Shopify's
  // native checkout, bypassing OTP entirely.
  //
  // form.elements DOES include controls associated via the form attribute.
  document.addEventListener(
    "submit",
    function (event) {
      var form = event.target;
      if (!form || !form.matches || !form.matches('form[action*="/cart"]')) return;

      // event.submitter is the precise signal, and is set for implicit
      // (Enter-key) submission too. Fall back to scanning associated controls.
      var button =
        (event.submitter && event.submitter.closest && event.submitter.closest(CHECKOUT_SELECTORS)) ||
        findCheckoutControl(form);
      if (!button) return;

      event.preventDefault();
      event.stopPropagation();
      startPayment(button);
    },
    true
  );

  function findCheckoutControl(form) {
    var elements = form.elements || [];
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].matches && elements[i].matches(CHECKOUT_SELECTORS)) return elements[i];
    }
    return null;
  }

  function startPayment(button) {
    if (busy) return; // double-click guard: never create two draft orders
    busy = true;

    // Elmora's label is nested <span><span>…</span></span> and the theme's CSS
    // depends on that, so save/restore innerHTML rather than flattening to text.
    var originalHtml = button.innerHTML;
    button.setAttribute("disabled", "disabled");
    button.textContent = "Učitavanje...";

    var release = function () {
      busy = false;
      button.removeAttribute("disabled");
      button.innerHTML = originalHtml; // our own saved markup, not user input
    };

    fetch("/cart.js", { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.json();
      })
      .then(function (cart) {
        if (!cart.items || cart.items.length === 0) throw new Error("cart is empty");
        openAddressStep(cart, release);
      })
      .catch(function (err) {
        console.error("[otp-checkout] failed:", err);
        release();
        alert("Došlo je do greške pri pokretanju plaćanja. Pokušajte ponovo.");
      });
  }

  // --- Address + delivery step ----------------------------------------------
  //
  // This exists because delivery cannot be priced without a destination: Shopify
  // returns NO shipping rates at all for a cart with no address, so skipping this
  // step would mean charging the customer nothing for delivery on every order.
  // The backend refuses such a request (400 address_required) rather than
  // absorbing the cost, so the address has to be collected here, before payment.
  //
  // Deliberately plain DOM with inline styles: this has to render on top of any
  // theme without inheriting its form CSS, and without pulling in a dependency.
  function openAddressStep(cart, release) {
    var FIELDS = [
      { name: "first_name", label: "Ime", required: true },
      { name: "last_name", label: "Prezime", required: true },
      { name: "address1", label: "Adresa i broj", required: true, wide: true },
      { name: "city", label: "Grad", required: true },
      { name: "zip", label: "Poštanski broj", required: true },
      { name: "phone", label: "Telefon", required: true },
      { name: "email", label: "Email", required: true, wide: true, type: "email" },
    ];

    var overlay = el("div", {
      style:
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;" +
        "display:flex;align-items:center;justify-content:center;padding:1rem;" +
        "font-family:system-ui,-apple-system,sans-serif;overflow-y:auto",
    });
    var panel = el("div", {
      style:
        "background:#fff;color:#111;max-width:32rem;width:100%;border-radius:8px;" +
        "padding:1.5rem;box-shadow:0 10px 40px rgba(0,0,0,.3);max-height:95vh;overflow-y:auto",
    });
    overlay.appendChild(panel);

    panel.appendChild(el("h2", { text: "Podaci za dostavu", style: "margin:0 0 1rem;font-size:1.15rem" }));

    var grid = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:.75rem" });
    var inputs = {};
    FIELDS.forEach(function (f) {
      var wrap = el("label", {
        style: "display:block;font-size:.8rem;color:#555" + (f.wide ? ";grid-column:1/-1" : ""),
        text: f.label + (f.required ? " *" : ""),
      });
      var input = el("input", {
        style:
          "display:block;width:100%;box-sizing:border-box;margin-top:.25rem;padding:.5rem;" +
          "border:1px solid #ccc;border-radius:4px;font-size:.95rem;color:#111;background:#fff",
      });
      input.type = f.type || "text";
      input.name = f.name;
      if (f.name === "email") input.value = findEmail() || "";
      inputs[f.name] = input;
      wrap.appendChild(input);
      grid.appendChild(wrap);
    });
    panel.appendChild(grid);
    panel.appendChild(
      el("p", {
        text: "Dostava samo na teritoriji Srbije.",
        style: "margin:.6rem 0 0;font-size:.78rem;color:#777",
      })
    );

    var ratesBox = el("div", { style: "margin-top:1rem" });
    panel.appendChild(ratesBox);

    var msg = el("p", { style: "margin:.75rem 0 0;font-size:.85rem;color:#c00;min-height:1.2em" });
    panel.appendChild(msg);

    var actions = el("div", { style: "display:flex;gap:.5rem;margin-top:1rem;justify-content:flex-end" });
    var cancel = el("button", {
      text: "Odustani",
      style: "padding:.6rem 1rem;border:1px solid #ccc;background:#fff;color:#111;border-radius:4px;cursor:pointer",
    });
    var submit = el("button", {
      text: "Nastavi na plaćanje",
      style: "padding:.6rem 1.2rem;border:0;background:#111;color:#fff;border-radius:4px;cursor:pointer",
    });
    submit.disabled = true;
    submit.style.opacity = ".5";
    actions.appendChild(cancel);
    actions.appendChild(submit);
    panel.appendChild(actions);

    document.body.appendChild(overlay);
    inputs.first_name.focus();

    var chosenRate = null;
    var rateLookup = 0;

    function address() {
      return {
        first_name: inputs.first_name.value.trim(),
        last_name: inputs.last_name.value.trim(),
        address1: inputs.address1.value.trim(),
        city: inputs.city.value.trim(),
        zip: inputs.zip.value.trim(),
        phone: inputs.phone.value.trim(),
        country_code: "RS",
      };
    }

    function addressReady() {
      var a = address();
      return a.city && a.zip && a.address1 && a.first_name && a.last_name;
    }

    // Re-quote whenever the parts that can change the price change. Every quote
    // is a fresh server-side lookup against Shopify for this exact cart — the
    // prices shown here are never computed in the browser.
    function refreshRates() {
      if (!addressReady()) {
        ratesBox.innerHTML = "";
        chosenRate = null;
        setSubmit(false);
        return;
      }
      var seq = ++rateLookup;
      ratesBox.innerHTML = "";
      ratesBox.appendChild(el("p", { text: "Učitavanje opcija dostave...", style: "font-size:.85rem;color:#666" }));

      fetch(BACKEND_URL + "/api/delivery/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lineItems: cart.items.map(function (i) {
            return { variant_id: i.variant_id, quantity: i.quantity };
          }),
          shippingAddress: address(),
        }),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, body: j };
          });
        })
        .then(function (res) {
          if (seq !== rateLookup) return; // a newer lookup has superseded this one
          ratesBox.innerHTML = "";
          if (!res.ok || !res.body.rates || !res.body.rates.length) {
            msg.textContent = res.body.error || "Nema dostupne dostave za ovu adresu.";
            setSubmit(false);
            return;
          }
          msg.textContent = "";
          ratesBox.appendChild(
            el("div", { text: "Način dostave", style: "font-size:.8rem;color:#555;margin-bottom:.4rem" })
          );
          res.body.rates.forEach(function (rate, i) {
            var row = el("label", {
              style:
                "display:flex;align-items:center;gap:.5rem;padding:.5rem;border:1px solid #ddd;" +
                "border-radius:4px;margin-bottom:.35rem;cursor:pointer;font-size:.9rem",
            });
            var radio = el("input");
            radio.type = "radio";
            radio.name = "otp-rate";
            radio.value = rate.title;
            if (i === 0) {
              radio.checked = true;
              chosenRate = rate.title;
            }
            radio.addEventListener("change", function () {
              chosenRate = rate.title;
            });
            row.appendChild(radio);
            row.appendChild(el("span", { text: rate.title, style: "flex:1" }));
            row.appendChild(
              el("strong", {
                text: Number(rate.price) === 0 ? "Besplatno" : formatRsd(rate.price),
              })
            );
            ratesBox.appendChild(row);
          });
          setSubmit(true);
        })
        .catch(function (err) {
          if (seq !== rateLookup) return;
          console.error("[otp-checkout] rates failed:", err);
          ratesBox.innerHTML = "";
          msg.textContent = "Ne mogu da učitam opcije dostave.";
          setSubmit(false);
        });
    }

    function setSubmit(on) {
      submit.disabled = !on;
      submit.style.opacity = on ? "1" : ".5";
    }

    ["city", "zip", "address1", "first_name", "last_name"].forEach(function (n) {
      inputs[n].addEventListener("change", refreshRates);
      inputs[n].addEventListener("blur", refreshRates);
    });

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        close();
        release();
      }
    }
    document.addEventListener("keydown", onKey);
    cancel.addEventListener("click", function () {
      close();
      release();
    });

    submit.addEventListener("click", function () {
      var missing = FIELDS.filter(function (f) {
        return f.required && !inputs[f.name].value.trim();
      });
      if (missing.length) {
        msg.textContent = "Popunite: " + missing.map(function (f) { return f.label; }).join(", ");
        return;
      }
      msg.textContent = "";
      submit.disabled = true;
      submit.textContent = "Preusmeravanje...";

      fetch(BACKEND_URL + "/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Only ids and quantities are sent. Prices are deliberately NOT sent —
          // the backend asks Shopify for the real total, so editing this payload
          // in devtools cannot change what the customer is charged. The same goes
          // for delivery: the rate is named, never priced.
          lineItems: cart.items.map(function (item) {
            return { variant_id: item.variant_id, quantity: item.quantity };
          }),
          customer: { email: inputs.email.value.trim() || undefined },
          shippingAddress: address(),
          shippingRateTitle: chosenRate || undefined,
        }),
      })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, body: j };
          });
        })
        .then(function (res) {
          if (!res.ok) throw new Error(res.body.error || "backend refused the checkout");
          if (!res.body.redirectUrl) throw new Error("no redirect URL returned");
          // The adapter may require a form POST rather than a GET redirect.
          if (res.body.method === "POST" && res.body.fields) {
            submitHiddenForm(res.body.redirectUrl.split("?")[0], res.body.fields);
          } else {
            window.location.href = res.body.redirectUrl;
          }
        })
        .catch(function (err) {
          console.error("[otp-checkout] checkout failed:", err);
          msg.textContent = err.message || "Greška pri pokretanju plaćanja.";
          submit.disabled = false;
          submit.textContent = "Nastavi na plaćanje";
        });
    });

    refreshRates();
  }

  function el(tag, opts) {
    var node = document.createElement(tag);
    if (opts && opts.style) node.setAttribute("style", opts.style);
    if (opts && opts.text) node.textContent = opts.text;
    return node;
  }

  function formatRsd(amount) {
    return Number(amount).toLocaleString("sr-RS", { maximumFractionDigits: 0 }) + " RSD";
  }

  // Shopify's cart page has no email field by default. If you add one, give it
  // id="customer-email"; otherwise we fall back to the logged-in customer's email
  // (see the Liquid one-liner in SETUP.md step 6) and finally to nothing, in which
  // case the draft order simply has no email attached.
  function findEmail() {
    var field = document.querySelector("#customer-email, [name='customer-email'], [name='email']");
    if (field && field.value) return field.value;
    if (window.OTP_CUSTOMER_EMAIL) return window.OTP_CUSTOMER_EMAIL;
    return undefined;
  }

  function submitHiddenForm(action, fields) {
    var form = document.createElement("form");
    form.method = "POST";
    form.action = action;
    Object.keys(fields).forEach(function (key) {
      var input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = fields[key];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }
})();
