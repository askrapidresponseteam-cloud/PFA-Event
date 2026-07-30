"use strict";

/**
 * Thin Cashfree Payment Gateway client.
 *
 * Uses the documented REST endpoints directly so there is no extra SDK to keep
 * in step with. Node 20 ships a global fetch, so there is no HTTP dependency.
 *
 * Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
 */

const crypto = require("crypto");

const API_VERSION = "2023-08-01";

const BASE = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg"
};

function baseUrl(mode) {
  return BASE[mode] || BASE.sandbox;
}

function headers(appId, secretKey, extra) {
  return Object.assign(
    {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-api-version": API_VERSION,
      "x-client-id": appId,
      "x-client-secret": secretKey
    },
    extra || {}
  );
}

async function callCashfree(mode, appId, secretKey, path, options) {
  const res = await fetch(baseUrl(mode) + path, options);
  const text = await res.text();

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    body = { raw: text };
  }

  if (!res.ok) {
    const message =
      body.message ||
      body.error_description ||
      "Cashfree returned HTTP " + res.status;
    const error = new Error(message);
    error.status = res.status;
    error.code = body.code || body.type || null;
    error.body = body;
    throw error;
  }
  return body;
}

/**
 * Create an order and get back a payment_session_id for the checkout SDK.
 *
 * Expiry matters more than it looks. Cashfree treats order_expiry_time as the
 * point after which no payment attempt can start, and it reverses any delayed
 * bank confirmation that arrives after it. Setting expiry to the seat hold
 * therefore stops the one case where money could arrive for seats that had
 * already gone, rather than leaving us to clean it up afterwards.
 *
 * Pass expiresAt as epoch milliseconds. If Cashfree rejects the window for
 * being too short, the caller retries with a longer one.
 */
async function createOrder(cfg, order) {
  const payload = {
    order_id: order.orderId,
    order_amount: Number(order.amount.toFixed(2)),
    order_currency: "INR",
    customer_details: {
      customer_id: order.customerId,
      customer_name: order.name,
      customer_email: order.email,
      customer_phone: order.phone
    },
    order_meta: {
      return_url: order.returnUrl,
      notify_url: order.notifyUrl
    },
    order_note: order.note || "PFA seat booking",
    order_expiry_time: new Date(order.expiresAt).toISOString(),
    order_tags: {
      booking_id: order.bookingId,
      event_id: order.eventId,
      seats: order.seats.join(",")
    }
  };

  return callCashfree(cfg.mode, cfg.appId, cfg.secretKey, "/orders", {
    method: "POST",
    headers: headers(cfg.appId, cfg.secretKey, {
      "x-idempotency-key": order.bookingId
    }),
    body: JSON.stringify(payload)
  });
}

/** Fetch an order so we can read its authoritative status. */
async function fetchOrder(cfg, orderId) {
  return callCashfree(
    cfg.mode,
    cfg.appId,
    cfg.secretKey,
    "/orders/" + encodeURIComponent(orderId),
    { method: "GET", headers: headers(cfg.appId, cfg.secretKey) }
  );
}

/** Fetch every payment attempt against an order. */
async function fetchOrderPayments(cfg, orderId) {
  return callCashfree(
    cfg.mode,
    cfg.appId,
    cfg.secretKey,
    "/orders/" + encodeURIComponent(orderId) + "/payments",
    { method: "GET", headers: headers(cfg.appId, cfg.secretKey) }
  );
}

/**
 * Verify a webhook.
 *
 * Cashfree signs the concatenation of the x-webhook-timestamp header and the
 * exact raw request body with your client secret, HMAC SHA256, base64 encoded.
 * The parsed JSON object must never be used here, since re-serialising it
 * changes the bytes and breaks the comparison.
 */
function verifyWebhookSignature(secretKey, timestamp, rawBody, signature) {
  if (!timestamp || !rawBody || !signature) return false;

  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const expected = crypto
    .createHmac("sha256", secretKey)
    .update(String(timestamp) + raw)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Reject webhooks that are older than the tolerance, to blunt replay attempts. */
function timestampIsFresh(timestamp, toleranceSeconds) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const seconds = ts > 1e12 ? ts / 1000 : ts;
  return Math.abs(Date.now() / 1000 - seconds) <= (toleranceSeconds || 600);
}

module.exports = {
  API_VERSION,
  createOrder,
  fetchOrder,
  fetchOrderPayments,
  verifyWebhookSignature,
  timestampIsFresh
};
