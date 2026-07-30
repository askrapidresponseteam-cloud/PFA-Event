"use strict";

/**
 * Transactional email for seat bookings.
 *
 * Uses plain SMTP through nodemailer so it works with whatever the charity
 * already has (Google Workspace, Zoho, Amazon SES, Brevo and so on). Swap the
 * transport here if you move to an API based provider later.
 *
 * Layout is table based with inline styles, which is what email clients need.
 */

const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

let cachedTransport = null;

function transport(cfg) {
  if (cachedTransport) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port || 587),
    secure: Number(cfg.port) === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 3
  });
  return cachedTransport;
}

const INK = "#010103";
const PANEL = "#12161C";
const LINE = "rgba(255,255,255,0.12)";
const TEXT = "#F4F6F7";
const MUTED = "#9AA4AD";
const FAINT = "#7A848D";
const BLUE = "#00A4FF";
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

const inr = (n) => "\u20B9" + Number(n || 0).toLocaleString("en-IN");

function factRow(key, value) {
  return `
  <tr>
    <td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.08);font:400 11px/1.4 ${FONT};letter-spacing:.22em;text-transform:uppercase;color:${FAINT};white-space:nowrap;">${key}</td>
    <td style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.08);font:700 14px/1.4 ${FONT};color:${TEXT};text-align:right;">${value}</td>
  </tr>`;
}

function shell(inner) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${INK};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${INK};border:1px solid ${LINE};">
        <tr>
          <td style="padding:20px 28px;border-bottom:1px solid ${LINE};">
            <span style="font:700 13px/1 ${FONT};letter-spacing:.22em;text-transform:uppercase;color:${TEXT};">People for Animals</span>
          </td>
        </tr>
        ${inner}
        <tr>
          <td style="padding:22px 28px;border-top:1px solid ${LINE};">
            <p style="margin:0;font:400 11px/1.6 ${FONT};letter-spacing:.2em;text-transform:uppercase;color:${MUTED};">People for Animals</p>
            <p style="margin:6px 0 0;font:400 12px/1.6 ${FONT};color:${FAINT};">Come for the laughs &middot; Stay for the cause &middot; Make a difference</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Ticket email sent the moment payment is confirmed. */
/* -----------------------------------------------------------------------------
   The ticket email.

   Built to look like the ticket design rather than a compromise of it. The
   approach is progressive enhancement, not lowest common denominator:

     - every gradient is declared as background-color first, then
       background-image, so Gmail and Apple Mail draw the gradient and Outlook
       quietly draws the solid colour underneath it
     - border-radius, box-shadow and the pill are honoured by Gmail, Apple Mail,
       iOS, Android and Outlook.com, and ignored without damage by Outlook on
       Windows, which squares the corners and moves on
     - the two things that genuinely cannot survive are the float animation and
       the shimmering gradient text, so the ticket number is solid blue

   Layout is still tables, because Outlook's Word engine cannot lay out with
   flexbox and that part is not negotiable.
   ----------------------------------------------------------------------------- */

const TK_INK   = "#07080A";
const TK_CARD  = "#111720";
const TK_TEXT  = "#F2F4F6";
const TK_MUTE  = "#6E7681";
const TK_DIM   = "#9CA3AE";
const TK_BLUE  = "#4FC3FF";
const TK_SKY   = "#9AD9FF";
const SANS     = "'Archivo',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO     = "'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace";

/** Seats per row, front to back, tolerating every shape an event may carry. */
function ticketRowPlan(event) {
  const base = Number(event && event.seatPrice) || 0;
  if (Array.isArray(event && event.rows) && event.rows.length) {
    return event.rows.map((r) => typeof r === "number"
      ? { seats: r, price: base }
      : { seats: Number(r.seats) || 0, price: Number(r.price != null ? r.price : base) || 0 });
  }
  return Array.from({ length: (event && event.rowCount) || 0 },
    () => ({ seats: (event && event.seatsPerRow) || 0, price: base }));
}

/**
 * A miniature of the real room with this booking's seats lit.
 *
 * One table per row so the rows centre under each other exactly as they do on
 * the booking page, which is what makes a narrow front row read as the front.
 */
function ticketSeatMap(event, mine) {
  const plan = ticketRowPlan(event);
  if (!plan.length) return "";
  const owned = new Set(mine);

  const rows = plan.map((row, r) => {
    const label = String.fromCharCode(65 + r);
    let cells = "";
    for (let n = 1; n <= row.seats; n++) {
      const isMine = owned.has(label + n);
      cells +=
        `<td style="padding:0 2px;line-height:0;font-size:0">` +
        `<div style="width:12px;height:10px;font-size:0;line-height:0;border-radius:2px;` +
        (isMine
          ? `background:${TK_BLUE};box-shadow:0 0 8px 1px rgba(79,195,255,0.55)`
          : `background:#232A34`) +
        `">&nbsp;</div></td>`;
    }
    return `<tr><td align="center" style="padding:2px 0">` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>${cells}</tr></table>` +
      `</td></tr>`;
  }).join("");

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="left">
      <tr><td align="center" style="padding-bottom:5px">
        <div style="height:4px;width:110px;border-radius:2px;background-color:#2E6F92;background-image:linear-gradient(90deg,rgba(79,195,255,0.15),rgba(79,195,255,0.85),rgba(79,195,255,0.15));font-size:0;line-height:0">&nbsp;</div>
      </td></tr>
      <tr><td align="center" style="padding-bottom:8px;font:400 8px/1 ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:#4F5964">Stage</td></tr>
      <tr><td align="center"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">${rows}</table></td></tr>
    </table>`;
}

/** "E · 3" for one, "E · 3, 4" within a row, "A1 · H5" across rows. */
function seatHeadline(seatIds) {
  const list = seatIds.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!list.length) return "";
  if (new Set(list.map((s) => s[0])).size === 1) {
    return list[0][0] + "&nbsp;&middot;&nbsp;" + list.map((s) => s.slice(1)).join(", ");
  }
  return list.join("&nbsp;&middot;&nbsp;");
}

async function sendTicket(cfg, data) {
  const { booking, contact, event, reference } = data;
  const seatIds = (booking.seats || []).slice().sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
  const count = seatIds.length;

  // Just the reference. Nothing scans this into a system, so a phone camera
  // shows the door person the same code that is on their list.
  const qrBuffer = await QRCode.toBuffer(reference, {
    width: 460, margin: 1, color: { dark: "#07080A", light: "#F2F4F6" }
  });

  const seatNote = count === 1 ? "Reserved in your name"
                               : count + " seats reserved in your name";
  const performers = event.performers ||
    "Ravi Khurana &middot; Appurv Gupta &middot; Gourav Mahna";

  // A label with its value beneath, used for date, time and venue.
  const field = (label, value, pad) => `
    <td valign="top" style="${pad || ""}">
      <div style="font:400 8.5px/1 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${TK_MUTE}">${label}</div>
      <div style="margin-top:7px;font:400 13.5px/1.35 ${SANS};color:${TK_TEXT}">${value}</div>
    </td>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Your ticket ${escapeHtml(reference)}</title>
<style>
  @media only screen and (max-width:620px){
    .tkhalf{display:block!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important}
    .tkperf{display:none!important}
    .tkstub{border-top:1px dashed rgba(255,255,255,0.30)!important;border-radius:0 0 20px 20px!important}
    .tkmain{border-radius:20px 20px 0 0!important}
    .tkpad{padding:26px 22px!important}
    .tktitle{font-size:26px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${TK_INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Booking confirmed. ${escapeHtml(seatIds.join(", "))}. Reference ${escapeHtml(reference)}.</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:${TK_INK};background-image:radial-gradient(900px 520px at 50% -8%,#12212E 0%,${TK_INK} 62%);">
  <tr><td align="center" style="padding:38px 12px 40px">

    <!-- above the ticket -->
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
      <tr><td align="center" style="font:500 10.5px/1 ${SANS};letter-spacing:2.8px;text-transform:uppercase;color:${TK_MUTE}">You&rsquo;re in &middot; booking confirmed</td></tr>
      <tr><td align="center" style="padding-top:11px;font:600 25px/1.2 ${SANS};letter-spacing:-0.5px;color:${TK_TEXT}">Your ${count === 1 ? "seat is" : "seats are"} saved.</td></tr>
    </table>

    <!-- the ticket -->
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
           style="width:600px;max-width:600px;margin-top:26px;border-radius:20px;
                  background-color:${TK_CARD};
                  background-image:linear-gradient(155deg,#151A21 0%,#0E1319 52%,#141B24 100%);
                  box-shadow:0 40px 70px -34px rgba(0,0,0,0.9),0 0 0 1px rgba(255,255,255,0.09);">
      <tr>
        <!-- main half -->
        <td class="tkhalf tkmain tkpad" width="382" valign="top"
            style="width:382px;padding:30px 26px 28px 30px;font-family:${SANS};color:${TK_TEXT};border-radius:20px 0 0 20px">

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td valign="middle" width="46" style="padding-right:12px">
                <img src="cid:pfalogo" width="42" height="42" alt=""
                     style="display:block;width:42px;height:42px;border:0">
              </td>
              <td valign="middle">
                <div style="font:500 11px/1.3 ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:${TK_TEXT}">People for Animals</div>
                <div style="margin-top:4px;font:400 9px/1.3 ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:${TK_MUTE}">A comedy fundraiser</div>
              </td>
              <td valign="middle" align="right">
                <div style="display:inline-block;padding:7px 13px;border-radius:100px;background-color:#0C2C42;font:600 9px/1 ${SANS};letter-spacing:1.8px;text-transform:uppercase;color:${TK_SKY};white-space:nowrap">Admit ${count === 1 ? "one" : count}</div>
              </td>
            </tr>
          </table>

          <div class="tktitle" style="margin-top:26px;font:600 31px/1.06 ${SANS};letter-spacing:-1.1px;color:${TK_TEXT}">${escapeHtml(event.title || "Stand up for a better world.")}</div>
          <div style="margin-top:12px;font:400 12px/1.6 ${SANS};color:${TK_DIM}">${performers}</div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px">
            <tr>
              ${field("Date", escapeHtml(event.dateLabel || ""), "width:52%;padding-right:12px")}
              ${field("Time", escapeHtml(event.timeLabel || ""), "")}
            </tr>
            <tr><td colspan="2" style="height:18px;font-size:0;line-height:0">&nbsp;</td></tr>
            <tr>${field("Venue", escapeHtml(event.venue || ""), "")}<td></td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px">
            <tr>
              <td valign="bottom" width="150">
                <div style="font:400 8.5px/1 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${TK_MUTE};padding-bottom:10px">Where you are sitting</div>
                ${ticketSeatMap(event, seatIds)}
              </td>
              <td valign="bottom" align="right">
                <div style="font:400 8.5px/1 ${SANS};letter-spacing:2px;text-transform:uppercase;color:${TK_MUTE}">Row / Seat</div>
                <div style="margin-top:8px;font-family:${MONO};font-weight:700;font-size:29px;line-height:1.05;letter-spacing:-0.3px;color:${TK_TEXT}">${seatHeadline(seatIds)}</div>
                <div style="margin-top:6px;font:400 11px/1.4 ${SANS};color:${TK_MUTE}">${seatNote}</div>
              </td>
            </tr>
          </table>
        </td>

        <!-- perforation -->
        <td class="tkperf" width="2" valign="top" style="width:2px;padding:0;font-size:0;line-height:0">
          <div style="width:2px;height:14px;background-color:${TK_INK};border-radius:0 0 6px 6px;font-size:0;line-height:0">&nbsp;</div>
          <div style="width:0;height:330px;border-left:2px dashed rgba(255,255,255,0.26);font-size:0;line-height:0">&nbsp;</div>
          <div style="width:2px;height:14px;background-color:${TK_INK};border-radius:6px 6px 0 0;font-size:0;line-height:0">&nbsp;</div>
        </td>

        <!-- stub -->
        <td class="tkhalf tkstub tkpad" width="216" valign="top" align="center"
            style="width:216px;padding:30px 20px 26px;text-align:center;font-family:${SANS};border-radius:0 20px 20px 0;
                   background-color:#0F1620;
                   background-image:linear-gradient(180deg,rgba(0,164,255,0.13) 0%,rgba(0,164,255,0.03) 42%,rgba(255,255,255,0.02) 100%);">

          <div style="font:400 8.5px/1 ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:${TK_MUTE}">Ticket no.</div>
          <div style="margin-top:10px;font-family:${MONO};font-weight:700;font-size:15px;letter-spacing:1.2px;color:${TK_SKY}">${escapeHtml(reference)}</div>

          <div style="margin-top:20px">
            <img src="cid:pfaticketqr" width="124" height="124" alt="Entry code ${escapeHtml(reference)}"
                 style="display:block;margin:0 auto;width:124px;height:124px;border:10px solid #F2F4F6;border-radius:12px;background:#F2F4F6">
          </div>
          <div style="margin-top:12px;font:400 10px/1.55 ${SANS};color:${TK_MUTE}">Scan at the door.<br>Carry a government ID.</div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px">
            <tr><td align="center" style="border-top:1px solid rgba(255,255,255,0.09);padding-top:15px">
              <div style="font:400 8.5px/1 ${SANS};letter-spacing:2.2px;text-transform:uppercase;color:${TK_MUTE}">Contribution</div>
              <div style="margin-top:7px;font:500 23px/1 ${SANS};color:${TK_BLUE}">${inr(booking.amount)}</div>
              <div style="margin-top:6px;font:400 10px/1.4 ${SANS};color:${TK_MUTE}">100% to animal welfare</div>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- below the ticket -->
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
      <tr><td align="center" style="padding-top:24px;font:300 13px/1.6 ${SANS};color:${TK_DIM}">This ticket is one animal&rsquo;s better day. Thank you.</td></tr>
      <tr><td align="center" style="padding-top:7px;font:400 12px/1.4 ${SANS};letter-spacing:1.2px;color:${TK_BLUE}">${escapeHtml(cfg.siteLabel || "peopleforanimalsindia.org/events")}</td></tr>
    </table>

  </td></tr>
</table>
</body></html>`;

  return transport(cfg).sendMail({
    from: cfg.from,
    to: contact.email,
    bcc: cfg.bcc || undefined,
    replyTo: cfg.replyTo || cfg.from,
    subject: `Your ticket: ${event.title || "PFA fundraiser"} (${reference})`,
    text: [
      `${event.title || "PFA fundraiser"}`,
      `${event.dateLabel || ""}, ${event.timeLabel || ""}`,
      `${event.venue || ""}`,
      ``,
      `Ticket no. ${reference}`,
      `Seat${count === 1 ? "" : "s"}: ${seatIds.join(", ")}`,
      `Contribution: ${inr(booking.amount)}`,
      ``,
      `Show this reference at the door. Please arrive fifteen minutes early and carry a valid Indian government ID.`
    ].join("\n"),
    html,
    attachments: [
      { filename: `pfa-ticket-${reference}.png`, content: qrBuffer, cid: "pfaticketqr" },
      ...(cfg.logo ? [{ filename: "pfa-logo.png", content: cfg.logo, cid: "pfalogo" }] : [])
    ]
  });
}

/** Sent only if a payment somehow lands after the seats have gone. */
async function sendUnfulfilledNotice(cfg, data) {
  const { booking, contact, event, reference } = data;

  const inner = `
  <tr>
    <td style="padding:34px 28px 30px;">
      <p style="margin:0;font:400 12px/1 ${FONT};letter-spacing:.26em;text-transform:uppercase;color:#FF7A70;">We could not seat you</p>
      <h1 style="margin:16px 0 0;font:800 26px/1.15 ${FONT};letter-spacing:-.02em;color:${TEXT};">Your payment did not complete in time</h1>
      <p style="margin:14px 0 0;font:400 15px/1.7 ${FONT};color:${MUTED};">
        ${escapeHtml(firstName(contact.name))}, your seats were released before the payment came through, and someone else has taken them. We are sorry, this is our fault and not yours.
      </p>
      <p style="margin:14px 0 0;font:400 15px/1.7 ${FONT};color:${MUTED};">
        Nothing should have left your account. If ${inr(booking.amount)} was debited, the bank reverses it automatically, usually within a few working days. Your reference is <strong style="color:${TEXT};">${escapeHtml(reference)}</strong>.
      </p>
      <p style="margin:14px 0 0;font:400 15px/1.7 ${FONT};color:${MUTED};">
        If there are still seats open for ${escapeHtml(event.dateLabel || "the show")}, we would love to have you. Reply to this email and we will book you in directly.
      </p>
    </td>
  </tr>`;

  return transport(cfg).sendMail({
    from: cfg.from,
    to: contact.email,
    bcc: cfg.bcc || undefined,
    replyTo: cfg.replyTo || cfg.from,
    subject: `We could not seat you (${reference})`,
    text: `Your seats were released before the payment completed, and have since been taken. Nothing should have left your account, and any debit is reversed automatically. Reference ${reference}. Reply to this email and we will book you in directly if seats remain.`,
    html: shell(inner)
  });
}

/** Short internal note so the organisers see bookings as they land. */
async function sendOrganiserAlert(cfg, data) {
  if (!cfg.organiser) return null;
  const { booking, contact, reference, kind } = data;
  const seats = booking.seats.slice().sort();

  return transport(cfg).sendMail({
    from: cfg.from,
    to: cfg.organiser,
    subject:
      (kind === "unfulfilled" ? "ACTION: paid but not seated " : "New booking ") +
      reference +
      " (" + seats.length + " seat" + (seats.length > 1 ? "s" : "") + ")",
    text: [
      "Reference: " + reference,
      "Status: " + booking.status,
      "Seats: " + seats.join(", "),
      "Amount: " + inr(booking.amount),
      "Name: " + contact.name,
      "Email: " + contact.email,
      "Phone: " + contact.phone,
      kind === "unfulfilled"
        ? "\nPayment landed after the seats had gone. The gateway reverses it, but call them."
        : ""
    ].join("\n")
  });
}

function firstName(name) {
  return String(name || "friend").trim().split(/\s+/)[0];
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/**
 * Reminder before the show. kind is "tomorrow" or "today".
 *
 * Deliberately short. Someone reading this on the way to the venue wants the
 * reference, the seats and the address, not prose.
 */
async function sendReminder(cfg, data) {
  const { booking, contact, event, reference, kind } = data;
  const seatList = (booking.seats || []).slice().sort().join(", ");
  const when = kind === "today" ? "Today" : "Tomorrow";
  const lead = kind === "today"
    ? "Tonight is the night. Here is everything you need at the door."
    : "Your seats are booked for tomorrow. Here is everything you need at the door.";

  const dirBtn = event.mapsUrl
    ? `<tr><td style="padding-top:22px">
         <a href="${escapeHtml(event.mapsUrl)}" style="display:inline-block;background:${BLUE};color:#0E1116;font:700 13px/1 ${FONT};letter-spacing:.14em;text-transform:uppercase;padding:14px 22px;text-decoration:none">Directions to the venue</a>
       </td></tr>`
    : "";

  return transport(cfg).sendMail({
    from: cfg.from,
    to: contact.email,
    replyTo: cfg.replyTo || cfg.from,
    subject: `${when}: ${event.title || "PFA fundraiser"} (${reference})`,
    text:
      `${when}. ${event.venue || ""}, ${event.timeLabel || ""}. ` +
      `Reference ${reference}. Seats ${seatList}. ` +
      `Please arrive fifteen minutes early and carry a valid Indian government ID.`,
    html: shell(`
      <p style="margin:0;font:400 12px/1 ${FONT};letter-spacing:.26em;text-transform:uppercase;color:${BLUE};">${when}</p>
      <h1 style="margin:16px 0 0;font:800 26px/1.15 ${FONT};letter-spacing:-.02em;color:${TEXT};">${escapeHtml(event.title || "PFA fundraiser")}</h1>
      <p style="margin:14px 0 0;font:400 15px/1.7 ${FONT};color:${MUTED};">
        ${escapeHtml(firstName(contact.name))}, ${lead}
      </p>

      <table role="presentation" width="100%" style="margin-top:26px;border-collapse:collapse">
        <tr><td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);font:400 11px/1 ${FONT};letter-spacing:.22em;text-transform:uppercase;color:${MUTED}">Reference</td>
            <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);text-align:right;font:800 20px/1 ${FONT};color:${TEXT}">${escapeHtml(reference)}</td></tr>
        <tr><td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);font:400 11px/1 ${FONT};letter-spacing:.22em;text-transform:uppercase;color:${MUTED}">Seats</td>
            <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);text-align:right;font:700 15px/1 ${FONT};color:${TEXT}">${escapeHtml(seatList)}</td></tr>
        <tr><td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);font:400 11px/1 ${FONT};letter-spacing:.22em;text-transform:uppercase;color:${MUTED}">Venue</td>
            <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);text-align:right;font:700 15px/1 ${FONT};color:${TEXT}">${escapeHtml(event.venue || "")}</td></tr>
        <tr><td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);font:400 11px/1 ${FONT};letter-spacing:.22em;text-transform:uppercase;color:${MUTED}">Time</td>
            <td style="padding:14px 0;border-top:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);text-align:right;font:700 15px/1 ${FONT};color:${TEXT}">${escapeHtml(event.timeLabel || "")}</td></tr>
        ${dirBtn}
      </table>

      <p style="margin:24px 0 0;font:400 14px/1.7 ${FONT};color:${MUTED};">
        Please arrive about fifteen minutes early, have this reference ready on your phone,
        and carry a valid Indian government ID.
      </p>`)
  });
}

module.exports = { sendTicket, sendUnfulfilledNotice, sendOrganiserAlert, sendReminder };
