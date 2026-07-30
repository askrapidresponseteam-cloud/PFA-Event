#!/usr/bin/env node
"use strict";

/**
 * Grant or revoke organiser access to the seat desk.
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   node scripts/grant-admin.js someone@peopleforanimals.org
 *   node scripts/grant-admin.js someone@peopleforanimals.org --revoke
 *   node scripts/grant-admin.js --list
 *
 * The person must already exist in Firebase Authentication. Create them under
 * Authentication, Users, Add user, with an email and password.
 *
 * Access is a single claim, admin true. There are no sub roles on purpose:
 * anyone you trust at the door is trusted with the booking list, and a
 * permissions matrix for one evening is more to get wrong than to gain.
 */

const admin = require("firebase-admin");

const args = process.argv.slice(2);
const REVOKE = args.includes("--revoke");
const LIST = args.includes("--list");
const email = args.find((a) => !a.startsWith("--"));

async function main() {
  admin.initializeApp();
  const auth = admin.auth();

  if (LIST) {
    const { users } = await auth.listUsers(1000);
    const organisers = users.filter((u) => u.customClaims && u.customClaims.admin === true);
    if (!organisers.length) {
      console.log("No organisers yet. Grant the first one with:");
      console.log("  node scripts/grant-admin.js you@example.org");
      return;
    }
    console.log("Organisers with seat desk access:\n");
    organisers.forEach((u) => {
      const seen = u.metadata.lastSignInTime || "never signed in";
      console.log("  " + u.email.padEnd(38) + seen);
    });
    return;
  }

  if (!email) {
    console.error("Usage: node scripts/grant-admin.js <email> [--revoke]");
    console.error("       node scripts/grant-admin.js --list");
    process.exit(1);
  }

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch (err) {
    console.error(
      "\nNo Firebase Auth user for " + email + ".\n" +
      "Create them first in the console under Authentication, Users, Add user."
    );
    process.exit(1);
  }

  const claims = Object.assign({}, user.customClaims || {});
  if (REVOKE) delete claims.admin;
  else claims.admin = true;

  await auth.setCustomUserClaims(user.uid, claims);
  // Force a fresh token so the change takes effect on their next page load.
  await auth.revokeRefreshTokens(user.uid);

  console.log(
    (REVOKE ? "Revoked" : "Granted") + " seat desk access for " + email + "." +
    (REVOKE ? "" : "\nThey can now sign in at seat-admin.html with their email and password.")
  );
  console.log("They will need to sign in again for the change to apply.");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
