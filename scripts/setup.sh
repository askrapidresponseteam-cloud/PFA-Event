#!/usr/bin/env bash
#
# Terminal setup for the PFA seat booking backend on project pfa-events.
#
#   bash scripts/setup.sh
#
# Safe to run more than once. Every step checks whether it has already been
# done and skips rather than repeating it. Nothing here deletes data.
#
# What it cannot do, because no API exists for them, is listed at the end and
# in SETUP-pfa-events.md: the Cashfree dashboard steps, and connecting a custom
# domain. Everything else happens here.

set -uo pipefail

PROJECT="pfa-events"
REGION="asia-south1"
APP_NICKNAME="pfa-seat-booking"

bold() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32mok\033[0m    %s\n" "$1"; }
skip() { printf "  \033[90mskip\033[0m  %s\n" "$1"; }
warn() { printf "  \033[33mnote\033[0m  %s\n" "$1"; }
die()  { printf "  \033[31mstop\033[0m  %s\n\n" "$1"; exit 1; }

cd "$(dirname "$0")/.." || die "run this from inside the repo"

# ---------------------------------------------------------------- 0. tools
bold "0. Checking tools"
command -v node >/dev/null || die "Node.js is not installed. Install Node 20 or newer."
node -e 'process.exit(parseInt(process.versions.node) >= 20 ? 0 : 1)' \
  || die "Node 20 or newer is required. You have $(node -v)."
ok "node $(node -v)"

command -v firebase >/dev/null || {
  warn "installing firebase-tools"
  npm install -g firebase-tools >/dev/null 2>&1 || die "could not install firebase-tools"
}
ok "firebase $(firebase --version 2>/dev/null | head -1)"

command -v gcloud >/dev/null || die \
  "gcloud is not installed. It is needed to create Firestore and enable anonymous sign in.
        Install it from https://cloud.google.com/sdk/docs/install then re-run this script."
ok "gcloud present"

# ---------------------------------------------------------------- 1. login
bold "1. Signing in"
firebase projects:list >/dev/null 2>&1 || firebase login || die "firebase login failed"
ok "firebase account active"

gcloud auth print-access-token >/dev/null 2>&1 || gcloud auth login || die "gcloud login failed"
gcloud config set project "$PROJECT" >/dev/null 2>&1
ok "gcloud pointed at $PROJECT"

firebase use "$PROJECT" >/dev/null 2>&1 || die "cannot select $PROJECT. Is the account the project owner?"
ok "firebase using $PROJECT"

# ---------------------------------------------------------------- 2. APIs
bold "2. Enabling the Google Cloud APIs this project needs"
APIS="firestore.googleapis.com identitytoolkit.googleapis.com cloudfunctions.googleapis.com \
cloudbuild.googleapis.com run.googleapis.com artifactregistry.googleapis.com \
cloudscheduler.googleapis.com secretmanager.googleapis.com eventarc.googleapis.com \
pubsub.googleapis.com firebasehosting.googleapis.com"
gcloud services enable $APIS --project "$PROJECT" >/dev/null 2>&1 \
  && ok "APIs enabled" || warn "some APIs may already be on, continuing"

# ---------------------------------------------------------------- 3. Firestore
bold "3. Firestore database"
EXISTING_LOC=$(gcloud firestore databases describe --database='(default)' \
  --project "$PROJECT" --format='value(locationId)' 2>/dev/null)

if [ -n "$EXISTING_LOC" ]; then
  if [ "$EXISTING_LOC" = "$REGION" ]; then
    skip "already exists in $REGION"
  else
    warn "database exists in $EXISTING_LOC, not $REGION."
    warn "A database location cannot be changed. The code deploys to $REGION;"
    warn "cross region works but is slower. Tell Claude before going further."
  fi
else
  gcloud firestore databases create --location="$REGION" --type=firestore-native \
    --project "$PROJECT" >/dev/null 2>&1 \
    && ok "created in $REGION (Native mode)" \
    || die "could not create Firestore. If the project's default resource location
        was already fixed elsewhere, create it in the console instead."
fi

# ---------------------------------------------------------------- 4. web app
bold "4. Web app registration and config"
APP_ID=$(firebase apps:list WEB --project "$PROJECT" --json 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{const j=JSON.parse(d);const a=(j.result||[]).find(x=>x.platform==="WEB");
      process.stdout.write(a?a.appId:"");}catch(e){process.stdout.write("");}})')

if [ -z "$APP_ID" ]; then
  firebase apps:create WEB "$APP_NICKNAME" --project "$PROJECT" >/dev/null 2>&1 \
    || die "could not register the web app"
  APP_ID=$(firebase apps:list WEB --project "$PROJECT" --json 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        try{const j=JSON.parse(d);const a=(j.result||[]).find(x=>x.platform==="WEB");
        process.stdout.write(a?a.appId:"");}catch(e){process.stdout.write("");}})')
  ok "registered web app"
else
  skip "web app already registered"
fi
[ -n "$APP_ID" ] || die "could not determine the web app id"

firebase apps:sdkconfig WEB "$APP_ID" --project "$PROJECT" --json > /tmp/pfa-sdkconfig.json 2>/dev/null \
  || die "could not download the SDK config"

node - <<'NODE' || die "could not write the config into the pages"
const fs = require("fs");
const raw = JSON.parse(fs.readFileSync("/tmp/pfa-sdkconfig.json", "utf8"));
const c = (raw.result && (raw.result.sdkConfig || raw.result)) || {};
if (!c.apiKey || !c.appId) { console.error("  config missing apiKey or appId"); process.exit(1); }

const block = `const FIREBASE_CONFIG = {
  apiKey:            ${JSON.stringify(c.apiKey)},
  authDomain:        ${JSON.stringify(c.authDomain)},
  projectId:         ${JSON.stringify(c.projectId)},
  storageBucket:     ${JSON.stringify(c.storageBucket || "")},
  messagingSenderId: ${JSON.stringify(c.messagingSenderId)},
  appId:             ${JSON.stringify(c.appId)}
};`;

for (const f of ["public/seat-booking.html", "public/seat-admin.html"]) {
  let s = fs.readFileSync(f, "utf8");
  const re = /const FIREBASE_CONFIG = \{[\s\S]*?\n\};/;
  if (!re.test(s)) { console.error("  could not find the config block in " + f); process.exit(1); }
  fs.writeFileSync(f, s.replace(re, block));
  console.log("  ok    config written into " + f);
}
NODE
rm -f /tmp/pfa-sdkconfig.json

# keep the GoDaddy copy in step with the live page
cp public/seat-booking.html godaddy/book/index.html 2>/dev/null && ok "GoDaddy copy refreshed"

# ---------------------------------------------------------------- 5. anon auth
bold "5. Anonymous sign in"
TOKEN=$(gcloud auth print-access-token 2>/dev/null)
curl -s -X POST \
  "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT}/identityPlatform:initializeAuth" \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" >/dev/null 2>&1

ANON=$(curl -s -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config?updateMask=signIn.anonymous.enabled" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"signIn":{"anonymous":{"enabled":true}}}' 2>/dev/null)

echo "$ANON" | grep -q '"enabled": *true' \
  && ok "anonymous sign in enabled" \
  || warn "could not confirm anonymous sign in. Check Authentication, Sign-in method in the console."

# ---------------------------------------------------------------- 6. key
bold "6. Service account key for the scripts"
if [ -f service-account.json ]; then
  skip "service-account.json already present"
else
  SA="${PROJECT}@appspot.gserviceaccount.com"
  gcloud iam service-accounts keys create service-account.json \
    --iam-account "$SA" --project "$PROJECT" >/dev/null 2>&1 \
    && ok "key saved to service-account.json (git ignored)" \
    || warn "could not create a key automatically. Download one from
        Project settings, Service accounts, Generate new private key."
fi

# ---------------------------------------------------------------- 7. deps
bold "7. Dependencies"
( cd functions && npm install --silent >/dev/null 2>&1 ) && ok "functions deps installed" \
  || die "npm install failed inside functions/"
npm install --silent firebase-admin >/dev/null 2>&1 && ok "firebase-admin available for the scripts"

bold "Automated setup finished"
cat <<EOS

  Done so far: APIs, Firestore in ${REGION}, web app registered and its config
  written into both pages, anonymous sign in, service account key, dependencies.

  Three things need you, because no API exists for them:

  1. Cashfree sandbox keys. Dashboard, Developers, API Keys, Sandbox. Then:

       firebase functions:secrets:set CASHFREE_APP_ID
       firebase functions:secrets:set CASHFREE_SECRET_KEY

  2. The ticket mailbox. Create a Gmail App Password (section F of the runbook):

       firebase functions:secrets:set SMTP_PASS

     and fill SMTP_USER, MAIL_FROM and MAIL_ORGANISER in functions/.env

  3. Then run the deploy script, which handles the rest including the
     webhook URL round trip:

       bash scripts/deploy.sh

EOS
