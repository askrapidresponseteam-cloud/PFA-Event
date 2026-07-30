#!/usr/bin/env node
"use strict";

/**
 * Free the seats of one booking. Command line only, on purpose.
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   node scripts/release-booking.js <bookingId> --reason "production smoke test"
 *
 * This exists for exactly one situation: you made a real booking to prove the
 * production pipeline works, and now the seat needs to go back on sale.
 *
 * What it does:      seats back to available, booking marked released, with who,
 *                    when and why recorded.
 * What it does NOT:  touch the money. Refund the payment yourself in the
 *                    Cashfree dashboard (Orders, find it, Refund). This script
 *                    reminds you and prints the order id, nothing more.
 *
 * There is deliberately no refund API call and no button for this in the seat
 * desk. The event has no cancellations; this is an operator's tool, and it asks
 * for confirmation before doing anything.
 */

const readline = require("readline");
const admin = require("firebase-admin");

async function releaseBooking(db, bookingId, reason, actor) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection("bookings").doc(bookingId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, why: "not-found" };

    const booking = snap.data();
    if (booking.status === "released") return { ok: false, why: "already-released" };

    const seatRefs = (booking.seats || []).map((id) =>
      db.collection("events").doc(booking.eventId).collection("seats").doc(id)
    );
    const seatSnaps = await tx.getAll(...seatRefs);

    seatSnaps.forEach((s, i) => {
      if (!s.exists) return;
      const d = s.data();
      // Only free seats this booking actually owns.
      const ours = d.bookingId === bookingId || d.holdBookingId === bookingId;
      if (!ours && d.status === "booked") return;
      tx.set(seatRefs[i], {
        status: "available",
        bookingId: null,
        holdBookingId: admin.firestore.FieldValue.delete(),
        holdExpiresAt: admin.firestore.FieldValue.delete(),
        heldByUid: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    tx.update(ref, {
      status: "released",
      previousStatus: booking.status,
      releasedBy: actor,
      releaseReason: reason,
      releasedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { ok: true, booking };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const bookingId = args.find((a) => !a.startsWith("--"));
  const ri = args.indexOf("--reason");
  const reason = ri >= 0 ? String(args[ri + 1] || "").trim() : "";
  const yes = args.includes("--yes");

  if (!bookingId || !reason) {
    console.error('Usage: node scripts/release-booking.js <bookingId> --reason "why"');
    process.exit(1);
  }

  admin.initializeApp();
  const db = admin.firestore();

  const snap = await db.collection("bookings").doc(bookingId).get();
  if (!snap.exists) { console.error("No booking " + bookingId); process.exit(1); }
  const b = snap.data();
  const contact = (await snap.ref.collection("private").doc("contact").get()).data() || {};

  console.log("\nAbout to release:");
  console.log("  Reference : " + (b.reference || bookingId));
  console.log("  Name      : " + (contact.name || "unknown"));
  console.log("  Seats     : " + (b.seats || []).join(", "));
  console.log("  Amount    : Rs " + (b.amount || 0));
  console.log("  Status    : " + b.status);
  console.log("  Reason    : " + reason);

  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((r) => rl.question("\nType the reference to confirm: ", r));
    rl.close();
    if (answer.trim() !== (b.reference || bookingId)) {
      console.error("Did not match. Nothing changed.");
      process.exit(1);
    }
  }

  const out = await releaseBooking(db, bookingId, reason, "cli:" + (process.env.USER || "operator"));
  if (!out.ok) { console.error("Refused: " + out.why); process.exit(1); }

  console.log("\nSeats " + (b.seats || []).join(", ") + " are back on sale.");
  if (b.status === "paid" && b.amount > 0) {
    console.log(
      "\nMONEY: this booking was paid. Nothing here touched it.\n" +
      "Refund it in the Cashfree dashboard: Orders, search " + (b.cfOrderId || "the order") + ", Refund."
    );
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { releaseBooking };
