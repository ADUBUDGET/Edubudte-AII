// Sends a test email to check your email settings in .env.
//
// Usage (in the VS Code terminal, inside the project folder):
//   node send-test-email.js your-email@example.com
require("dotenv").config();
const mailer = require("./mailer");

async function main() {
  const to = process.argv[2];
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.log("Usage: node send-test-email.js your-email@example.com");
    process.exit(1);
  }
  if (!mailer.isMailConfigured()) {
    console.log("Email is not set up yet. Add SMTP_HOST, SMTP_USER and SMTP_PASS to your .env file, save it, and try again.");
    process.exit(1);
  }
  const message = mailer.welcomeEmail({ name: "Test Student", unsubscribeUrl: null });
  await mailer.sendMail({ to, ...message });
  console.log("Sent! Check the inbox of " + to + " (and the Spam folder, just in case).");
}

main().catch((err) => {
  if (err.code === "EAUTH") {
    console.error("The email server refused the login. Check SMTP_USER, and that SMTP_PASS is an App Password (not your normal Gmail password).");
  } else if (err.code === "ESOCKET" || err.code === "ETIMEDOUT" || err.code === "ECONNECTION") {
    console.error("Could not reach the email server. Check SMTP_HOST and SMTP_PORT, and your internet connection.");
  } else {
    console.error("Could not send the email:", err.message);
  }
  process.exit(1);
});
