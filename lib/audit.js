// Append-only payment audit trail (JSONL).
//
// Every payment-relevant event gets a line. When something goes wrong with a real
// customer's money this file is how you reconstruct what happened, so it records
// the raw gateway callback verbatim alongside our interpretation of it.
//
// PRODUCTION NOTE: this writes to local disk, which does NOT survive on serverless
// hosts (Vercel/Netlify functions get an ephemeral filesystem). Before go-live,
// point `write` at something durable — Postgres, a logging service, or at minimum
// your host's persistent log drain. Search for AUDIT_SINK below.

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "data");
const FILE = path.join(DIR, "payments.jsonl");

let ready = false;
function ensureDir() {
  if (ready) return;
  fs.mkdirSync(DIR, { recursive: true });
  ready = true;
}

// AUDIT_SINK: replace the file append here with a durable store for production.
function write(event, data) {
  const record = { at: new Date().toISOString(), event, ...data };
  try {
    ensureDir();
    fs.appendFileSync(FILE, JSON.stringify(record) + "\n", "utf8");
  } catch (err) {
    // Never let audit failure break a payment — but make the loss loud.
    console.error("AUDIT WRITE FAILED", err.message, record);
  }
  console.log(`[audit] ${event}`, JSON.stringify(data));
  return record;
}

// All events for one order, oldest first.
//
// This is what lets /order-status tell "declined" apart from "never existed" —
// a declined draft order is deleted from Shopify (so it leaves no orphan in the
// admin), which destroys the only other evidence that the attempt happened.
//
// PERF: re-reads the whole file per call. Fine at dev volume and fine for a small
// shop, but it is O(file) — when you move this to a real store, index by orderRef
// or query the durable store directly (see AUDIT_SINK above).
function eventsFor(orderRef) {
  const ref = String(orderRef);
  return readAll().filter((e) => String(e.orderRef) === ref);
}

function readAll() {
  try {
    return fs
      .readFileSync(FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

module.exports = { write, readAll, eventsFor, FILE };
