"use strict";
/* One-file stub of the firebase-functions v2 surface index.js touches. */
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
global.__LOG = global.__LOG || [];
const rec = (lvl) => (...a) => global.__LOG.push([lvl, ...a]);
global.__CFG = global.__CFG || {};
const mkParam = (name, o) => ({ name, value: () => (name in global.__CFG ? global.__CFG[name] : (o && o.default !== undefined ? o.default : "")) });

module.exports = {
  v2: { setGlobalOptions() {} },
  https: {
    HttpsError,
    onCall: (opts, fn) => fn || opts,
    onRequest: (opts, fn) => fn || opts
  },
  scheduler: { onSchedule: (opts, fn) => fn || opts },
  firestoreTriggers: { onDocumentWritten: (opts, fn) => fn || opts },
  params: {
    defineSecret: mkParam,
    defineString: mkParam,
    defineInt: (n, o) => ({ name: n, value: () => Number(n in global.__CFG ? global.__CFG[n] : (o && o.default) || 0) })
  },
  logger: { info: rec("info"), warn: rec("warn"), error: rec("error") }
};
