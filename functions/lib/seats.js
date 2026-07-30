"use strict";

/**
 * Seat state machine.
 *
 *   available  ->  held      (createBooking, 5 minute TTL)
 *   held       ->  booked    (payment confirmed)
 *   held       ->  available (hold expired, or released by the customer)
 *
 * There is no path back from booked. Seats are not cancelled once paid for.
 *
 * Every transition that can be raced runs inside a Firestore transaction, so
 * two people clicking the same seat at the same moment cannot both win.
 */

const admin = require("firebase-admin");

const HOLD_STATUS = { AVAILABLE: "available", HELD: "held", BOOKED: "booked" };

const BOOKING_STATUS = {
  HOLDING: "holding",              // seats locked, order not created yet
  PENDING: "pending",              // order created, waiting on the customer
  PAID: "paid",                    // money in, seats confirmed
  PAID_UNFULFILLED: "paid_unfulfilled", // paid after the seats had gone, rare
  FAILED: "failed",                // gateway reported a failure
  EXPIRED: "expired",              // hold ran out with no payment
  RELEASED: "released"             // customer backed out
};

function seatRef(db, eventId, seatId) {
  return db.collection("events").doc(eventId).collection("seats").doc(seatId);
}

function millis(ts) {
  return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

/**
 * Lock the given seats to a booking for holdMs milliseconds, and write the
 * booking document, in one atomic step.
 *
 * Throws an Error with .code = "seat-taken" and .seat set when a seat is gone.
 */
async function holdSeats(db, opts) {
  const { eventId, seatIds, bookingId, uid, holdMs, seatPrice, forcePrice, contact } = opts;

  const now = Date.now();
  const expiresAt = admin.firestore.Timestamp.fromMillis(now + holdMs);
  const bookingRef = db.collection("bookings").doc(bookingId);
  const contactRef = bookingRef.collection("private").doc("contact");
  const refs = seatIds.map((id) => seatRef(db, eventId, id));

  let amount = 0;
  let priced = [];

  await db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs);

    // Price comes from the seat documents, never from the caller. Rows may be
    // priced differently, and the seats are already being read here under the
    // same lock that prevents double selling, so this is the one place where
    // the figure cannot drift from what is actually being sold.
    amount = 0;
    priced = [];

    for (const snap of snaps) {
      if (!snap.exists) {
        const e = new Error("Seat " + snap.id + " is not part of this event.");
        e.code = "seat-missing";
        e.seat = snap.id;
        throw e;
      }
      const d = snap.data();
      const heldByAnother =
        d.status === HOLD_STATUS.HELD &&
        millis(d.holdExpiresAt) > now &&
        d.holdBookingId !== bookingId;

      if (d.status === HOLD_STATUS.BOOKED || heldByAnother) {
        const e = new Error("Seat " + snap.id + " is already taken.");
        e.code = "seat-taken";
        e.seat = snap.id;
        throw e;
      }

      // forcePrice exists for comps, which are free regardless of the row.
      const each = forcePrice !== undefined ? Number(forcePrice) : Number(d.price);
      const use = Number.isFinite(each) && each >= 0 ? each : Number(seatPrice);
      if (!Number.isFinite(use) || use < 0) {
        const e = new Error("Seat " + snap.id + " has no price set.");
        e.code = "seat-unpriced";
        e.seat = snap.id;
        throw e;
      }
      amount += use;
      priced.push({ seat: snap.id, price: use });
    }
    amount = Number(amount.toFixed(2));

    refs.forEach((ref) => {
      tx.set(
        ref,
        {
          status: HOLD_STATUS.HELD,
          holdBookingId: bookingId,
          holdExpiresAt: expiresAt,
          heldByUid: uid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });

    tx.set(bookingRef, {
      eventId,
      uid,
      seats: seatIds,
      seatCount: seatIds.length,
      seatPrice,
      seatPrices: priced,
      amount,
      currency: "INR",
      status: BOOKING_STATUS.HOLDING,
      holdExpiresAt: expiresAt,
      reference: makeReference(bookingId),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Contact details sit in a locked subcollection so the booking document
    // itself carries no personal data.
    tx.set(contactRef, {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  return { expiresAt, bookingRef, amount, seatPrices: priced };
}

/**
 * Confirm a paid booking.
 *
 * Handles the awkward case where payment succeeds just after the hold lapsed:
 *   - seats still free  -> reclaim and confirm
 *   - a seat gone       -> mark paid_unfulfilled rather than double sell it
 */
async function confirmSeats(db, opts) {
  const { eventId, bookingId, payment } = opts;

  const bookingRef = db.collection("bookings").doc(bookingId);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) {
      const e = new Error("Booking not found.");
      e.code = "not-found";
      throw e;
    }

    const booking = bookingSnap.data();

    // Idempotent: the webhook and the client verify call both land here.
    if (booking.status === BOOKING_STATUS.PAID) {
      return { outcome: "already-paid", booking };
    }
    if (booking.status === BOOKING_STATUS.PAID_UNFULFILLED) {
      return { outcome: "already-unfulfilled", booking };
    }

    const refs = booking.seats.map((id) => seatRef(db, eventId, id));
    const snaps = await tx.getAll(...refs);

    const lost = [];
    for (const snap of snaps) {
      if (!snap.exists) { lost.push(snap.id); continue; }
      const d = snap.data();
      const ours =
        d.holdBookingId === bookingId &&
        (d.status === HOLD_STATUS.HELD || d.status === HOLD_STATUS.BOOKED);
      const freeNow =
        d.status === HOLD_STATUS.AVAILABLE ||
        (d.status === HOLD_STATUS.HELD && millis(d.holdExpiresAt) <= now);

      if (!ours && !freeNow) lost.push(snap.id);
    }

    if (lost.length) {
      tx.update(bookingRef, {
        status: BOOKING_STATUS.PAID_UNFULFILLED,
        unavailableSeats: lost,
        needsAttention: true,
        payment: payment || null,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { outcome: "unfulfilled", booking, lost };
    }

    refs.forEach((ref) => {
      tx.set(
        ref,
        {
          status: HOLD_STATUS.BOOKED,
          bookingId,
          holdBookingId: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
          bookedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });

    tx.update(bookingRef, {
      status: BOOKING_STATUS.PAID,
      payment: payment || null,
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { outcome: "confirmed", booking };
  });
}

/** Put seats back in the pool and close the booking with the given status. */
async function releaseSeats(db, opts) {
  const { eventId, bookingId, nextStatus } = opts;
  const bookingRef = db.collection("bookings").doc(bookingId);

  return db.runTransaction(async (tx) => {
    const bookingSnap = await tx.get(bookingRef);
    if (!bookingSnap.exists) return { released: false, reason: "not-found" };

    const booking = bookingSnap.data();
    if (booking.status === BOOKING_STATUS.PAID) {
      return { released: false, reason: "already-paid" };
    }
    // Already closed. The failure webhook and the client verify call can both
    // land here, so this has to be a no-op the second time.
    if (
      booking.status === BOOKING_STATUS.EXPIRED ||
      booking.status === BOOKING_STATUS.RELEASED ||
      booking.status === BOOKING_STATUS.FAILED
    ) {
      return { released: false, reason: "already-closed" };
    }

    const refs = booking.seats.map((id) => seatRef(db, eventId, id));
    const snaps = await tx.getAll(...refs);

    snaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const d = snap.data();
      // Only clear seats this booking still owns.
      if (d.holdBookingId !== bookingId || d.status === HOLD_STATUS.BOOKED) return;
      tx.set(
        refs[i],
        {
          status: HOLD_STATUS.AVAILABLE,
          holdBookingId: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
          heldByUid: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });

    tx.update(bookingRef, {
      status: nextStatus || BOOKING_STATUS.RELEASED,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { released: true, seats: booking.seats };
  });
}

/** Short, readable ticket reference derived from the booking id. */
function makeReference(bookingId) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let hash = 0;
  for (let i = 0; i < bookingId.length; i++) {
    hash = (hash * 31 + bookingId.charCodeAt(i)) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[hash % alphabet.length];
    hash = Math.floor(hash / alphabet.length) + (i + 1) * 7919;
  }
  return "PFA-" + out;
}

module.exports = {
  HOLD_STATUS,
  BOOKING_STATUS,
  holdSeats,
  confirmSeats,
  releaseSeats,
  makeReference,
  seatRef
};
