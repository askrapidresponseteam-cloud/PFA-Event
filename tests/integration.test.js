"use strict";
/* Integration tests against the REAL functions/index.js.
   Firebase runtime, Firestore, SMTP and Cashfree are stubbed at the module
   boundary; every line of application code in between is the deployed code. */

const crypto = require("crypto");
require("./loader");

process.env.GCLOUD_PROJECT = "pfa-test";
global.__CFG = {
  CASHFREE_APP_ID: "app_test",
  CASHFREE_SECRET_KEY: "secret_test_key",
  CASHFREE_MODE: "sandbox",
  PUBLIC_BASE_URL: "https://pfa.example/seat-booking.html",
  SMTP_HOST: "smtp.test", SMTP_PORT: "587", SMTP_USER: "t@pfa.org", SMTP_PASS: "x",
  MAIL_FROM: "PFA <t@pfa.org>", MAIL_ORGANISER: "events@pfa.org",
  HOLD_MINUTES: 5, MAX_SEATS_PER_BOOKING: 10
};

/* ---- Cashfree API stub, routed like the real REST surface ---- */
global.__CF = { orders: new Map(), failCreate: false, rejectShortExpiry: false };
global.fetch = async (url, opts) => {
  const u = new URL(url);
  const send = (code, body) => ({ ok: code < 400, status: code, text: async () => JSON.stringify(body) });

  if (opts && opts.method === "POST" && u.pathname === "/pg/orders") {
    const body = JSON.parse(opts.body);
    if (global.__CF.failCreate) return send(503, { message: "gateway unavailable" });
    if (global.__CF.rejectShortExpiry) {
      const mins = (new Date(body.order_expiry_time) - Date.now()) / 60000;
      if (mins < 15) return send(400, { message: "order_expiry_time should be at least 15 minutes from now" });
    }
    global.__CF.orders.set(body.order_id, { ...body, order_status: "ACTIVE" });
    return send(200, { order_id: body.order_id, cf_order_id: "cf_" + body.order_id,
      payment_session_id: "sess_" + body.order_id, order_status: "ACTIVE" });
  }
  const m = u.pathname.match(/^\/pg\/orders\/([^/]+)$/);
  if (m) {
    const o = global.__CF.orders.get(decodeURIComponent(m[1]));
    if (!o) return send(404, { message: "order not found" });
    return send(200, { order_id: o.order_id, cf_order_id: "cf_" + o.order_id,
      order_status: o.order_status, order_amount: o.order_amount });
  }
  return send(500, { message: "unrouted " + u.pathname });
};

const admin = require("firebase-admin");
const store = admin.__store;
const fns = require("../functions/index.js");

/* ---- helpers ---- */
let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? (pass++, console.log("  PASS  " + n))
  : (fail++, console.log("  FAIL  " + n + (e !== undefined ? "  -> " + JSON.stringify(e) : ""))); };
const err = async (fn, req) => { try { await fn(req); return null; } catch (e) { return e; } };

const EV = "pfa-standup-2026-08-09";
// A synthetic room, deliberately on three price tiers so every test
// exercises per row pricing rather than a single flat figure.
const ROWS = [
  { seats: 3, price: 599 }, { seats: 3, price: 599 }, { seats: 3, price: 599 },
  { seats: 6, price: 399 }, { seats: 6, price: 399 },
  { seats: 7, price: 349 }, { seats: 7, price: 349 }
];
const PRICE = {};
ROWS.forEach((r, i) => { PRICE[String.fromCharCode(65 + i)] = r.price; });
const costOf = (ids) => ids.reduce((t, id) => t + PRICE[id[0]], 0);
function reset() {
  store.clear(); global.__MAIL = []; global.__MAIL_FAIL = false; global.__LOG = [];
  global.__CF.orders.clear(); global.__CF.failCreate = false; global.__CF.rejectShortExpiry = false;
  store.set("events/" + EV, { title: "Show", venue: "V", dateLabel: "Sat 9 Aug", timeLabel: "4 PM",
    seatPrice: 399, rows: ROWS, holdMinutes: 5, maxPerBooking: 10, status: "open" });
  ROWS.forEach((row, r) => {
    for (let i = 1; i <= row.seats; i++)
      store.set("events/" + EV + "/seats/" + String.fromCharCode(65 + r) + i,
        { status: "available", price: row.price });
  });
}
const asUser = (uid, data) => ({ auth: { uid, token: {} }, data });
const good = { eventId: EV, name: "Karthik Dhanya", email: "k@example.com", phone: "9876543210" };
const seat = (id) => store.get("events/" + EV + "/seats/" + id);
const bookingOf = (id) => store.get("bookings/" + id);

function sign(body, ts, key) {
  return crypto.createHmac("sha256", key || "secret_test_key").update(ts + body).digest("base64");
}
async function webhook(type, orderId, bookingId, opts = {}) {
  // Default to what the booking actually owes, so a test never accidentally
  // trips the underpayment guard just because rows are priced differently.
  const owed = opts.amount !== undefined
    ? opts.amount
    : Number((store.get("bookings/" + bookingId) || {}).amount || 0);
  const body = JSON.stringify({ type, data: {
    order: { order_id: orderId, order_amount: owed, order_tags: { booking_id: bookingId } },
    payment: { payment_status: opts.status || (type === "PAYMENT_SUCCESS_WEBHOOK" ? "SUCCESS" : "FAILED"),
      payment_amount: owed, cf_payment_id: "p1", payment_group: "upi" } } });
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const raw = Buffer.from(body);
  let statusCode = 0, sent = "";
  const res = { status(c) { statusCode = c; return this; }, send(t) { sent = t; return this; } };
  await fns.cashfreeWebhook({ method: opts.method || "POST",
    get: (h) => ({ "x-webhook-signature": opts.badSig ? "AAAA" : sign(body, ts, opts.key),
                   "x-webhook-timestamp": ts })[h.toLowerCase()],
    rawBody: raw }, res);
  return { statusCode, sent };
}
async function fireSettled(bookingId) {
  const snap = { exists: true, data: () => ({ ...store.get("bookings/" + bookingId) }),
    ref: admin.firestore().doc("bookings/" + bookingId) };
  await fns.onBookingSettled({ data: { after: snap }, params: { bookingId } });
}

(async () => {

console.log("\n[1] The golden path, end to end");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["A1", "A2"] }));
  ok("booking created with a session id", /^sess_/.test(r.paymentSessionId), r.paymentSessionId);
  ok("amount priced from the seat rows, not the client", r.amount === costOf(["A1","A2"]), r.amount);
  ok("hold expires in 5 minutes", Math.abs(r.holdExpiresAt - Date.now() - 300000) < 2000);
  ok("seats held", seat("A1").status === "held" && seat("A2").status === "held");
  ok("Cashfree order expiry tracks the hold plus a minute",
    Math.abs(new Date(global.__CF.orders.get(r.orderId).order_expiry_time) - r.holdExpiresAt - 60000) < 2000);

  global.__CF.orders.get(r.orderId).order_status = "PAID";
  const w = await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { amount: costOf(["A1","A2"]) });
  ok("webhook accepted", w.statusCode === 200, w);
  ok("seats booked", seat("A1").status === "booked" && seat("A2").status === "booked");
  ok("booking paid", bookingOf(r.bookingId).status === "paid");

  await fireSettled(r.bookingId);
  ok("ticket email sent to the donor", global.__MAIL.some((m) => m.to === "k@example.com"));
  ok("organiser notified", global.__MAIL.some((m) => m.to === "events@pfa.org"));
  ok("QR carries the reference", global.__QR === bookingOf(r.bookingId).reference, global.__QR);
  const before = global.__MAIL.length;
  await fireSettled(r.bookingId);
  ok("re-firing the trigger sends nothing twice", global.__MAIL.length === before);
}

console.log("\n[2] Failed payment frees the seats immediately");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["B1"] }));
  const w = await webhook("PAYMENT_FAILED_WEBHOOK", r.orderId, r.bookingId);
  ok("webhook accepted", w.statusCode === 200);
  ok("seat back on sale at once", seat("B1").status === "available");
  ok("booking marked failed", bookingOf(r.bookingId).status === "failed");
  const again = await fns.createBooking(asUser("u2", { ...good, seats: ["B1"] }));
  ok("someone else can buy it straight away", again.seats[0] === "B1");
}

console.log("\n[3] Webhook security");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["C1"] }));
  ok("bad signature rejected 401", (await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { badSig: true })).statusCode === 401);
  ok("wrong secret rejected 401", (await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { key: "wrong" })).statusCode === 401);
  ok("stale timestamp rejected 401", (await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { ts: Math.floor(Date.now()/1000) - 3600 })).statusCode === 401);
  ok("GET rejected 405", (await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { method: "GET" })).statusCode === 405);
  ok("seat untouched by all of it", seat("C1").status === "held");
  const w1 = await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId);
  const w2 = await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId);
  ok("duplicate delivery is idempotent", w1.statusCode === 200 && w2.statusCode === 200 && seat("C1").status === "booked");
}

console.log("\n[4] Underpayment cannot buy seats");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["D1", "D2", "D3"] })); // owes 3 x 399
  const w = await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { amount: 399 });
  ok("webhook still answered 200", w.statusCode === 200);
  ok("seats withheld", seat("D1").status !== "booked");
  ok("booking flagged for a person", bookingOf(r.bookingId).needsAttention === true);
  ok("both figures recorded", bookingOf(r.bookingId).amountMismatch.owed === costOf(["D1","D2","D3"]) && bookingOf(r.bookingId).amountMismatch.got === 399);
}

console.log("\n[5] verifyPayment as the browser uses it");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["E1"] }));
  ok("unauthenticated rejected", (await err(fns.verifyPayment, { auth: null, data: { bookingId: r.bookingId } }))?.code === "unauthenticated");
  ok("someone else's session rejected", (await err(fns.verifyPayment, asUser("u2", { bookingId: r.bookingId })))?.code === "permission-denied");
  let v = await fns.verifyPayment(asUser("u1", { bookingId: r.bookingId }));
  ok("pending while unpaid", v.status === "pending" && v.orderStatus === "ACTIVE", v);
  global.__CF.orders.get(r.orderId).order_status = "PAID";
  v = await fns.verifyPayment(asUser("u1", { bookingId: r.bookingId }));
  ok("confirms once Cashfree says PAID", v.status === "paid" && seat("E1").status === "booked");
  ok("carries the reference for the screen", /^PFA-/.test(v.reference));
}

console.log("\n[6] verifyPayment on an expired order frees the seats");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["E2"] }));
  global.__CF.orders.get(r.orderId).order_status = "EXPIRED";
  const v = await fns.verifyPayment(asUser("u1", { bookingId: r.bookingId }));
  ok("reports failed", v.status === "failed", v);
  ok("seat released", seat("E2").status === "available");
}

console.log("\n[7] Gateway down at order creation");
{
  reset();
  global.__CF.failCreate = true;
  const e = await err(fns.createBooking, asUser("u1", { ...good, seats: ["A3"] }));
  ok("caller told the gateway is unavailable", e && e.code === "unavailable", e && e.code);
  ok("seats given straight back", seat("A3").status === "available");
  ok("booking closed as failed", Object.entries(Object.fromEntries(store)).some(([k, v]) => k.startsWith("bookings/") && v.status === "failed"));
}

console.log("\n[8] Account that enforces a long order window");
{
  reset();
  global.__CF.rejectShortExpiry = true;
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["D1"] }));
  ok("falls back to a wide window and succeeds", /^sess_/.test(r.paymentSessionId));
  const mins = (new Date(global.__CF.orders.get(r.orderId).order_expiry_time) - Date.now()) / 60000;
  ok("fallback window is about 20 minutes", mins > 18 && mins < 21, mins.toFixed(1));
  ok("the warning is in the logs", global.__LOG.some(([l, m]) => l === "warn" && /widening/.test(m)));
}

console.log("\n[9] Concurrent-hold guard");
{
  reset();
  await fns.createBooking(asUser("u1", { ...good, seats: ["D2"] }));
  await fns.createBooking(asUser("u1", { ...good, seats: ["D3"] }));
  const e = await err(fns.createBooking, asUser("u1", { ...good, seats: ["D6"] }));
  ok("a third simultaneous hold is refused", e && e.code === "resource-exhausted", e && e.code);
  ok("a different person is unaffected", /^sess_/.test((await fns.createBooking(asUser("u9", { ...good, seats: ["D6"] }))).paymentSessionId));
}

console.log("\n[10] Input fuzzing on createBooking");
{
  reset();
  const cases = [
    ["no auth", { auth: null, data: { ...good, seats: ["A1"] } }, "unauthenticated"],
    ["empty seats", asUser("u", { ...good, seats: [] }), "invalid-argument"],
    ["seats not an array", asUser("u", { ...good, seats: "A1" }), "invalid-argument"],
    ["malformed seat id", asUser("u", { ...good, seats: ["A1;DROP"] }), "invalid-argument"],
    ["eleven seats", asUser("u", { ...good, seats: [...Array.from({length:7},(_,i)=>"F"+(i+1)), ...Array.from({length:4},(_,i)=>"G"+(i+1))] }), "invalid-argument"],
    ["one-letter name", asUser("u", { ...good, name: "K", seats: ["A1"] }), "invalid-argument"],
    ["bad email", asUser("u", { ...good, email: "not-an-email", seats: ["A1"] }), "invalid-argument"],
    ["landline phone", asUser("u", { ...good, phone: "1234567890", seats: ["A1"] }), "invalid-argument"],
    ["unknown event", asUser("u", { ...good, eventId: "nope", seats: ["A1"] }), "not-found"],
    ["null payload", asUser("u", null), "invalid-argument"]
  ];
  for (const [name, req, code] of cases) {
    const e = await err(fns.createBooking, req);
    ok(name + " -> " + code, e && e.code === code, e && e.code);
  }
  ok("no seat was touched by any of it",
    [...store.keys()].filter((k) => k.includes("/seats/")).every((k) => store.get(k).status === "available"));
  const dup = await fns.createBooking(asUser("u", { ...good, seats: ["a1", "A1", " a1 "] }));
  ok("duplicate and lowercase seats collapse to one", dup.seats.length === 1 && dup.seats[0] === "A1" && dup.amount === PRICE.A, dup.seats);
}

console.log("\n[11] Closed event refuses bookings");
{
  reset();
  store.set("events/" + EV, { ...store.get("events/" + EV), status: "closed" });
  const e = await err(fns.createBooking, asUser("u1", { ...good, seats: ["A1"] }));
  ok("closed -> failed-precondition", e && e.code === "failed-precondition", e && e.code);
}

console.log("\n[12] Reconciler recovers a totally lost payment");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["B3", "E3"] }));
  // hold lapses with the webhook never arriving and the browser gone
  store.set("bookings/" + r.bookingId, { ...bookingOf(r.bookingId), status: "expired" });
  ["B3", "E3"].forEach((s) => store.set("events/" + EV + "/seats/" + s, { status: "available" }));
  global.__CF.orders.get(r.orderId).order_status = "PAID";
  global.__CF.orders.get(r.orderId).order_amount = costOf(["B3","B4"]);
  await fns.reconcilePayments();
  ok("payment found and settled", bookingOf(r.bookingId).status === "paid");
  ok("seats handed over", seat("B3").status === "booked" && seat("E3").status === "booked");
  ok("the recovery is shouted about in the logs", global.__LOG.some(([l, m]) => l === "error" && /never confirmed/.test(m)));
  const paidCount = [...store.keys()].filter((k) => k.startsWith("bookings/") && !k.includes("/private/") && store.get(k).status === "paid").length;
  await fns.reconcilePayments();
  ok("running it again changes nothing",
    [...store.keys()].filter((k) => k.startsWith("bookings/") && !k.includes("/private/") && store.get(k).status === "paid").length === paidCount);
}

console.log("\n[13] Failed ticket email is retried and recovers");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["E4"] }));
  global.__CF.orders.get(r.orderId).order_status = "PAID";
  await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId);
  global.__MAIL_FAIL = true;
  await fireSettled(r.bookingId);
  ok("send failed and the claim was returned", !bookingOf(r.bookingId).ticketEmailAt && !!bookingOf(r.bookingId).emailError);
  global.__MAIL_FAIL = false;
  await fns.reconcilePayments();          // nudges the document
  await fireSettled(r.bookingId);         // trigger re-fires on that write
  ok("retry sends the ticket", global.__MAIL.some((m) => m.to === "k@example.com"));
  ok("emailError cleared after success", bookingOf(r.bookingId).emailError === undefined);
}

console.log("\n[14] Hold sweeper");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["D4"] }));
  const s = seat("D4");
  store.set("events/" + EV + "/seats/D4", { ...s, holdExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) });
  await fns.sweepHolds();
  ok("expired hold released", seat("D4").status === "available");
  ok("booking expired", bookingOf(r.bookingId).status === "expired");
  const paid = await fns.createBooking(asUser("u2", { ...good, seats: ["D5"] }));
  global.__CF.orders.get(paid.orderId).order_status = "PAID";
  await webhook("PAYMENT_SUCCESS_WEBHOOK", paid.orderId, paid.bookingId);
  await fns.sweepHolds();
  ok("sweeper never touches a booked seat", seat("D5").status === "booked");
}

console.log("\n[15] Admin surface end to end");
{
  reset();
  const org = { auth: { uid: "org1", token: { admin: true } } };
  const punter = { auth: { uid: "u1", token: {} } };
  ok("list refused without the claim", (await err(fns.adminListBookings, { ...punter, data: { eventId: EV } }))?.code === "permission-denied");
  const off = await fns.adminOfflineBooking({ ...org, data: { eventId: EV, seats: ["E3"], name: "Cash Person", email: "c@x.com", phone: "9876543210", method: "cash" } });
  ok("offline booking is instantly paid", bookingOf(off.bookingId).status === "paid" && seat("E3").status === "booked");
  ok("bad email on an offline booking refused", (await err(fns.adminOfflineBooking, { ...org, data: { eventId: EV, seats: ["E4"], name: "X Y", email: "junk", method: "cash" } }))?.code === "invalid-argument");
  ok("bad phone refused", (await err(fns.adminOfflineBooking, { ...org, data: { eventId: EV, seats: ["E4"], name: "X Y", phone: "12345", method: "cash" } }))?.code === "invalid-argument");
  const rows = (await fns.adminListBookings({ ...org, data: { eventId: EV } })).bookings;
  ok("list shows who, what, when", rows[0].name === "Cash Person" && rows[0].seats[0] === "E3" && typeof rows[0].paidAt === "number");
  await fns.adminSetEventStatus({ ...org, data: { eventId: EV, status: "closed" } });
  ok("closing sales blocks the public", (await err(fns.createBooking, asUser("u5", { ...good, seats: ["E5"] })))?.code === "failed-precondition");
  ok("but not the desk", (await fns.adminOfflineBooking({ ...org, data: { eventId: EV, seats: ["E5"], name: "Late Cash", method: "cash" } })).seats[0] === "E5");
}


console.log("\n[16] The operator release script (production smoke test cleanup)");
{
  reset();
  const { releaseBooking } = require("../scripts/release-booking.js");
  const db = admin.firestore();

  // a real paid smoke-test booking
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["D3", "D6"] }));
  global.__CF.orders.get(r.orderId).order_status = "PAID";
  await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId, { amount: costOf(["A6","A7"]) });
  ok("smoke booking is paid", bookingOf(r.bookingId).status === "paid");

  const out = await releaseBooking(db, r.bookingId, "production smoke test", "cli:test");
  ok("release succeeds", out.ok === true, out);
  ok("seats back on sale", seat("D3").status === "available" && seat("D6").status === "available");
  ok("booking marked released, history kept",
    bookingOf(r.bookingId).status === "released" && bookingOf(r.bookingId).previousStatus === "paid");
  ok("who and why recorded",
    bookingOf(r.bookingId).releasedBy === "cli:test" && bookingOf(r.bookingId).releaseReason === "production smoke test");

  const again = await releaseBooking(db, r.bookingId, "again", "cli:test");
  ok("running it twice is refused", again.ok === false && again.why === "already-released", again);

  ok("unknown booking is refused", (await releaseBooking(db, "nope", "x", "cli:test")).why === "not-found");

  // it must never free a seat that now belongs to someone else
  const other = await fns.createBooking(asUser("u2", { ...good, seats: ["D3"] }));
  global.__CF.orders.get(other.orderId).order_status = "PAID";
  await webhook("PAYMENT_SUCCESS_WEBHOOK", other.orderId, other.bookingId);
  // corrupt: pretend the released booking claims A6 again
  store.set("bookings/" + r.bookingId, { ...bookingOf(r.bookingId), status: "paid", seats: ["D3"] });
  await releaseBooking(db, r.bookingId, "corrupt rerun", "cli:test");
  ok("never frees a seat owned by another booking", seat("D3").status === "booked"
     && seat("D3").bookingId === other.bookingId);

  const buyer = await fns.createBooking(asUser("u3", { ...good, seats: ["D6"] }));
  ok("released seats are genuinely sellable again", buyer.seats[0] === "D6");
}


console.log("\n[17] Per row pricing");
{
  reset();
  const front = await fns.createBooking(asUser("u1", { ...good, seats: ["A1", "A2"] }));
  ok("front row charges the premium", front.amount === 599 * 2, front.amount);
  const back = await fns.createBooking(asUser("u2", { ...good, seats: ["G1", "G2"] }));
  ok("back row charges the cheaper tier", back.amount === 349 * 2, back.amount);
  const mixed = await fns.createBooking(asUser("u3", { ...good, seats: ["A3", "D1", "G3"] }));
  ok("a mixed selection sums each row correctly", mixed.amount === 599 + 399 + 349, mixed.amount);
  ok("the per seat breakdown is recorded",
    JSON.stringify(bookingOf(mixed.bookingId).seatPrices) ===
    JSON.stringify([{seat:"A3",price:599},{seat:"D1",price:399},{seat:"G3",price:349}]),
    bookingOf(mixed.bookingId).seatPrices);
  ok("the gateway is told the same figure",
    global.__CF.orders.get(mixed.orderId).order_amount === 1347);

  // a browser cannot talk its way into a cheaper seat
  const cheat = await fns.createBooking({ auth: { uid: "u4", token: {} },
    data: { ...good, seats: ["D2"], amount: 1, seatPrice: 1 } });
  ok("a client supplied price is ignored", cheat.amount === 399, cheat.amount);
}

console.log("\n[18] Event setup: saving the room and the prices");
{
  reset();
  const org = { auth: { uid: "org1", token: { admin: true } } };
  const punter = { auth: { uid: "u1", token: {} } };

  ok("refused without the organiser claim",
    (await err(fns.adminSaveEventConfig, { ...punter, data: { eventId: EV, rows: [{seats:3,price:399}] } }))?.code === "permission-denied");

  const res = await fns.adminSaveEventConfig({ ...org, data: {
    eventId: EV, title: "New title", venue: "New venue", maxPerBooking: 6,
    rows: [{seats:4,price:700},{seats:4,price:700},{seats:8,price:250}]
  }});
  ok("saved", res.ok === true && res.capacity === 16, res);
  ok("event document updated", store.get("events/" + EV).title === "New title"
    && store.get("events/" + EV).maxPerBooking === 6);
  ok("rows stored", JSON.stringify(store.get("events/" + EV).rows) ===
    JSON.stringify([{seats:4,price:700},{seats:4,price:700},{seats:8,price:250}]));
  ok("new seats created and priced", seat("C8") && seat("C8").status === "available" && seat("C8").price === 250);
  ok("existing seat repriced", seat("A1").price === 700);
  ok("seats beyond the new room are gone", seat("D1") === undefined && seat("G7") === undefined);
  ok("capacity recorded", store.get("events/" + EV).capacity === 16);

  // and the booking page charges the new prices immediately
  const b = await fns.createBooking(asUser("u9", { ...good, seats: ["A1", "C1"] }));
  ok("bookings use the new prices at once", b.amount === 700 + 250, b.amount);
  ok("the new per booking cap applies",
    (await err(fns.createBooking, asUser("u8", { ...good, seats: ["C2","C3","C4","C5","C6","C7","C8"] })))?.code === "invalid-argument");
}

console.log("\n[19] Event setup cannot strand a seat somebody paid for");
{
  reset();
  const org = { auth: { uid: "org1", token: { admin: true } } };

  await fns.adminOfflineBooking({ ...org, data: { eventId: EV, seats: ["G7"], name: "Paid Person", method: "cash" } });
  ok("G7 is sold", seat("G7").status === "booked");

  const e = await err(fns.adminSaveEventConfig, { ...org, data: {
    eventId: EV, rows: [{seats:3,price:599},{seats:3,price:599},{seats:3,price:599},
                        {seats:6,price:399},{seats:6,price:399},{seats:7,price:349},{seats:3,price:349}] } });
  ok("shrinking that row is refused", e && e.code === "failed-precondition", e && e.code);
  ok("the refusal names the seat", e && /G7/.test(e.message), e && e.message);
  ok("nothing was written", seat("G7").status === "booked" && seat("G6") !== undefined);

  // a live hold blocks it too
  const h = await fns.createBooking(asUser("u1", { ...good, seats: ["F7"] }));
  const e2 = await err(fns.adminSaveEventConfig, { ...org, data: {
    eventId: EV, rows: [{seats:3,price:599},{seats:3,price:599},{seats:3,price:599},
                        {seats:6,price:399},{seats:6,price:399},{seats:3,price:349},{seats:7,price:349}] } });
  ok("a held seat blocks removal too", e2 && e2.code === "failed-precondition" && /F7/.test(e2.message), e2 && e2.message);

  // but free seats may be removed
  const okRes = await fns.adminSaveEventConfig({ ...org, data: {
    eventId: EV, rows: [{seats:3,price:599},{seats:3,price:599},{seats:3,price:599},
                        {seats:2,price:399},{seats:6,price:399},{seats:7,price:349},{seats:7,price:349}] } });
  ok("removing free seats is allowed", okRes.ok === true && okRes.removed === 4, okRes);
  ok("the sold seat survived untouched", seat("G7").status === "booked");
  ok("repricing never rewrites a booking already made",
    Object.values(Object.fromEntries(store)).some(v => v.status === "paid" && v.amount === 349));
}

console.log("\n[20] Event setup validation");
{
  reset();
  const org = { auth: { uid: "org1", token: { admin: true } } };
  const bad = [
    ["no rows", { eventId: EV, rows: [] }, "invalid-argument"],
    ["zero seats in a row", { eventId: EV, rows: [{seats:0,price:399}] }, "invalid-argument"],
    ["negative price", { eventId: EV, rows: [{seats:3,price:-5}] }, "invalid-argument"],
    ["seats not a number", { eventId: EV, rows: [{seats:"lots",price:399}] }, "invalid-argument"],
    ["27 rows", { eventId: EV, rows: Array.from({length:27},()=>({seats:1,price:399})) }, "invalid-argument"],
    ["absurd cap", { eventId: EV, rows: [{seats:3,price:399}], maxPerBooking: 99 }, "invalid-argument"],
    ["http maps link", { eventId: EV, rows: [{seats:3,price:399}], mapsUrl: "http://x.com" }, "invalid-argument"],
    ["no event", { rows: [{seats:3,price:399}] }, "invalid-argument"]
  ];
  for (const [name, data, code] of bad) {
    const e = await err(fns.adminSaveEventConfig, { ...org, data });
    ok(name + " -> " + code, e && e.code === code, e && e.code);
  }
  ok("the room is untouched by every rejection",
    seat("A1") !== undefined && seat("G7") !== undefined && seat("A1").price === 599);

  // zero is refused, because the gateway cannot process a nil order
  const zero = await err(fns.adminSaveEventConfig, { ...org, data: { eventId: EV, rows: [{seats:3,price:0}] } });
  ok("a zero price row is refused", zero && zero.code === "invalid-argument", zero && zero.code);
  ok("and the refusal explains the alternative", zero && /complimentary/i.test(zero.message), zero && zero.message);
  const one = await fns.adminSaveEventConfig({ ...org, data: { eventId: EV, rows: [{seats:3,price:1}] } });
  ok("but one rupee is fine", one.ok === true);
}

console.log("\n[21] Comps stay free whatever the row costs");
{
  reset();
  const org = { auth: { uid: "org1", token: { admin: true } } };
  const comp = await fns.adminOfflineBooking({ ...org, data: {
    eventId: EV, seats: ["A1", "A2"], name: "Crew", method: "comp" } });
  ok("a comp in the premium row costs nothing", comp.amount === 0, comp.amount);
  const cash = await fns.adminOfflineBooking({ ...org, data: {
    eventId: EV, seats: ["A3"], name: "Cash Person", method: "cash" } });
  ok("but cash at the door pays the row price", cash.amount === 599, cash.amount);
  const backCash = await fns.adminOfflineBooking({ ...org, data: {
    eventId: EV, seats: ["G1"], name: "Back Row", method: "cash" } });
  ok("and the cheaper row charges less", backCash.amount === 349, backCash.amount);
}


console.log("\n[22] Reminder emails, the day before and the day of");
{
  const SHOW = Date.parse("2026-08-09T16:00:00+05:30");
  const setNow = (iso) => { global.__NOW = Date.parse(iso); };
  const realNow = Date.now;
  Date.now = () => (global.__NOW || realNow());

  const seed = async () => {
    reset();
    store.set("events/" + EV, { ...store.get("events/" + EV),
      startsAt: admin.firestore.Timestamp.fromMillis(SHOW),
      venue: "Agama Cafe", timeLabel: "4 to 6 PM", title: "Stand up" });
    const org = { auth: { uid: "org1", token: { admin: true } } };
    await fns.adminOfflineBooking({ ...org, data: {
      eventId: EV, seats: ["A1"], name: "Ticket Holder", email: "t@x.com", method: "cash" } });
  };

  // too early
  await seed(); setNow("2026-08-06T09:00:00+05:30");
  global.__MAIL = [];
  await fns.sendReminders();
  ok("three days out sends nothing", global.__MAIL.length === 0, global.__MAIL.length);

  // the day before
  setNow("2026-08-08T09:00:00+05:30");
  await fns.sendReminders();
  ok("the day before sends one mail", global.__MAIL.length === 1, global.__MAIL.length);
  ok("subject says Tomorrow", /^Tomorrow:/.test(global.__MAIL[0].subject), global.__MAIL[0].subject);
  ok("it carries the reference and seat", /PFA-/.test(global.__MAIL[0].text) && /A1/.test(global.__MAIL[0].text));

  // running again the same day must not mail twice
  await fns.sendReminders();
  ok("a second run that day sends nothing more", global.__MAIL.length === 1, global.__MAIL.length);

  // the morning of
  setNow("2026-08-09T09:00:00+05:30");
  await fns.sendReminders();
  ok("the morning of sends a second mail", global.__MAIL.length === 2, global.__MAIL.length);
  ok("subject says Today", /^Today:/.test(global.__MAIL[1].subject), global.__MAIL[1].subject);
  await fns.sendReminders();
  ok("and only once", global.__MAIL.length === 2, global.__MAIL.length);

  // after the show has begun
  setNow("2026-08-09T18:00:00+05:30");
  const before = global.__MAIL.length;
  await fns.sendReminders();
  ok("nothing goes out once the show has started", global.__MAIL.length === before);

  console.log("\n[23] Who does and does not get reminded");
  await seed();
  const org = { auth: { uid: "org1", token: { admin: true } } };
  await fns.adminOfflineBooking({ ...org, data: {
    eventId: EV, seats: ["B1"], name: "No Email Person", method: "cash" } });
  const held = await fns.createBooking(asUser("u5", { ...good, seats: ["C1"] }));
  setNow("2026-08-08T09:00:00+05:30");
  global.__MAIL = [];
  await fns.sendReminders();
  ok("only paid bookings with an address are mailed", global.__MAIL.length === 1, global.__MAIL.length);
  ok("the unpaid hold is not mailed", !global.__MAIL.some(m => /C1/.test(m.text || "")));

  // an event with no real start time must not crash the run
  await seed();
  const ev = { ...store.get("events/" + EV) }; delete ev.startsAt;
  store.set("events/" + EV, ev);
  global.__MAIL = []; global.__LOG = [];
  await fns.sendReminders();
  ok("an event with no start time is skipped, not crashed", global.__MAIL.length === 0);
  ok("and it says so in the logs", global.__LOG.some(([l, m]) => l === "warn" && /startsAt/.test(m)));

  // a failed send must be retried tomorrow, not silently lost
  await seed(); setNow("2026-08-08T09:00:00+05:30");
  global.__MAIL = []; global.__MAIL_FAIL = true;
  await fns.sendReminders();
  global.__MAIL_FAIL = false;
  const bk = [...store.keys()].find(k => k.startsWith("bookings/") && !k.includes("/private/")
             && store.get(k).status === "paid");
  ok("a failed send returns its claim", store.get(bk).reminderDayBeforeAt === undefined);
  await fns.sendReminders();
  ok("so the next run delivers it", global.__MAIL.length === 1, global.__MAIL.length);

  Date.now = realNow; global.__NOW = null;
}


console.log("\n[24] The ticket email itself");
{
  reset();
  const r = await fns.createBooking(asUser("u1", { ...good, seats: ["E3", "E4"] }));
  global.__CF.orders.get(r.orderId).order_status = "PAID";
  await webhook("PAYMENT_SUCCESS_WEBHOOK", r.orderId, r.bookingId);
  global.__MAIL = [];
  await fireSettled(r.bookingId);

  const t = global.__MAIL.find((m) => m.to === "k@example.com");
  ok("a ticket is sent to the donor", !!t);
  ok("the seat map has one cell per real seat",
    (t.html.match(/width:12px;height:10px/g) || []).length === ROWS.reduce((a, x) => a + x.seats, 0),
    (t.html.match(/width:12px;height:10px/g) || []).length);
  ok("only the booked seats are lit",
    (t.html.match(/background:#4FC3FF;box-shadow/g) || []).length === 2);
  ok("the reference is on the stub", t.html.includes(bookingOf(r.bookingId).reference));
  ok("the QR is attached by content id", t.attachments && t.attachments[0].cid === "pfaticketqr");
  ok("no first-come claim survives", !/first come/i.test(t.html));
  ok("it says the seats are reserved", /reserved in your name/i.test(t.html));

  // email clients cannot lay out with flexbox or grid
  ok("no flexbox or grid anywhere", !/display:\s*(flex|grid)/.test(t.html));
  ok("laid out with tables", (t.html.match(/<table/g) || []).length > 5);
  ok("a plain text alternative exists", typeof t.text === "string" && /Ticket no\./.test(t.text));
  ok("the plain text lists the seats", /E3, E4/.test(t.text), t.text.slice(0, 120));

  // and the ticket is the whole email, not a ticket plus a second message
  ok("no separate confirmation body", !/Thank you for standing up/i.test(t.html));
}

console.log("\n" + "=".repeat(52));
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
