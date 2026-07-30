"use strict";
/* Redirects the Firebase and mail modules to local stubs so the REAL
   functions/index.js runs in-process with an in-memory Firestore. */
const path = require("path");
const Module = require("module");
const stubs = path.join(__dirname, "stubs");
const one = require(path.join(stubs, "firebase-functions.js"));

const map = {
  "firebase-admin": path.join(stubs, "firebase-admin.js"),
  "nodemailer": path.join(stubs, "nodemailer.js"),
  "qrcode": path.join(stubs, "qrcode.js")
};
const virtual = {
  "firebase-functions/v2": one.v2,
  "firebase-functions/v2/https": one.https,
  "firebase-functions/v2/scheduler": one.scheduler,
  "firebase-functions/v2/firestore": one.firestoreTriggers,
  "firebase-functions/params": one.params,
  "firebase-functions/logger": one.logger,
  "firebase-functions": {}
};

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (map[request]) return map[request];
  if (request in virtual) return "\0virtual:" + request;
  return orig.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request in virtual) return virtual[request];
  return origLoad.call(this, request, ...rest);
};
