"use strict";

/**
 * PFA seat booking backend.
 *
 * createBooking     callable  hold seats for 5 minutes and open a Cashfree order
 * verifyPayment     callable  fast path status check after the checkout modal
 * releaseBooking    callable  customer backs out, seats go straight back
 * cashfreeWebhook   https     authoritative payment result from Cashfree
 * sweepHolds        schedule  release holds that ran out, every minute
 * reconcilePayments schedule  catch any payment the webhook and browser missed
 * sendReminders     schedule  mail ticket holders the day before and the day of
 * onBookingSettled  firestore send the ticket email exactly once
 */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret, defineString, defineInt } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const admin = require("firebase-admin");
const cashfree = require("./lib/cashfree");
const mailer = require("./lib/email");
const seats = require("./lib/seats");

admin.initializeApp();
const db = admin.firestore();

/* ---------------------------------------------------------------------------
   Configuration
   Secrets:  firebase functions:secrets:set NAME
   Params:   set in functions/.env  (see .env.example)
   --------------------------------------------------------------------------- */
const REGION = "asia-south1";
setGlobalOptions({ region: REGION, maxInstances: 20 });

const CASHFREE_APP_ID     = defineSecret("CASHFREE_APP_ID");
const CASHFREE_SECRET_KEY = defineSecret("CASHFREE_SECRET_KEY");
const SMTP_PASS           = defineSecret("SMTP_PASS");

const CASHFREE_MODE  = defineString("CASHFREE_MODE", { default: "sandbox" });
const PUBLIC_BASE_URL = defineString("PUBLIC_BASE_URL", { default: "" });
const WEBHOOK_URL     = defineString("WEBHOOK_URL", { default: "" });
const SMTP_HOST      = defineString("SMTP_HOST", { default: "" });
const SMTP_PORT      = defineString("SMTP_PORT", { default: "587" });
const SMTP_USER      = defineString("SMTP_USER", { default: "" });
const MAIL_FROM      = defineString("MAIL_FROM", { default: "" });
const MAIL_REPLY_TO  = defineString("MAIL_REPLY_TO", { default: "" });
const MAIL_ORGANISER = defineString("MAIL_ORGANISER", { default: "" });
const HOLD_MINUTES   = defineInt("HOLD_MINUTES", { default: 5 });
const MAX_SEATS      = defineInt("MAX_SEATS_PER_BOOKING", { default: 10 });

const PAY_SECRETS  = [CASHFREE_APP_ID, CASHFREE_SECRET_KEY];
const MAIL_SECRETS = [SMTP_PASS];

function cfConfig() {
  return {
    mode: CASHFREE_MODE.value() === "production" ? "production" : "sandbox",
    appId: CASHFREE_APP_ID.value(),
    secretKey: CASHFREE_SECRET_KEY.value(),
  };
}

/* The PFA mark on the ticket, read once and attached by content id so the
   email never depends on an image host being reachable. */
let TICKET_LOGO = null;
function ticketLogo() {
  if (TICKET_LOGO !== null) return TICKET_LOGO;
  try {
    TICKET_LOGO = require("fs").readFileSync(require("path").join(__dirname, "assets", "pfa-logo.png"));
  } catch (err) {
    TICKET_LOGO = undefined;   // ticket still sends, just without the mark
    logger.warn("Ticket logo missing, sending without it", { err: err.message });
  }
  return TICKET_LOGO;
}

function mailConfig() {
  return {
    host: SMTP_HOST.value(),
    port: SMTP_PORT.value(),
    user: SMTP_USER.value(),
    pass: SMTP_PASS.value(),
    from: (MAIL_FROM.value() && !MAIL_FROM.value().includes("SAME_ADDRESS"))
      ? MAIL_FROM.value()
      : "People for Animals <" + SMTP_USER.value() + ">",
    replyTo: MAIL_REPLY_TO.value() || undefined,
    organiser: MAIL_ORGANISER.value() || undefined,
    logo: ticketLogo()
  };
}

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[6-9]\d{9}$/;
const SEAT_RE  = /^[A-Z]\d{1,2}$/;

function cleanInput(data) {
  const eventId = String(data?.eventId || "").trim();
  const name    = String(data?.name || "").trim().replace(/\s+/g, " ");
  const email   = String(data?.email || "").trim().toLowerCase();
  const phone   = String(data?.phone || "").replace(/\D/g, "").slice(-10);
  const list    = Array.isArray(data?.seats) ? data.seats : [];

  if (!eventId) throw new HttpsError("invalid-argument", "Missing event.");
  if (name.length < 2 || name.length > 80) throw new HttpsError("invalid-argument", "Please enter your full name.");
  if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpsError("invalid-argument", "Please enter a valid email address.");
  if (!PHONE_RE.test(phone)) throw new HttpsError("invalid-argument", "Please enter a valid 10 digit Indian mobile number.");

  const seatIds = [...new Set(list.map((s) => String(s).trim().toUpperCase()))];
  if (!seatIds.length) throw new HttpsError("invalid-argument", "Pick at least one seat.");
  // Absolute ceiling. The event's own limit is applied once it is loaded,
  // because an organiser can change that from the seat desk at any time.
  if (seatIds.length > 20) {
    throw new HttpsError("invalid-argument", "That is more seats than anyone may book at once.");
  }
  if (seatIds.some((s) => !SEAT_RE.test(s))) throw new HttpsError("invalid-argument", "One of those seat numbers is not valid.");

  return { eventId, name, email, phone, seatIds: seatIds.sort() };
}

/** Stop one session from parking a wall of seats behind repeated holds. */
async function guardConcurrentHolds(uid) {
  const open = await db
    .collection("bookings")
    .where("uid", "==", uid)
    .where("status", "in", [seats.BOOKING_STATUS.HOLDING, seats.BOOKING_STATUS.PENDING])
    .where("holdExpiresAt", ">", admin.firestore.Timestamp.now())
    .limit(3)
    .get();

  if (open.size >= 2) {
    throw new HttpsError(
      "resource-exhausted",
      "You already have seats on hold. Finish that payment, or wait for the hold to run out."
    );
  }
}

/* ---------------------------------------------------------------------------
   createBooking
   --------------------------------------------------------------------------- */
exports.createBooking = onCall({ secrets: PAY_SECRETS, cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please reload the page and try again.");

  const { eventId, name, email, phone, seatIds } = cleanInput(request.data);

  const eventSnap = await db.collection("events").doc(eventId).get();
  if (!eventSnap.exists) throw new HttpsError("not-found", "That event is not open for booking.");
  const event = eventSnap.data();
  if (event.status && event.status !== "open") {
    throw new HttpsError("failed-precondition", "Booking is closed for this event.");
  }

  // The organiser sets this from the seat desk; the deployed value is only a
  // fallback for an event document that predates the setting.
  const cap = Number(event.maxPerBooking) > 0 ? Number(event.maxPerBooking) : MAX_SEATS.value();
  if (seatIds.length > cap) {
    throw new HttpsError("invalid-argument", "You can book up to " + cap + " seats in one booking.");
  }

  await guardConcurrentHolds(uid);

  // A fallback only, for seats written before per row pricing existed. The real
  // figure is computed from the seat documents inside the hold transaction.
  const seatPrice = Number(event.seatPrice);
  if (!Number.isFinite(seatPrice) || seatPrice <= 0) {
    throw new HttpsError("failed-precondition", "This event has no valid ticket price set.");
  }
  // A provisional figure only. holdSeats recomputes it from the seat documents
  // inside the transaction and that value is the one that reaches the gateway.
  let amount = Number((seatPrice * seatIds.length).toFixed(2));

  const holdMs = (event.holdMinutes || HOLD_MINUTES.value()) * 60 * 1000;
  const bookingRef = db.collection("bookings").doc();
  const bookingId = bookingRef.id;

  let expiresAt, heldAmount;
  try {
    ({ expiresAt, amount: heldAmount } = await seats.holdSeats(db, {
      eventId,
      seatIds,
      bookingId,
      uid,
      holdMs,
      seatPrice,
      contact: { name, email, phone }
    }));
  } catch (err) {
    if (err.code === "seat-taken" || err.code === "seat-missing") {
      throw new HttpsError("aborted", "Seat " + err.seat + " was just taken. Please pick again.");
    }
    if (err.code === "seat-unpriced") {
      logger.error("Seat has no price", { bookingId, seat: err.seat });
      throw new HttpsError("failed-precondition", "Seat pricing is not set up yet. Please try again shortly.");
    }
    logger.error("holdSeats failed", { bookingId, err: err.message });
    throw new HttpsError("internal", "Could not hold those seats. Please try again.");
  }
  amount = heldAmount;

  // Cashfree order. Any failure here must give the seats straight back.
  const base = (PUBLIC_BASE_URL.value() || String(request.data?.returnUrl || "")).replace(/\/+$/, "");
  const returnUrl = base
    ? base + (base.includes("?") ? "&" : "?") + "booking=" + bookingId + "&order_id={order_id}"
    : undefined;

  // The order expires with the seat hold, plus a minute so a payment already
  // under way can finish. Cashfree blocks later attempts and reverses any
  // delayed bank confirmation, so money cannot arrive for seats that have gone.
  const orderPayload = {
      orderId: "pfa_" + bookingId,
      bookingId,
      eventId,
      amount,
      seats: seatIds,
      customerId: uid,
      name,
      email,
      phone,
      returnUrl,
      notifyUrl: webhookUrl(),
      note: (event.title || "PFA fundraiser") + " seats " + seatIds.join(","),
      expiresAt: expiresAt.toMillis() + 60 * 1000
  };

  try {
    let order;
    try {
      order = await cashfree.createOrder(cfConfig(), orderPayload);
    } catch (err) {
      // Some accounts enforce a minimum order window. Widen it once and retry,
      // then fall back on our own hold to govern availability.
      if (!/expiry/i.test(String(err.message))) throw err;
      logger.warn("Cashfree rejected the short order expiry, widening it", { bookingId, err: err.message });
      order = await cashfree.createOrder(cfConfig(), {
        ...orderPayload,
        expiresAt: Date.now() + 20 * 60 * 1000
      });
    }

    await bookingRef.update({
      status: seats.BOOKING_STATUS.PENDING,
      cfOrderId: order.order_id,
      cfOrderRef: order.cf_order_id || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      bookingId,
      reference: seats.makeReference(bookingId),
      orderId: order.order_id,
      paymentSessionId: order.payment_session_id,
      amount,
      seats: seatIds,
      holdExpiresAt: expiresAt.toMillis(),
      mode: cfConfig().mode
    };
  } catch (err) {
    logger.error("Cashfree order failed", { bookingId, err: err.message, body: err.body });
    await seats
      .releaseSeats(db, { eventId, bookingId, nextStatus: seats.BOOKING_STATUS.FAILED })
      .catch((e) => logger.error("release after order failure", e));
    throw new HttpsError("unavailable", "Could not reach the payment gateway. Your seats have been released, please try again.");
  }
});

/* ---------------------------------------------------------------------------
   verifyPayment
   --------------------------------------------------------------------------- */
exports.verifyPayment = onCall({ secrets: PAY_SECRETS, cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please reload the page and try again.");

  const bookingId = String(request.data?.bookingId || "").trim();
  if (!bookingId) throw new HttpsError("invalid-argument", "Missing booking.");

  const snap = await db.collection("bookings").doc(bookingId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const booking = snap.data();
  if (booking.uid !== uid) throw new HttpsError("permission-denied", "That booking belongs to another session.");

  if (booking.status === seats.BOOKING_STATUS.PAID) return summarise(bookingId, booking);
  if (booking.status === seats.BOOKING_STATUS.PAID_UNFULFILLED) return summarise(bookingId, booking);
  if (
    booking.status === seats.BOOKING_STATUS.EXPIRED ||
    booking.status === seats.BOOKING_STATUS.RELEASED
  ) {
    return { bookingId, status: booking.status };
  }
  if (!booking.cfOrderId) return { bookingId, status: booking.status };

  let order;
  try {
    order = await cashfree.fetchOrder(cfConfig(), booking.cfOrderId);
  } catch (err) {
    logger.error("fetchOrder failed", { bookingId, err: err.message });
    throw new HttpsError("unavailable", "Could not reach the payment gateway.");
  }

  if (order.order_status !== "PAID") {
    // An expired or terminated order will never pay, so free the seats now.
    if (order.order_status === "EXPIRED" || order.order_status === "TERMINATED") {
      await seats.releaseSeats(db, {
        eventId: booking.eventId,
        bookingId,
        nextStatus: seats.BOOKING_STATUS.FAILED
      });
      return { bookingId, status: seats.BOOKING_STATUS.FAILED, orderStatus: order.order_status };
    }
    return { bookingId, status: booking.status, orderStatus: order.order_status };
  }

  const result = await settlePaid(booking.eventId, bookingId, {
    source: "verify",
    cfOrderId: order.order_id,
    cfPaymentId: order.cf_order_id || null,
    amount: Number(order.order_amount),
    method: null,
    at: new Date().toISOString()
  });

  const fresh = await db.collection("bookings").doc(bookingId).get();
  return summarise(bookingId, fresh.data(), result.outcome);
});

function summarise(bookingId, booking, outcome) {
  return {
    bookingId,
    status: booking.status,
    reference: booking.reference || seats.makeReference(bookingId),
    seats: booking.seats || [],
    amount: booking.amount || 0,
    unavailableSeats: booking.unavailableSeats || [],
    outcome: outcome || null
  };
}

/* ---------------------------------------------------------------------------
   releaseBooking
   --------------------------------------------------------------------------- */
exports.releaseBooking = onCall({ cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please reload the page and try again.");

  const bookingId = String(request.data?.bookingId || "").trim();
  if (!bookingId) throw new HttpsError("invalid-argument", "Missing booking.");

  const snap = await db.collection("bookings").doc(bookingId).get();
  if (!snap.exists) return { released: false };
  const booking = snap.data();
  if (booking.uid !== uid) throw new HttpsError("permission-denied", "That booking belongs to another session.");

  const out = await seats.releaseSeats(db, {
    eventId: booking.eventId,
    bookingId,
    nextStatus: seats.BOOKING_STATUS.RELEASED
  });
  return out;
});

/* ---------------------------------------------------------------------------
   cashfreeWebhook
   This is the authoritative path. Cashfree retries on non 2xx, so we answer 200
   for anything we have understood and handled, including duplicates.
   --------------------------------------------------------------------------- */
exports.cashfreeWebhook = onRequest(
  { secrets: PAY_SECRETS, cors: false, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const signature = req.get("x-webhook-signature");
    const timestamp = req.get("x-webhook-timestamp");
    const raw = req.rawBody;

    if (!cashfree.timestampIsFresh(timestamp, 600)) {
      logger.warn("Webhook rejected: stale timestamp", { timestamp });
      res.status(401).send("Stale");
      return;
    }
    if (!cashfree.verifyWebhookSignature(CASHFREE_SECRET_KEY.value(), timestamp, raw, signature)) {
      logger.warn("Webhook rejected: bad signature");
      res.status(401).send("Invalid signature");
      return;
    }

    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch (err) {
      res.status(400).send("Bad payload");
      return;
    }

    const type = event.type || "";
    const order = event.data?.order || {};
    const payment = event.data?.payment || {};
    const cfOrderId = order.order_id || "";
    const bookingId = order.order_tags?.booking_id || cfOrderId.replace(/^pfa_/, "");

    // Log every delivery so nothing is lost if processing throws.
    await db.collection("webhookEvents").add({
      type,
      cfOrderId,
      bookingId: bookingId || null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      payload: event
    }).catch((e) => logger.error("webhook log failed", e));

    if (!bookingId) {
      res.status(200).send("Ignored, no booking reference");
      return;
    }

    try {
      const snap = await db.collection("bookings").doc(bookingId).get();
      if (!snap.exists) {
        logger.warn("Webhook for unknown booking", { bookingId, cfOrderId });
        res.status(200).send("Unknown booking");
        return;
      }
      const booking = snap.data();

      if (type === "PAYMENT_SUCCESS_WEBHOOK" || payment.payment_status === "SUCCESS") {
        await settlePaid(booking.eventId, bookingId, {
          source: "webhook",
          cfOrderId,
          cfPaymentId: payment.cf_payment_id || null,
          amount: Number(payment.payment_amount || order.order_amount || booking.amount),
          method: payment.payment_group || null,
          at: payment.payment_time || new Date().toISOString()
        });
      } else if (
        type === "PAYMENT_FAILED_WEBHOOK" ||
        type === "PAYMENT_USER_DROPPED_WEBHOOK" ||
        payment.payment_status === "FAILED" ||
        payment.payment_status === "USER_DROPPED"
      ) {
        // Payment failed, so the seats go back to everyone else straight away.
        await db.collection("bookings").doc(bookingId).set(
          {
            lastPaymentAttempt: {
              status: payment.payment_status || type,
              message: payment.payment_message || null,
              at: admin.firestore.FieldValue.serverTimestamp()
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        await seats.releaseSeats(db, {
          eventId: booking.eventId,
          bookingId,
          nextStatus: seats.BOOKING_STATUS.FAILED
        });
        logger.info("Payment failed, seats released", { bookingId, seats: booking.seats });
      }

      res.status(200).send("OK");
    } catch (err) {
      logger.error("Webhook processing failed", { bookingId, err: err.message });
      // Non 2xx so Cashfree retries.
      res.status(500).send("Retry");
    }
  }
);

/** Shared confirm path used by both the webhook and the client verify call. */
async function settlePaid(eventId, bookingId, payment) {
  // Never hand over seats for less than the order was worth. Cashfree enforces
  // the amount it was given, so a mismatch means something is wrong upstream
  // and a person should look at it rather than the seats quietly going out.
  const bookingSnap = await db.collection("bookings").doc(bookingId).get();
  const owed = Number(bookingSnap.exists ? bookingSnap.data().amount : 0);
  const got = Number(payment && payment.amount);
  if (owed > 0 && Number.isFinite(got) && got + 0.01 < owed) {
    logger.error("Amount mismatch, refusing to confirm", { bookingId, owed, got });
    await db.collection("bookings").doc(bookingId).set({
      needsAttention: true,
      amountMismatch: { owed, got },
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { outcome: "amount-mismatch" };
  }

  const result = await seats.confirmSeats(db, { eventId, bookingId, payment });

  if (result.outcome === "unfulfilled") {
    // Should not happen now the order expires with the hold. If it ever does,
    // shout about it rather than quietly double selling the seat.
    logger.error("Paid but seats unavailable, organiser notified", {
      bookingId, lost: result.lost
    });
  }
  return result;
}

function webhookUrl() {
  // Prefer an explicit value. Second generation functions can be served from a
  // run.app domain, so the classic alias below is a fallback, not a guarantee.
  const explicit = WEBHOOK_URL.value();
  if (explicit) return explicit;
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
  return `https://${REGION}-${project}.cloudfunctions.net/cashfreeWebhook`;
}

/* ---------------------------------------------------------------------------
   sweepHolds: put expired holds back in the pool
   --------------------------------------------------------------------------- */
exports.sweepHolds = onSchedule(
  { schedule: "every 1 minutes", timeZone: "Asia/Kolkata" },
  async () => {
    const now = admin.firestore.Timestamp.now();

    const stale = await db
      .collectionGroup("seats")
      .where("status", "==", seats.HOLD_STATUS.HELD)
      .where("holdExpiresAt", "<", now)
      .limit(400)
      .get();

    if (stale.empty) return;

    const bookingIds = new Set();
    const batch = db.batch();

    stale.docs.forEach((doc) => {
      const d = doc.data();
      if (d.holdBookingId) bookingIds.add(d.holdBookingId);
      batch.set(
        doc.ref,
        {
          status: seats.HOLD_STATUS.AVAILABLE,
          holdBookingId: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
          heldByUid: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
    await batch.commit();

    // Close out the bookings behind those holds, unless payment already landed.
    for (const id of bookingIds) {
      const ref = db.collection("bookings").doc(id);
      await db
        .runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const s = snap.data().status;
          if (s === seats.BOOKING_STATUS.HOLDING || s === seats.BOOKING_STATUS.PENDING) {
            tx.update(ref, {
              status: seats.BOOKING_STATUS.EXPIRED,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        })
        .catch((e) => logger.error("expire booking failed", { id, e: e.message }));
    }

    logger.info("Released expired holds", { seats: stale.size, bookings: bookingIds.size });
  }
);

/* ---------------------------------------------------------------------------
   reconcilePayments

   The webhook is retried by Cashfree and the browser calls verify as well, so a
   payment should never go unnoticed. Should never is not the same as cannot: a
   misconfigured webhook URL, a bad deploy, or a person closing the tab at the
   wrong moment could still leave money taken with no seat and nobody aware.

   This asks Cashfree directly about every booking that did not end as paid, and
   settles anything that actually went through. It also nudges bookings whose
   ticket email failed, so the send is retried.
   --------------------------------------------------------------------------- */
exports.reconcilePayments = onSchedule(
  { schedule: "every 15 minutes", timeZone: "Asia/Kolkata", secrets: PAY_SECRETS },
  async () => {
    // Seven days, not the length of an afternoon. A delayed bank confirmation
    // can flip an order to PAID long after the browser has gone, and a booking
    // nobody notices is money taken for a seat that was never given.
    const since = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const open = await db
      .collection("bookings")
      .where("status", "in", [
        seats.BOOKING_STATUS.PENDING,
        seats.BOOKING_STATUS.EXPIRED,
        seats.BOOKING_STATUS.FAILED
      ])
      .where("createdAt", ">", since)
      .limit(200)
      .get();

    let recovered = 0;
    for (const doc of open.docs) {
      const booking = doc.data();
      if (!booking.cfOrderId) continue;

      let order;
      try {
        order = await cashfree.fetchOrder(cfConfig(), booking.cfOrderId);
      } catch (err) {
        logger.warn("Reconcile could not read an order", { bookingId: doc.id, err: err.message });
        continue;
      }
      if (order.order_status !== "PAID") continue;

      logger.error("Reconciler found a payment that was never confirmed", {
        bookingId: doc.id, cfOrderId: booking.cfOrderId, was: booking.status
      });
      await settlePaid(booking.eventId, doc.id, {
        source: "reconcile",
        cfOrderId: order.order_id,
        cfPaymentId: order.cf_order_id || null,
        amount: Number(order.order_amount),
        method: null,
        at: new Date().toISOString()
      });
      recovered++;
    }

    // Retry any ticket email that failed. Touching the document re-fires the
    // send trigger, which claims the send again.
    const unsent = await db
      .collection("bookings")
      .where("status", "==", seats.BOOKING_STATUS.PAID)
      .where("createdAt", ">", since)
      .limit(200)
      .get();

    let retried = 0;
    for (const doc of unsent.docs) {
      const b = doc.data();
      if (b.ticketEmailAt || !b.emailError) continue;
      await doc.ref.update({
        emailRetryAt: admin.firestore.FieldValue.serverTimestamp()
      });
      retried++;
    }

    if (recovered || retried) {
      logger.info("Reconcile finished", { recovered, emailRetries: retried });
    }
  }
);


/* ---------------------------------------------------------------------------
   sendReminders

   Runs once a day and mails everyone holding a paid booking, the day before
   the show and again on the morning of it.

   Two things matter here. It works from the event's real startsAt rather than
   the printed date label, because "Sunday, 9 August" is not a moment in
   time. And each reminder is claimed on the booking before it is sent, so a
   retry or an overlapping run cannot mail the same person twice.
   --------------------------------------------------------------------------- */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Timestamps arrive in several shapes depending on how they were written. */
function ms(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value === "number") return value;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Calendar day in India, as a plain YYYY-MM-DD, for a given moment. */
function istDay(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

exports.sendReminders = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Kolkata", secrets: MAIL_SECRETS },
  async () => {
    const events = await db.collection("events").get();
    const now = Date.now();

    for (const evDoc of events.docs) {
      const event = evDoc.data();
      const startsAt = ms(event.startsAt);
      if (!startsAt) {
        logger.warn("Event has no startsAt, cannot send reminders", { eventId: evDoc.id });
        continue;
      }

      const today = istDay(now);
      const showDay = istDay(startsAt);
      const tomorrow = istDay(now + 24 * 60 * 60 * 1000);

      let kind = null;
      if (showDay === today) kind = "today";
      else if (showDay === tomorrow) kind = "tomorrow";
      if (!kind) continue;

      // Do not nag anyone once the show has actually started.
      if (kind === "today" && now > startsAt) continue;

      const field = kind === "today" ? "reminderDayOfAt" : "reminderDayBeforeAt";
      const paid = await db
        .collection("bookings")
        .where("eventId", "==", evDoc.id)
        .where("status", "==", seats.BOOKING_STATUS.PAID)
        .get();

      const cfg = mailConfig();
      let sent = 0, skipped = 0;

      for (const doc of paid.docs) {
        const booking = doc.data();
        if (booking[field]) { skipped++; continue; }

        const contactSnap = await doc.ref.collection("private").doc("contact").get();
        const contact = contactSnap.exists ? contactSnap.data() : null;
        if (!contact || !contact.email) { skipped++; continue; }

        // Claim before sending, so a crash mid-send cannot cause a second mail.
        const claimed = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists || fresh.data()[field]) return false;
          tx.update(doc.ref, { [field]: admin.firestore.FieldValue.serverTimestamp() });
          return true;
        });
        if (!claimed) { skipped++; continue; }

        try {
          await mailer.sendReminder(cfg, {
            booking, contact, event, kind,
            reference: booking.reference || doc.id
          });
          sent++;
        } catch (err) {
          // Hand the claim back so tomorrow's run tries again.
          await doc.ref.update({ [field]: admin.firestore.FieldValue.delete() }).catch(() => {});
          logger.error("Reminder failed to send", { bookingId: doc.id, kind, err: err.message });
        }
      }

      logger.info("Reminders processed", { eventId: evDoc.id, kind, sent, skipped });
    }
  }
);

/* ---------------------------------------------------------------------------
   onBookingSettled: send exactly one email per outcome
   --------------------------------------------------------------------------- */
exports.onBookingSettled = onDocumentWritten(
  { document: "bookings/{bookingId}", secrets: MAIL_SECRETS },
  async (event) => {
    const after = event.data?.after;
    if (!after || !after.exists) return;

    const booking = after.data();
    const bookingId = event.params.bookingId;

    const wantsTicket = booking.status === seats.BOOKING_STATUS.PAID && !booking.ticketEmailAt;
    const wantsUnfulfilledNote =
      booking.status === seats.BOOKING_STATUS.PAID_UNFULFILLED && !booking.unfulfilledEmailAt;

    if (!wantsTicket && !wantsUnfulfilledNote) return;

    // Claim the send so a retry or a second write cannot double post.
    const field = wantsTicket ? "ticketEmailAt" : "unfulfilledEmailAt";
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(after.ref);
      if (!snap.exists || snap.data()[field]) return false;
      tx.update(after.ref, { [field]: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return;

    try {
      const [contactSnap, eventSnap] = await Promise.all([
        after.ref.collection("private").doc("contact").get(),
        db.collection("events").doc(booking.eventId).get()
      ]);
      const contact = contactSnap.data() || {};
      const eventDoc = eventSnap.data() || {};
      const reference = booking.reference || seats.makeReference(bookingId);
      const cfg = mailConfig();

      if (!cfg.host || !cfg.user) {
        logger.warn("SMTP not configured, skipping email", { bookingId });
        return;
      }

      const payload = { bookingId, booking, contact, event: eventDoc, reference };

      if (wantsTicket) {
        await mailer.sendTicket(cfg, payload);
        await mailer.sendOrganiserAlert(cfg, { ...payload, kind: "paid" });
        logger.info("Ticket email sent", { bookingId, reference });
      } else {
        await mailer.sendUnfulfilledNotice(cfg, payload);
        await mailer.sendOrganiserAlert(cfg, { ...payload, kind: "unfulfilled" });
        logger.info("Unfulfilled notice sent", { bookingId, reference });
      }
      if (booking.emailError) {
        await after.ref.update({ emailError: admin.firestore.FieldValue.delete() }).catch(() => {});
      }
    } catch (err) {
      // Clear the claim so the next write retries the send.
      await after.ref
        .update({ [field]: admin.firestore.FieldValue.delete(), emailError: String(err.message) })
        .catch(() => {});
      logger.error("Email send failed", { bookingId, err: err.message });
    }
  }
);

/* ---------------------------------------------------------------------------
   Admin callables. Required last so the Admin SDK is already initialised.
   --------------------------------------------------------------------------- */
Object.assign(exports, require("./admin"));
