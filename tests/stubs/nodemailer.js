global.__MAIL = global.__MAIL || [];
module.exports = { createTransport: () => ({ sendMail: async (m) => {
  if (global.__MAIL_FAIL) throw new Error("SMTP down");
  global.__MAIL.push(m); return { messageId: "m" + global.__MAIL.length };
}})};
