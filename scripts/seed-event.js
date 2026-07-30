#!/usr/bin/env node
"use strict";

/**
 * Create or update the event and its seat map.
 *
 *   npm i firebase-admin
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   node scripts/seed-event.js
 *
 * Safe to re-run. Seats that are already booked or held are left untouched
 * unless you pass --reset, which opens every seat back up:
 *
 *   node scripts/seed-event.js --reset
 *
 * Use --reset before going live, and after any round of test bookings, so the
 * map starts with a clean full house. It refuses to run if there are confirmed
 * paid bookings, unless you add --force.
 *
 * --reset --purge --force additionally deletes this event's bookings and their
 * webhook records, so sandbox test rounds leave nothing behind. Never run purge
 * against a live event: it erases who paid.
 */

const admin = require("firebase-admin");

const RESET = process.argv.includes("--reset");
const FORCE = process.argv.includes("--force");
const PURGE = process.argv.includes("--purge");

const EVENT_ID = "pfa-standup-2026-08-09";

const EVENT = {
  title: "Stand up for a better world.",
  headline: "Stand up for a better world.",
  kicker: "A Comedy Show for Animal Welfare",
  lede:
    'One evening of stand-up with <strong>Appurv Gupta</strong>, featuring ' +
    '<strong>Ravi Khurana</strong> &amp; <strong>Gourav Mahna</strong>. ' +
    "Come for the laughs. Stay for the cause. Every rupee goes to animal welfare initiatives.",
  navTag: "Fundraiser \u00B7 Delhi",
  venue: "Agama Cafe & Bar, GK, Delhi",
  mapsUrl: "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(
    "M-18, Block M, Greater Kailash II, Greater Kailash, New Delhi, Delhi 110048"),
  dateLabel: "Sunday, 9 August",
  timeLabel: "4 to 6 PM",

  /* The real start time, as opposed to the two labels above which are only
     what the page prints. This is what the countdown counts to and what the
     reminder emails are scheduled from, so it has to be a real moment with a
     timezone. India is +05:30 all year, no daylight saving. */
  startsAt: "2026-08-09T16:00:00+05:30",
  seatPrice: 399,
  /* The room, front to back. Row A is nearest the mic. Rows may differ in
     width and in price; the map centres each one, so a 3 seat row sits under
     the middle of a 7 seat row. Labels are A, B, C ... in order.

     After the first seed you can change all of this from the seat desk, under
     Event setup, without touching this file again. */
  rows: [
    { seats: 3, price: 399 },
    { seats: 3, price: 399 },
    { seats: 4, price: 399 },
    { seats: 4, price: 399 },
    { seats: 5, price: 399 },
    { seats: 5, price: 399 },
    { seats: 5, price: 399 },
    { seats: 5, price: 399 }
  ],
  holdMinutes: 5,
  maxPerBooking: 10,
  status: "open",          // open | closed | soldout
  currency: "INR"
};

async function main() {
  admin.initializeApp();
  const db = admin.firestore();

  const eventRef = db.collection("events").doc(EVENT_ID);
  await eventRef.set(
    Object.assign({}, EVENT, {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }),
    { merge: true }
  );
  console.log("Event written:", EVENT_ID);

  if (RESET && !FORCE) {
    const paid = await db
      .collection("bookings")
      .where("eventId", "==", EVENT_ID)
      .where("status", "in", ["paid", "paid_unfulfilled"])
      .limit(1)
      .get();
    if (!paid.empty) {
      console.error(
        "\nRefusing to reset: this event already has confirmed paid bookings.\n" +
        "Resetting would free seats people have paid for.\n" +
        "Run scripts/door-list.js to see them, or add --force if you are certain."
      );
      process.exit(1);
    }
  }

  if (PURGE) {
    if (!RESET || !FORCE) {
      console.error("--purge only runs together with --reset --force, to make the intent explicit.");
      process.exit(1);
    }
    const gone = await db.collection("bookings").where("eventId", "==", EVENT_ID).get();
    for (const doc of gone.docs) {
      await doc.ref.collection("private").doc("contact").delete().catch(() => {});
      await doc.ref.delete();
    }
    const hooks = await db.collection("webhookEvents").get();
    let hookCount = 0;
    for (const doc of hooks.docs) {
      const d = doc.data();
      if (d.bookingId && gone.docs.some((g) => g.id === d.bookingId)) { await doc.ref.delete(); hookCount++; }
    }
    console.log("Purged " + gone.size + " test booking(s) and " + hookCount + " webhook record(s).");
  }

  const seatsCol = eventRef.collection("seats");
  const existing = await seatsCol.get();
  const known = new Map(existing.docs.map((d) => [d.id, d.data()]));

  let batch = db.batch();
  let ops = 0;
  let created = 0;
  let skipped = 0;

  for (let r = 0; r < EVENT.rows.length; r++) {
    const rowName = String.fromCharCode(65 + r);
    for (let i = 1; i <= EVENT.rows[r].seats; i++) {
      const id = rowName + i;
      const current = known.get(id);

      if (current && !RESET) {
        const inPlay = current.status === "booked" || current.status === "held";
        if (inPlay) { skipped++; continue; }
      }

      batch.set(
        seatsCol.doc(id),
        {
          row: rowName,
          number: i,
          price: EVENT.rows[r].price,
          status: "available",
          bookingId: null,
          // Clear any leftover hold so a re-run genuinely opens the seat.
          holdBookingId: admin.firestore.FieldValue.delete(),
          holdExpiresAt: admin.firestore.FieldValue.delete(),
          heldByUid: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: !RESET }
      );
      created++;
      if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
  }
  if (ops) await batch.commit();

  const capacity = EVENT.rows.reduce((a, b) => a + b.seats, 0);
  console.log(
    "Seats written: " + created + ", left alone: " + skipped +
    (RESET ? " (reset mode, every seat reopened)" : "")
  );
  const priceList = [...new Set(EVENT.rows.map((r) => r.price))];
  console.log("Capacity: " + capacity + " seats, all on sale");
  console.log("Pricing: " + (priceList.length === 1
    ? "Rs " + priceList[0] + " a seat"
    : EVENT.rows.map((r, i) => String.fromCharCode(65 + i) + " Rs " + r.price).join(", ")));
  if (skipped) {
    console.log("\n" + skipped + " seat(s) were booked or held and left alone. " +
      "Re-run with --reset to open those too.");
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
