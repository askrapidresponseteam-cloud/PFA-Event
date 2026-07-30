# PFA Seat Booking

Seat booking for People for Animals fundraisers. Front end plus Firebase backend,
Cashfree payments, and an automatic ticket email on success.

Seats are held for **5 minutes**. If payment does not complete inside that window
the seats go back into the pool automatically.

---

## What is in here

```
public/seat-booking.html      the booking page (drop into the PFA site root)
public/seat-admin.html        the seat desk: bookings, totals, seat map
public/seat-booking-preview.html   clickable booking flow, sample data, no Firebase
public/seat-admin-preview.html     clickable seat desk, sample data, no Firebase
public/media/                 put seat-booking-hero.jpg here (optional)
functions/index.js            callable functions, webhook, sweeper, email trigger
functions/admin.js            organiser callables, guarded by a custom claim
functions/lib/cashfree.js     Cashfree REST client and webhook verification
functions/lib/seats.js        seat state machine, all transactional
functions/lib/email.js        the ticket, organiser alert, reminders, exception notice
firestore.rules               browser can read seat states, nothing else
firestore.indexes.json        indexes the sweeper and guards need
scripts/seed-event.js         create the event and its seat map
scripts/door-list.js          CSV of confirmed bookings for the door
scripts/setup.sh              one shot project setup, safe to re-run
scripts/deploy.sh             test, deploy, wire the webhook URL, seed
scripts/grant-admin.js        grant or revoke seat desk access
scripts/release-booking.js    CLI cleanup after a smoke test (seat only, never money)
tests/integration.test.js     the whole backend driven end to end, in memory
```

---

## The booking rules

Three rules, and nothing else to reason about:

- **Seats chosen** become held for **300 seconds**, for that person only.
- **Payment succeeds** and the seats become booked.
- **Payment fails, is dropped, or the 300 seconds run out** and the seats go
  straight back on sale. Nothing was charged, so there is nothing to refund.

Once a seat is paid for it is booked, and there is no cancellation.

A person is asked **how many seats** before the map unlocks. Once they have
picked that many, the rest of the map goes quiet, so nobody sits there selecting
half the room. Tapping one of their own seats swaps it.

## How the flow works

1. Someone says how many seats they want, picks them, and enters name, email and phone.
2. `createBooking` runs one Firestore transaction that locks those seats for
   5 minutes and writes the booking. Two people clicking the same seat at the
   same instant cannot both win, the transaction settles it.
3. The same call creates a Cashfree order and returns a `payment_session_id`.
   The price comes from the event document, never from the browser.
4. The Cashfree modal opens. A countdown shows the remaining hold.
5. Cashfree calls `cashfreeWebhook`. The signature is verified, the seats flip to
   `booked`, and the booking becomes `paid`. This is the authoritative path.
6. The page also calls `verifyPayment` as a fast path so the person sees the
   result immediately. Both paths are idempotent, so whichever lands first wins
   and the second is a no-op.
7. A Firestore trigger sends the ticket email exactly once, with a QR entry code.

One situation is worth knowing about:


**Payment completes just after the hold lapsed and the seats are still free.**
They are reclaimed and the booking confirms normally.

The opposite case, money arriving for seats that have gone, is prevented at the
gateway rather than cleaned up afterwards. The Cashfree order is created with an
expiry that tracks the seat hold, plus a minute so an attempt already under way
can finish. Cashfree blocks any attempt started after that, and reverses any
delayed confirmation the bank sends later. So there is no refund flow to run and
nothing for PFA to chase.

If it somehow happened anyway, the seat is never double sold: the booking is
marked `paid_unfulfilled`, the organiser is emailed, and the donor is told their
payment did not complete in time. That is a safety net, not a routine path.

---

## Looking before you build

Two preview files run with sample data and no Firebase at all, so you can walk
both journeys straight away:

- `seat-booking-preview.html` is what a donor sees, including a simulated gateway
  where you choose whether the payment succeeds or fails.
- `seat-admin-preview.html` is what an organiser sees.

Neither should be deployed. Delete them once you are happy, or add both to the
ignore list in `firebase.json`.

## Setup

### 1. Firebase project

```bash
npm install -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc      # then put your project id in it
```

In the Firebase console:

- **Firestore Database** → create in **Native mode**, location `asia-south1`.
- **Authentication** → Sign-in method → enable **Anonymous**. The page will not
  work without this, every booking session needs a uid.
- Upgrade to the **Blaze** plan. Cloud Functions need it to make outbound calls
  to Cashfree. Traffic at this scale costs close to nothing.

### 2. Cashfree keys

From the Cashfree merchant dashboard, Developers → API Keys, take the App ID and
Secret Key. Use the sandbox pair first.

```bash
firebase functions:secrets:set CASHFREE_APP_ID
firebase functions:secrets:set CASHFREE_SECRET_KEY
firebase functions:secrets:set SMTP_PASS
```

### 3. Non secret config

```bash
cp functions/.env.example functions/.env
```

Fill in `CASHFREE_MODE`, `PUBLIC_BASE_URL`, and the SMTP and mail values. Any
SMTP provider works: Google Workspace, Zoho, Amazon SES, Brevo.

### 4. Deploy

```bash
cd functions && npm install && cd ..
firebase deploy --only firestore:rules,firestore:indexes,functions
```

Take the deployed URL for `cashfreeWebhook` from the output, then:

- put it in `functions/.env` as `WEBHOOK_URL`
- register the same URL in the Cashfree dashboard under **Developers → Webhooks**,
  subscribed to `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK` and
  `PAYMENT_USER_DROPPED_WEBHOOK`
- redeploy functions once so the value takes effect

### 5. Seed the event

```bash
npm install firebase-admin
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
node scripts/seed-event.js
```

This is only needed once, to create the event. After that the room and the
prices are edited from the seat desk under **Event setup**, and this file is not
touched again.

The starting room is eight rows front to back, `3, 3, 4, 4, 5, 5, 5, 5`, thirty
four seats at Rs 399 each. Row A is nearest the mic. Rows may be any width and
any price; the map centres each one, so a narrow front row sits under the middle
of a wide back row. Re-running is safe: seats already sold or on
hold are left alone.

After a round of test bookings, reopen the whole map with:

```bash
node scripts/seed-event.js --reset
```

That clears every seat back to available and strips any leftover hold, so the
map starts as a clean full house. It refuses to run if the event already has
confirmed paid bookings, since that would free seats people have paid for. Add
`--force` only if you are certain.

### 6. Front end

Open `public/seat-booking.html` and fill in `FIREBASE_CONFIG` from Project
settings → Your apps → Web app. Check that `EVENT_ID` matches the seed script.

The page is a single self contained file, so it drops straight into the existing
flat PFA site next to `index.html` and `membership.html`. Put the show still at
`media/seat-booking-hero.jpg`; if it is missing the page falls back to a plain
stage panel rather than showing a broken image.

---

## Edge cases, and what happens in each

| Situation | What happens |
| --- | --- |
| Two people tap the same seat at the same instant | One transaction wins, the other is told which seat went. Never both. |
| Someone tries a seat while another person is paying | Refused for the full 300 seconds. The seat is exclusively theirs. |
| The 300 seconds run out mid payment | The Cashfree order expires with the hold, so the attempt is refused and no money moves. |
| Payment succeeds, webhook is slow | The browser also asks. Whichever arrives first confirms, the other is a no op. |
| Cashfree sends the same webhook twice | Idempotent. The seat is booked once. |
| Payment fails or is abandoned | Seats back on sale immediately. Nothing charged. |
| Browser closed straight after paying | The webhook still confirms it and the ticket email still goes out. |
| Webhook **and** browser both fail | `reconcilePayments` asks Cashfree every 15 minutes, for seven days back, and settles anything that paid. |
| Bank debits but the gateway records a failure | Cashfree never saw a payment, so the seat is correctly released. The bank reverses the debit itself, usually within a few working days. The page says so rather than claiming nothing was charged. |
| The amount does not match the order | Refused, flagged, seats withheld. Nobody gets seats for less than the order. |
| Ticket email bounces or SMTP is down | The send is retried by the reconciler. The person can still be found by name at the door. |
| Two organisers book the same seat offline at once | Same transaction as the public flow. One wins. |
| Someone edits the room while seats are sold | Refused, naming the seats. Sold and held seats can never be removed by a layout change. |
| A row is repriced after people have booked | Existing bookings keep the amount they were made at. Only future bookings use the new price. |
| Someone forwards their ticket to a friend | Assigned seating catches it: the second person is claiming an occupied seat. |

Two things remain judgement calls rather than guarantees:

- **Repeat holds from fresh browsers.** Each anonymous session may hold twice at
  once, but a new incognito window is a new session. On a 35 seat room this would
  be obvious and short lived, since every hold dies in 300 seconds.
- **A wrong email address.** The donor never gets their ticket. They still appear
  on the door list by name and phone, and the confirmation on screen shows the
  reference, so ask people to screenshot it.

---

## The seat desk

`seat-admin.html` is the organiser view. It answers who booked what and
when, and covers the two things a fundraiser needs that a database view cannot:
cash and comp bookings, and holding seats back.

Grant yourself access:

1. Firebase console, Authentication, Users, Add user, with an email and password.
2. Then:

```bash
node scripts/grant-admin.js you@peopleforanimals.org
node scripts/grant-admin.js --list          # see who has access
node scripts/grant-admin.js someone --revoke
```

Access is one claim, `admin: true`. There are no sub roles by design. Anyone you
trust on the door is already trusted with the booking list, and a permissions
matrix for one evening is more to get wrong than to gain.

What it does:

- **The three seat states** across the top, plus the money raised. Nothing else
  earns a place on the strip.
- **Bookings table** with name, email, phone, seats, amount, and the time booked.
  Search by name, phone, reference or seat, and sort by any column.
- **Offline booking** for cash at the door, a sponsor, a comp, or crew seats.
  Locks the seats through the same transaction as an online booking, so it cannot
  double sell, and emails the same ticket if you give an address. Comps are
  recorded at zero and still occupy their seats.
- **Event setup**: the room and the price, changed from the seat desk without a
  developer. One price field covers the whole room; add or remove rows and set
  how many seats each holds; edit the title, venue, date, time, directions link
  and the per booking limit. Save and the booking page follows immediately, with
  no code change and no redeploy. If a show ever needs a premium front row,
  tick **Charge different prices by row** and a price appears against each row.
- **Close sales** at any time, or mark the show sold out.

**Reminder emails** go out automatically at 9am India time, once the day before
the show and once on the morning of it, to everyone holding a paid booking with
an email address. Each is claimed on the booking before it is sent, so a retry
or an overlapping run cannot mail the same person twice, and a send that fails
hands its claim back so the next day's run picks it up. Nothing goes out once
the show has started.

Both the reminders and the countdown on the booking page work from the event's
**actual start time**, set in Event setup. The date and time on the page are
only labels and cannot be computed from, so an event without a real start time
simply gets no countdown and no reminders, and says so in the logs.

Seats have three states and no more: **available**, **on hold** for 300 seconds,
and **booked**. Each seat also carries its own price, so rows can be priced
differently, and the amount charged is summed from the seat documents inside the
same transaction that locks them. Nothing a browser sends can influence it. Keeping seats back for crew or press is a comp booking in their
name, which costs nothing, takes the seats off sale, and shows up in the booking
list so nobody forgets those seats are spoken for.

Personal details are never readable from the browser. Even organisers get them
through a function call, so every access to a donor's contact details is a
server side event rather than an open door.

What it deliberately does not have: charts, activity feeds, role hierarchies, or
a multi event switcher. For one show they would be work to build, work to learn,
and nothing to show for it.

---

## How to know it is working

Three stages, cheapest first. Each stage only makes sense once the one before it
passes.

**Stage 1, on your machine, no Firebase project, no money.**

```bash
node tests/integration.test.js
```

Eighty assertions drive the real backend code through every journey in memory.
Then open the two preview pages in a browser and walk both journeys by hand.
This proves the logic. It cannot prove the wiring.

**Stage 2, deployed, sandbox money.**

Cashfree's sandbox test credentials, which map onto exactly the cases this
system handles:

| To test | Use |
| --- | --- |
| Payment succeeds, seats book | UPI VPA `testsuccess@gocash` |
| Payment fails, seats go back on sale | UPI VPA `testfailure@gocash` |
| Invalid payment details | UPI VPA `testinvalid@gocash` |
| Card payment | 4706131211212123, expiry 03/2028, CVV 123, name Test |
| Card OTP screen | 111000 |
| Net banking | the bank listed as TEST Bank |

Abandoning the checkout, or leaving it until the 5 minutes lapse, needs no
special credentials: close the modal and watch the seats come back.

PayPal and bank transfer do not exist in the sandbox, so their absence from the
payment options is expected and not a fault in the integration.


Deploy with `CASHFREE_MODE=sandbox` and use Cashfree's test cards and test UPI
ids. No real money exists in sandbox, so pay, fail, abandon and time out as many
times as you like. Walk the numbered checklist below. This proves the wiring:
your Firebase project, your webhook URL, your SMTP account, your keys.

Between rounds, wipe the test data completely:

```bash
node scripts/seed-event.js --reset --force --purge
```

That reopens every seat and deletes the sandbox bookings and their webhook
records, so each round starts from nothing. Never run `--purge` on a live event.

**Stage 3, production, one real booking of your own.**

Switch to production keys, register the production webhook, then book one seat
yourself with a real Rs 399. Check the money reaches the PFA Cashfree account,
the ticket lands in your inbox, and the seat shows sold. That is the only test
that proves the production pipeline, and it is the last thing to do before
sharing the link.

Then clean up after yourself, in two steps that are deliberately separate:

```bash
node scripts/release-booking.js <bookingId> --reason "production smoke test"
```

frees the seat, and the script then tells you to refund the Rs 399 from the
Cashfree dashboard by hand (Orders, find it, Refund). The seat and the money are
two different systems, and only one of them belongs to this codebase.

### Why there is no release-and-refund button

Releasing a seat and moving money back are different risk classes. A seat state
is ours and reversible; a refund is real money leaving the PFA account, with its
own failure modes, partial states and webhook events. Wiring the two to one
button means one mistap during a busy evening does both, and it reintroduces
cancellation into an event that has none. The one legitimate need, cleaning up
after a smoke test, happens a handful of times, from a terminal, by someone
holding the service account key, with a confirmation prompt. That is what
`release-booking.js` is. Refunds stay in the Cashfree dashboard where they are
logged, reviewed and reversible by the people who own the money.

## Running the test suite

The backend ships with its own integration suite. It loads the real
`functions/index.js` with Firestore, SMTP and the Cashfree API replaced by in
memory stubs, then drives complete journeys through the deployed entry points:
booking to webhook to ticket email, failed payments, forged webhook signatures,
replayed deliveries, underpayment, a downed gateway, the reconciler recovering a
lost payment, and the admin surface. Eighty assertions, no network, no Firebase
project needed.

```bash
node tests/integration.test.js
```

Run it after any change to the functions. A change that breaks a journey fails
here before it can fail in front of a donor.

## Testing before you go live

Keep `CASHFREE_MODE=sandbox` and use the Cashfree test cards and test UPI ids.

Worth walking through by hand:

1. Book, pay, and check the email arrives with a scannable QR.
1b. Fail a payment deliberately and confirm the seats are back on sale at once,
    without waiting for the sweeper.
1c. Start a checkout, leave it for six minutes, then try to pay. Cashfree should
    refuse the attempt because the order has expired with the hold.
2. Book and then wait out the 5 minutes without paying. The seats should return
   to available within a minute of expiry and the page should say so.
3. Open the page in two browsers, hold the same seat in both. The second should
   be told the seat was just taken.
4. Book, and close the payment modal without paying. You should be able to retry
   while the timer is still running.
5. Post a webhook with a wrong signature and confirm it is rejected with a 401.
6. Run `node scripts/door-list.js` and check the CSV.
7. Sign in to `seat-admin.html` and add a cash booking.
8. Sign in with an account that has no organiser claim and confirm it is refused.

Switch `CASHFREE_MODE` to `production`, swap in the live keys, register the
production webhook, and redeploy.

---

## At the door

There is nothing to enter into the system on the night. The ticket email shows
the reference in large type with the seat numbers beside it, and the QR code
reads back as that same reference on any phone camera. Someone checks the
reference against the printed list and lets people in.

Print the list on the day:

```bash
node scripts/door-list.js > door-list.csv
```

Assigned seating does most of the work here. If a ticket were forwarded or
screenshotted twice, the second person would be claiming a seat that is already
occupied, which surfaces at the seat rather than at the entrance.

## Operating the event

- `seat-admin.html` is the day to day view. Firestore is the fallback.
- Close sales and take cash, comp or crew bookings from the seat desk.
- Tap free seats on the map to select them, then Add offline booking.
- `webhookEvents` keeps every raw gateway callback, which makes any payment
  dispute easy to settle.
- There are no cancellations. Once a seat is paid for it stays paid for, and
  nothing in the seat desk can release it. Refunds, if PFA ever chooses to give
  one, are a human decision made in the Cashfree dashboard.

---

## Cost

At the scale of a single fundraiser this sits inside the Firebase free
allowances, with the Blaze plan there only to permit outbound calls. The two
things that scale with traffic are Firestore reads on the live seat map and
function invocations, both of which are a few thousand at most for an event of
this size.
