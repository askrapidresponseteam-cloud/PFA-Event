#!/usr/bin/env node
"use strict";

/**
 * Export confirmed bookings to CSV for the door on show night. Print it, and
 * check each person's reference against the list as they arrive.
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   node scripts/door-list.js > door-list.csv
 */

const admin = require("firebase-admin");

const EVENT_ID = process.argv[2] || "pfa-standup-2026-08-09";

function csv(value) {
  const s = String(value == null ? "" : value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function main() {
  admin.initializeApp();
  const db = admin.firestore();

  const snap = await db
    .collection("bookings")
    .where("eventId", "==", EVENT_ID)
    .where("status", "==", "paid")
    .get();

  const rows = [];
  for (const doc of snap.docs) {
    const b = doc.data();
    const contact = (await doc.ref.collection("private").doc("contact").get()).data() || {};
    rows.push([
      b.reference || doc.id,
      contact.name || "",
      contact.email || "",
      contact.phone || "",
      (b.seats || []).slice().sort().join(" "),
      b.seatCount || (b.seats || []).length,
      b.amount || 0,
      b.source || "online",
      b.paidAt && b.paidAt.toDate ? b.paidAt.toDate().toISOString() : ""
    ]);
  }

  rows.sort((a, b) => String(a[4]).localeCompare(String(b[4]), undefined, { numeric: true }));

  const header = [
    "Reference", "Name", "Email", "Phone", "Seats", "Count",
    "Amount", "Booked as", "Paid at"
  ];

  console.log(header.map(csv).join(","));
  rows.forEach((r) => console.log(r.map(csv).join(",")));

  const total = rows.reduce((sum, r) => sum + Number(r[6]), 0);
  const seated = rows.reduce((sum, r) => sum + Number(r[5]), 0);
  console.error(`\n${rows.length} bookings, ${seated} seats confirmed, Rs ${total} collected.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
