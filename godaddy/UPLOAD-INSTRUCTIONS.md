# Putting the booking page on GoDaddy

What you are uploading: one folder called `book`, containing `index.html`
(the whole booking page) and a `media` folder for the show still. The page is
self contained; the backend stays on Firebase and is reached over HTTPS from
the visitor's browser, so GoDaddy needs nothing beyond ordinary web hosting.

## 1. Upload

GoDaddy dashboard, your hosting plan, cPanel, File Manager. Open `public_html`
and upload the `book` folder (File Manager can also extract a zip in place).
The page is then live at:

    https://YOUR-DOMAIN/book/

Visit it. You should see the event header; the seat map will error until step 2
is done, which is expected.

## 2. Point the backend at this URL (two minutes, once)

In the repo, open `functions/.env` and set:

    PUBLIC_BASE_URL=https://YOUR-DOMAIN/book/

with your real domain, then:

    firebase deploy --only functions

This is the address Cashfree sends people back to after payment. If it still
points at pfa-events.web.app, anyone returning from a full page redirect lands
on the wrong copy of the page.

## 3. Authorize the domain in Firebase (one minute, once)

Firebase console, Authentication, Settings, Authorized domains, Add domain,
enter YOUR-DOMAIN. Sign in and payments then work from the GoDaddy address
without the browser being treated as an unknown origin.

## 4. Check

Load https://YOUR-DOMAIN/book/ again: 34 open seats, live map, and a sandbox
test booking end to end. Only then swap to production keys per the runbook.

## Two deliberate omissions

- `seat-admin.html` is not in this folder. Keep the seat desk at
  https://pfa-events.web.app/seat-admin.html rather than on the public domain;
  it is protected by sign in either way, but there is no reason to advertise
  its existence on the event URL people share.
- The two preview files stay out of every deployment. They contain sample data
  and no auth.

## HTTPS

The page must be served over https. GoDaddy issues a free certificate on most
hosting plans (cPanel, SSL/TLS Status); switch it on if the padlock is missing,
because Cashfree's checkout will not open from an http page.
