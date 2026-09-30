// Scheduled replacement for the server's hourly email timer (functions
// can't keep timers running). Does nothing until SMTP_* is configured.
const { schedule } = require("@netlify/functions");
const mailer = require("../../mailer");
const { ready, runEmailJobOnce } = require("../../server");

exports.handler = schedule("@hourly", async () => {
  if (!mailer.isMailConfigured()) return { statusCode: 200 };
  await ready();
  await runEmailJobOnce();
  return { statusCode: 200 };
});
