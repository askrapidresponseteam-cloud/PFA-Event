"use strict";

/**
 * Admin surface.
 *
 * Deliberately small. Everything here exists because running the event needs
 * it, not because an admin panel usually has it. Access is a single custom
 * claim, admin true, granted with scripts/grant-admin.js.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const seats = require("./lib/seats");

const db = () => admin.firestore();

/** Timestamps can be a Timestamp, a Date, or absent. Never let one row break the list. */
function ms(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value.seconds === "number") return value.seconds * 1000;
  return null;
}

function assertAdmin(request) {
  const token = request.auth && request.auth.token;
  if (!token || token.admin !== true) {
    throw new HttpsError("permission-denied", "This area is for event organisers.");
  }
  return request.auth.uid;
}

/* ---------------------------------------------------------------------------
   adminListBookings
   Bookings plus contact details, which the browser cannot read directly.
   --------------------------------------------------------------------------- */
exports.adminListBookings = onCall({ cors: true }, async (request) => {
  assertAdmin(request);
  const eventId = String(request.data?.eventId || "").trim();
  if (!eventId) throw new HttpsError("invalid-argument", "Missing event.");

  const snap = await db()
    .collection("bookings")
    .where("eventId", "==", eventId)
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();

  const rows = await Promise.all(
    snap.docs.map(async (doc) => {
      try {
      const b = doc.data();
      let contact = {};
      // Only pull personal details for bookings that actually matter.
      if (["paid", "paid_unfulfilled", "pending", "holding"].includes(b.status)) {
        const c = await doc.ref.collection("private").doc("contact").get();
        contact = c.exists ? c.data() : {};
      }
      return {
        id: doc.id,
        reference: b.reference || seats.makeReference(doc.id),
        status: b.status,
        seats: b.seats || [],
        seatCount: b.seatCount || (b.seats || []).length,
        amount: b.amount || 0,
        name: contact.name || null,
        email: contact.email || null,
        phone: contact.phone || null,
        createdAt: ms(b.createdAt),
        paidAt: ms(b.paidAt),
        source: b.source || "online",
        method: b.payment?.method || null,
        needsAttention: !!b.needsAttention,
        unavailableSeats: b.unavailableSeats || [],
        note: b.note || null
      };
      } catch (err) {
        logger.error("Could not read booking", { id: doc.id, err: err.message });
        return { id: doc.id, reference: doc.id, status: "unreadable", seats: [],
                 seatCount: 0, amount: 0, broken: true };
      }
    })
  );

  return { bookings: rows, fetchedAt: Date.now() };
});

/* ---------------------------------------------------------------------------
   adminOfflineBooking
   Cash at the door, a sponsor's seats, a comp. Reuses the same locking and the
   same email trigger as a paid online booking.
   --------------------------------------------------------------------------- */
exports.adminOfflineBooking = onCall({ cors: true }, async (request) => {
  const uid = assertAdmin(request);
  const d = request.data || {};

  const eventId = String(d.eventId || "").trim();
  const name    = String(d.name || "").trim().replace(/\s+/g, " ");
  const email   = String(d.email || "").trim().toLowerCase();
  const phone   = String(d.phone || "").replace(/\D/g, "").slice(-10);
  const method  = ["cash", "upi", "bank", "comp", "sponsor"].includes(d.method) ? d.method : "cash";
  const note    = String(d.note || "").trim().slice(0, 200);
  const seatIds = [...new Set((Array.isArray(d.seats) ? d.seats : []).map((s) => String(s).trim().toUpperCase()))].sort();

  if (!eventId) throw new HttpsError("invalid-argument", "Missing event.");
  if (name.length < 2) throw new HttpsError("invalid-argument", "Enter a name for the booking.");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpsError("invalid-argument", "That email does not look right. Leave it empty if there is none.");
  }
  if (phone && !/^[6-9]\d{9}$/.test(phone)) {
    throw new HttpsError("invalid-argument", "That phone number does not look right. Leave it empty if there is none.");
  }
  if (!seatIds.length) throw new HttpsError("invalid-argument", "Pick at least one seat.");
  if (seatIds.some((s) => !/^[A-Z]\d{1,2}$/.test(s))) throw new HttpsError("invalid-argument", "One of those seat ids is not valid.");

  const eventSnap = await db().collection("events").doc(eventId).get();
  if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = eventSnap.data();

  // A comp is free whatever the row costs. Otherwise the seats price
  // themselves inside the hold transaction, exactly as an online booking does,
  // so a premium row is charged correctly at the door too.
  const seatPrice = method === "comp" ? 0 : Number(event.seatPrice || 0);

  const bookingRef = db().collection("bookings").doc();
  const bookingId = bookingRef.id;

  let amount;
  try {
    const held = await seats.holdSeats(db(), {
      eventId, seatIds, bookingId, uid,
      holdMs: 60 * 1000,
      seatPrice,
      forcePrice: method === "comp" ? 0 : undefined,
      contact: { name, email: email || null, phone: phone || null }
    });
    amount = held.amount;
  } catch (err) {
    if (err.code === "seat-taken" || err.code === "seat-missing") {
      throw new HttpsError("aborted", "Seat " + err.seat + " is not available.");
    }
    throw new HttpsError("internal", "Could not hold those seats.");
  }

  await bookingRef.update({
    source: "offline",
    note: note || null,
    createdBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  const result = await seats.confirmSeats(db(), {
    eventId, bookingId,
    payment: { source: "offline", method, amount, at: new Date().toISOString(), takenBy: uid }
  });

  if (result.outcome !== "confirmed") {
    throw new HttpsError("aborted", "Those seats were taken while the booking was being written.");
  }

  logger.info("Offline booking created", { bookingId, seats: seatIds, method, by: uid });

  // If an email was given, the existing trigger sends the same ticket.
  return {
    bookingId,
    reference: seats.makeReference(bookingId),
    seats: seatIds,
    amount,
    emailed: !!email
  };
});

/* ---------------------------------------------------------------------------
   adminSetEventStatus  open, closed, soldout
   --------------------------------------------------------------------------- */
exports.adminSetEventStatus = onCall({ cors: true }, async (request) => {
  const uid = assertAdmin(request);
  const eventId = String(request.data?.eventId || "").trim();
  const status = String(request.data?.status || "").trim();
  if (!["open", "closed", "soldout"].includes(status)) {
    throw new HttpsError("invalid-argument", "Status must be open, closed or soldout.");
  }
  await db().collection("events").doc(eventId).update({
    status,
    statusChangedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { eventId, status };
});

/* ---------------------------------------------------------------------------
   adminSaveEventConfig

   Lets the organiser change the room and the prices without a developer.

   The dangerous part is not writing the values, it is what happens to seats
   that already exist. Shrinking a row could orphan a seat somebody has paid
   for, so this refuses any change that would remove a seat which is sold or on
   hold, and names them. Everything else is applied in one transaction: new
   seats appear as available, prices are written onto every seat, and the event
   document is updated.

   Prices already charged are never touched. A booking records its own amount
   when it is made, so repricing a row affects future bookings only.
   --------------------------------------------------------------------------- */
exports.adminSaveEventConfig = onCall({ cors: true }, async (request) => {
  assertAdmin(request);

  const data = request.data || {};
  const eventId = String(data.eventId || "").trim();
  if (!eventId) throw new HttpsError("invalid-argument", "Missing event.");

  const rowsIn = Array.isArray(data.rows) ? data.rows : null;
  if (!rowsIn || !rowsIn.length) {
    throw new HttpsError("invalid-argument", "Add at least one row.");
  }
  if (rowsIn.length > 26) {
    throw new HttpsError("invalid-argument", "There is room for 26 rows, A to Z.");
  }

  const rows = rowsIn.map((r, i) => {
    const seatCount = Math.trunc(Number(r && r.seats));
    const price = Number(r && r.price);
    const label = String.fromCharCode(65 + i);
    if (!Number.isFinite(seatCount) || seatCount < 1 || seatCount > 40) {
      throw new HttpsError("invalid-argument", "Row " + label + " needs between 1 and 40 seats.");
    }
    // Not zero: Cashfree cannot process a nil order, so a free seat has to be
    // given as a comp from the offline booking dialog instead.
    if (!Number.isFinite(price) || price < 1 || price > 1000000) {
      throw new HttpsError("invalid-argument",
        "Row " + label + " needs a price of at least Rs 1. For free seats, use a complimentary offline booking.");
    }
    return { seats: seatCount, price: Number(price.toFixed(2)) };
  });

  const capacity = rows.reduce((sum, r) => sum + r.seats, 0);
  if (capacity > 500) {
    throw new HttpsError("invalid-argument", "That is more than 500 seats, which this is not built for.");
  }

  // Optional event details. Only fields actually supplied are written.
  const details = {};
  for (const key of ["title", "venue", "dateLabel", "timeLabel", "navTag", "mapsUrl"]) {
    if (typeof data[key] === "string") details[key] = data[key].trim().slice(0, 300);
  }
  if (data.maxPerBooking !== undefined) {
    const m = Math.trunc(Number(data.maxPerBooking));
    if (!Number.isFinite(m) || m < 1 || m > 20) {
      throw new HttpsError("invalid-argument", "Maximum seats per booking must be between 1 and 20.");
    }
    details.maxPerBooking = m;
  }
  if (details.mapsUrl && !/^https:\/\//i.test(details.mapsUrl)) {
    throw new HttpsError("invalid-argument", "The directions link must start with https://");
  }

  // The real start moment. Everything time based hangs off this: the countdown
  // on the booking page and both reminder emails. The two labels above are only
  // what gets printed, and cannot be computed from.
  if (typeof data.startsAt === "string" && data.startsAt.trim()) {
    const raw = data.startsAt.trim();
    // A datetime-local field sends "2026-08-09T16:00" with no zone. India is
    // +05:30 all year, so attach it rather than letting the server guess UTC.
    const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw + "+05:30";
    const at = Date.parse(withZone);
    if (!Number.isFinite(at)) {
      throw new HttpsError("invalid-argument", "That start date and time could not be read.");
    }
    details.startsAt = admin.firestore.Timestamp.fromMillis(at);
  }

  const eventRef = db().collection("events").doc(eventId);
  const seatsCol = eventRef.collection("seats");

  // Target seat ids implied by the new layout.
  const target = new Map();
  rows.forEach((r, i) => {
    const label = String.fromCharCode(65 + i);
    for (let n = 1; n <= r.seats; n++) target.set(label + n, r.price);
  });

  const existing = await seatsCol.get();
  const now = Date.now();

  // Refuse before writing anything if the change would strand a live seat.
  const stranded = [];
  existing.forEach((doc) => {
    if (target.has(doc.id)) return;
    const d = doc.data();
    const liveHold = d.status === "held" && d.holdExpiresAt &&
      (typeof d.holdExpiresAt.toMillis === "function" ? d.holdExpiresAt.toMillis() : 0) > now;
    if (d.status === "booked" || liveHold) stranded.push(doc.id);
  });
  if (stranded.length) {
    throw new HttpsError(
      "failed-precondition",
      "Cannot remove " + stranded.sort().join(", ") +
      " because " + (stranded.length === 1 ? "it is" : "they are") +
      " sold or on hold. Keep those rows at their current size, or wait for the holds to lapse."
    );
  }

  const toDelete = [];
  existing.forEach((doc) => { if (!target.has(doc.id)) toDelete.push(doc.ref); });

  const batchLimit = 400;
  if (target.size + toDelete.length > batchLimit) {
    throw new HttpsError("failed-precondition", "That is too large a change to apply in one go.");
  }

  const batch = db().batch();
  batch.set(eventRef, {
    ...details,
    rows,
    seatPrice: rows[0].price,          // legacy readers and a sensible default
    capacity,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const existingIds = new Set(existing.docs.map((d) => d.id));
  for (const [seatId, price] of target) {
    const ref = seatsCol.doc(seatId);
    if (existingIds.has(seatId)) {
      // Keep whatever state the seat is in, only restate the price.
      batch.set(ref, { price, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    } else {
      batch.set(ref, {
        status: "available", price, bookingId: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
  toDelete.forEach((ref) => batch.delete(ref));
  await batch.commit();

  logger.info("Event config saved", {
    eventId, rows: rows.length, capacity, removed: toDelete.length, by: request.auth.uid
  });

  return { ok: true, rows, capacity, added: target.size - existingIds.size, removed: toDelete.length };
});
