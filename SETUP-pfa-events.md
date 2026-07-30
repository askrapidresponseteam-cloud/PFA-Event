# Backend setup for pfa-events

This runbook is keyed to your project: **pfa-events** (number 751693085778,
Blaze already active).

## The short way: two scripts

Almost all of this is automatable, so it has been automated:

```bash
bash scripts/setup.sh     # everything that has an API
# then set the Cashfree and SMTP secrets it asks for
bash scripts/deploy.sh    # tests, deploy, webhook URL round trip, seed
```

`setup.sh` enables the Cloud APIs, creates Firestore in asia-south1, registers
the web app and writes its config into both pages for you, turns on anonymous
sign in, downloads a service account key, and installs dependencies. `deploy.sh`
runs the test suite first and refuses to deploy if it fails, then deploys, reads
the webhook URL back out, writes it into `functions/.env`, redeploys only if it
changed, and seeds the event. Both are safe to run as many times as you like.

Three things genuinely cannot be done from a terminal, because no API exists
for them:

- **Cashfree API keys** (dashboard, Developers, API Keys)
- **Cashfree webhook registration** (dashboard, Developers, Webhooks)
- **Connecting a custom domain** (Firebase console, Hosting; section G)

Everything below is the same process done by hand, kept for reference and for
understanding what the scripts do.

---

## A. In the Firebase console (four things)

**A1. Register the web app.**
Project settings, General, Your apps, click the `</>` icon. Nickname it
`pfa-seat-booking`, do not tick Hosting here, Register. The console shows a
`firebaseConfig` object. Copy `apiKey`, `appId` and `storageBucket` from it into
the `FIREBASE_CONFIG` block near the top of BOTH `public/seat-booking.html` and
`public/seat-admin.html`. The other three values are already filled in.

**A2. Create the Firestore database.**
Build, Firestore Database, Create database. Choose **Native mode** and location
**asia-south1 (Mumbai)**. Start in production mode; the rules deploy from the
repo in step B4 anyway. The location cannot be changed later, so this is the one
click worth double checking.

**A3. Enable Anonymous sign in.**
Build, Authentication, Get started, Sign-in method, Anonymous, Enable, Save.
Every booking session needs this; the page shows an error without it.

**A4. Download a service account key** (for the seed and admin scripts).
Project settings, Service accounts, Generate new private key. Save the file as
`service-account.json` in the repo root. It is a password to your whole project:
never commit it, never upload it anywhere.

---

## B. In the terminal, from the repo root

```bash
# B1. Tools and sign in
npm install -g firebase-tools
firebase login
firebase use pfa-events          # .firebaserc already points here

# B2. Dependencies
cd functions && npm install && cd ..

# B3. The three secrets (you will be prompted for each value)
firebase functions:secrets:set CASHFREE_APP_ID       # sandbox App ID, step C1
firebase functions:secrets:set CASHFREE_SECRET_KEY   # sandbox secret, step C1
firebase functions:secrets:set SMTP_PASS             # the ticket mailbox password

# B4. Fill the blanks in functions/.env (SMTP_HOST, SMTP_USER, MAIL_FROM,
#     MAIL_ORGANISER), then deploy everything
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting
```

The first functions deploy asks to enable Cloud APIs (Scheduler, Build, Run).
Say yes; Blaze covers them and this event's usage stays inside free allowances.

**B5. Pin the webhook URL.** The deploy output lists `cashfreeWebhook` with its
URL. Paste that URL into `WEBHOOK_URL=` in `functions/.env`, then:

```bash
firebase deploy --only functions
```

**B6. Seed the event and grant yourself the seat desk:**

```bash
npm install firebase-admin
export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
node scripts/seed-event.js
node scripts/grant-admin.js you@yourmail.com
```

For the grant to work, that account must first exist under Authentication,
Users, Add user (email plus password).

---

## C. In the Cashfree merchant dashboard

**C1. Sandbox keys.** Developers, API Keys, Sandbox: copy the App ID and Secret
Key. These are the two values you set in B3.

**C2. Register the webhook.** Developers, Webhooks, Sandbox: add the exact
`WEBHOOK_URL` from B5, subscribed to `PAYMENT_SUCCESS_WEBHOOK`,
`PAYMENT_FAILED_WEBHOOK` and `PAYMENT_USER_DROPPED_WEBHOOK`. Cashfree sends a
test ping; it should show delivered.

---

## D. Prove it works

Open `https://pfa-events.web.app/seat-booking.html`. If you are hosting the
public page on GoDaddy instead, follow `godaddy/UPLOAD-INSTRUCTIONS.md` (upload
the `book` folder, set `PUBLIC_BASE_URL` to that URL, authorize the domain) and
use your domain's `/book/` address everywhere below. The Firebase hosted copy
still works as a fallback either way.

Open the page. You should see the event,
all 34 seats open. Book two seats with Cashfree's sandbox test UPI, watch them
confirm, and check the ticket email lands. Then run the full Stage 2 checklist
in the README ("How to know it is working"), and reset between rounds with:

```bash
node scripts/seed-event.js --reset --force --purge
```

The seat desk is at `https://pfa-events.web.app/seat-admin.html`.

---

## E. Going live, when the sandbox checklist is clean

1. In `functions/.env` set `CASHFREE_MODE=production`.
2. Overwrite both secrets with the production keys:
   `firebase functions:secrets:set CASHFREE_APP_ID` and
   `firebase functions:secrets:set CASHFREE_SECRET_KEY`.
3. Register the same webhook URL under Cashfree's **production** webhooks.
4. `firebase deploy --only functions`
5. Wipe the sandbox test data: `node scripts/seed-event.js --reset --force --purge`
6. One real booking of your own (Stage 3 in the README), then
   `node scripts/release-booking.js <bookingId> --reason "production smoke test"`
   and refund your Rs 399 from the Cashfree dashboard.

Then share the link.

---

## F. The ticket mailbox, step by step (Gmail)

The system emails each donor their ticket the moment payment confirms. It just
needs a mailbox to send from. Gmail is the quickest to set up:

1. Pick the Google account the tickets should come from. A dedicated one such as
   `pfa.events.tickets@gmail.com` reads better than a personal address, and a
   Workspace address on your own domain is better still if PFA has one.
2. On that account, turn on 2-Step Verification (myaccount.google.com, Security).
   App Passwords do not exist without it.
3. Still under Security, open **App passwords** (or go to
   myaccount.google.com/apppasswords). Create one named `pfa-seat-booking`.
   Google shows a 16 character password once. That is your `SMTP_PASS`.
4. Set the secret with it:

   ```bash
   firebase functions:secrets:set SMTP_PASS
   ```

5. In `functions/.env`, fill `SMTP_USER` with the Gmail address, put the same
   address inside `MAIL_FROM` (Gmail rewrites the From header to the signed in
   account, so a different address there is silently overridden), and set
   `MAIL_ORGANISER` to whichever inbox should see each booking as it lands.
6. `firebase deploy --only functions`

Then prove it: make a sandbox booking, pay with a test UPI id, and the ticket
should be in the inbox within seconds, QR and all. If it is not,
`firebase functions:log` shows the exact send error, and the reconciler retries
failed sends every 15 minutes on its own.

Numbers, for peace of mind: Gmail allows roughly 500 sends a day on a free
account and 2,000 on Workspace. This event needs at most a few dozen. If PFA
later runs bigger campaigns from the same mailbox, that is the point to move to
Zoho or Amazon SES, which is a two line change in `.env` plus a new password.

One thing NOT to do: never put the normal Gmail account password in SMTP_PASS.
It will not work with 2-Step Verification on, and it would hand your whole
inbox to anything that reads the secret. The App Password is scoped and
revocable from the same page you created it.

---

## G2. Changing the room or the prices later

You will not need this repo again for that. In the seat desk, click **Event
setup** on the seat map card. Add or remove rows, set the seats and the price
for each, edit the title, venue, date, time and directions link, then Save. The
booking page picks it up straight away.

Two things it will not let you do, on purpose: remove a seat that is sold or on
hold, and set a row price below Rs 1, since a payment gateway cannot process a
nil order. Free seats are given as a complimentary offline booking instead.

---

## G. Pointing the PFA domain at the site (when the GoDaddy login arrives)

Nothing moves and nothing re-uploads. The site stays on Firebase Hosting; the
domain simply starts answering for it. Links already shared with the
pfa-events.web.app address keep working for good.

1. Decide the address. A subdomain such as `book.YOUR-DOMAIN` is the clean
   choice: it leaves the main website untouched and needs only one DNS record.
2. Firebase console, Hosting, Add custom domain, type the subdomain. Firebase
   shows you one or two DNS records (a TXT to prove ownership, then an A or
   CNAME record for traffic).
3. GoDaddy dashboard, your domain, DNS, Manage records: add exactly those
   records. This is the only thing GoDaddy is needed for.
4. Wait for the console to show Connected. Firebase issues the HTTPS
   certificate itself; allow up to an hour, usually far less.
5. Tell the backend and auth about the new address:
   - `functions/.env`: `PUBLIC_BASE_URL=https://book.YOUR-DOMAIN/` then
     `firebase deploy --only functions`
   - Firebase console, Authentication, Settings, Authorized domains, add
     `book.YOUR-DOMAIN`
6. Share `https://book.YOUR-DOMAIN/` from then on. The root serves the booking
   page directly, so the shared link has no filename in it.

The GoDaddy upload package in `godaddy/` remains a fallback if PFA ever wants
the page on GoDaddy's own hosting instead, but with the domain connected this
way there is nothing to upload and only one copy of the site to maintain.

---

## If something misbehaves

- Page says it cannot start a booking session: A3 was skipped.
- Booking fails with "could not reach the payment gateway": check the two
  Cashfree secrets and that `CASHFREE_MODE` matches the keys (sandbox keys with
  sandbox mode).
- Payment succeeds but nothing confirms for a minute: the webhook URL in
  Cashfree does not match B5. The reconciler will still settle it within 15
  minutes; fix the URL for instant confirmation.
- No ticket email: the four SMTP values in `functions/.env` plus the SMTP_PASS
  secret. `firebase functions:log` shows the exact send error.
- Deploy warns "Cashfree rejected the short order expiry": your account enforces
  a minimum payment window and the code fell back to 20 minutes. Tell Claude;
  the hold length needs a matching adjustment.
