#!/usr/bin/env bash
#
# Deploy the PFA seat booking backend, and handle the one awkward part of the
# process automatically: the webhook URL is not known until functions have been
# deployed once, but functions need it in their environment. This script
# deploys, reads the URL back, writes it into functions/.env, and redeploys
# only if it actually changed.
#
#   bash scripts/deploy.sh
#
# Safe to run repeatedly. Run it after any code change.

set -uo pipefail

PROJECT="pfa-events"
REGION="asia-south1"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mok\033[0m    %s\n" "$1"; }
skip() { printf "  \033[90mskip\033[0m  %s\n" "$1"; }
warn() { printf "  \033[33mnote\033[0m  %s\n" "$1"; }
die()  { printf "  \033[31mstop\033[0m  %s\n\n" "$1"; exit 1; }

cd "$(dirname "$0")/.." || die "run this from inside the repo"

# ---------------------------------------------------------------- 1. guard
bold "1. Checks before deploying"
for f in public/seat-booking.html public/seat-admin.html; do
  grep -qE '^\s*(apiKey|appId):\s*"REPLACE_ME"' "$f" && die \
    "$f still has placeholder Firebase config. Run: bash scripts/setup.sh"
done
ok "web config filled in"

for s in CASHFREE_APP_ID CASHFREE_SECRET_KEY; do
  firebase functions:secrets:access "$s" --project "$PROJECT" >/dev/null 2>&1 \
    || die "secret $s is not set yet. Run: firebase functions:secrets:set $s"
done
ok "Cashfree secrets present"

firebase functions:secrets:access SMTP_PASS --project "$PROJECT" >/dev/null 2>&1 \
  || warn "SMTP_PASS not set. Bookings will work; ticket emails will not send."

# the suite must pass before anything reaches production
bold "2. Running the test suite"
node tests/integration.test.js >/tmp/pfa-tests.log 2>&1 \
  && ok "$(tail -1 /tmp/pfa-tests.log)" \
  || { tail -20 /tmp/pfa-tests.log; die "tests failed, nothing deployed"; }

# ---------------------------------------------------------------- 3. deploy
bold "3. Deploying rules, indexes, functions and hosting"
firebase deploy --only firestore:rules,firestore:indexes,functions,hosting \
  --project "$PROJECT" || die "deploy failed, see the output above"
ok "deployed"

# ---------------------------------------------------------------- 4. webhook
bold "4. Webhook URL"
HOOK=$(gcloud functions describe cashfreeWebhook --region "$REGION" --project "$PROJECT" \
  --format='value(serviceConfig.uri)' 2>/dev/null)
[ -z "$HOOK" ] && HOOK=$(gcloud functions describe cashfreeWebhook --region "$REGION" \
  --project "$PROJECT" --gen2 --format='value(serviceConfig.uri)' 2>/dev/null)
[ -n "$HOOK" ] || die "could not read the cashfreeWebhook URL. Find it in the deploy output above."

CURRENT=$(grep '^WEBHOOK_URL=' functions/.env | cut -d= -f2-)
if [ "$CURRENT" = "$HOOK" ]; then
  skip "already correct in functions/.env"
else
  node -e '
    const fs=require("fs"),p="functions/.env",u=process.argv[1];
    let s=fs.readFileSync(p,"utf8");
    s=/^WEBHOOK_URL=/m.test(s) ? s.replace(/^WEBHOOK_URL=.*$/m,"WEBHOOK_URL="+u) : s.trimEnd()+"\nWEBHOOK_URL="+u+"\n";
    fs.writeFileSync(p,s);' "$HOOK"
  ok "written into functions/.env"
  bold "5. Redeploying functions so they can see it"
  firebase deploy --only functions --project "$PROJECT" || die "second functions deploy failed"
  ok "redeployed"
fi

# ---------------------------------------------------------------- 6. seed
bold "6. Event data"
if [ -f service-account.json ]; then
  export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
  node scripts/seed-event.js && ok "event seeded (safe to re-run, sold seats untouched)" \
    || warn "seed did not complete, see above"
else
  warn "service-account.json missing, skipping the seed. Run scripts/setup.sh."
fi

bold "Deployed"
cat <<EOS

  Booking page   https://${PROJECT}.web.app/
  Seat desk      https://${PROJECT}.web.app/seat-admin.html
  Webhook URL    ${HOOK}

  Two things left, both in the Cashfree dashboard:

  1. Developers, Webhooks, Sandbox: register the webhook URL above for
     PAYMENT_SUCCESS_WEBHOOK, PAYMENT_FAILED_WEBHOOK and
     PAYMENT_USER_DROPPED_WEBHOOK.

  2. Then work through "How to know it is working", stage 2, in the README.

  To give yourself the seat desk, create the account under Authentication,
  Users first, then:

     export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
     node scripts/grant-admin.js you@yourmail.com

EOS
