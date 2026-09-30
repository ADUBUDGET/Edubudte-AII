// ---------------------------------------------------------------
// FORGOT PASSWORD: email a single-use reset link, then set a new password.
//
// - The reply to "send me a link" is the same whether or not an account
//   exists, and the email is sent after replying so timing gives nothing away.
// - Links expire after RESET_TOKEN_MINUTES and work once. Only a SHA-256
//   hash of the token is stored; asking for a new link cancels older ones.
// - Emails, tokens and passwords are never logged.
// Store: password-reset-store.js (tests use an in-memory fake).
// ---------------------------------------------------------------
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const RESET_TOKEN_MINUTES = 30;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything longer
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const SENT_MESSAGE = `If an account exists for that email, we've sent a link to reset your password. The link expires in ${RESET_TOKEN_MINUTES} minutes.`;
const INVALID_LINK_MESSAGE = "This reset link is invalid or has expired. Please request a new one.";

const hashToken = token => crypto.createHash("sha256").update(String(token)).digest("hex");

// Returns an error message, or null if the new password is acceptable.
function passwordProblem(password, confirmPassword) {
  if (typeof password !== "string" || password.length === 0) return "Enter a new password.";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return "Password is too long (max 72 characters).";
  if (password !== confirmPassword) return "Passwords don't match.";
  return null;
}

// `waitForEmail`: send before replying. Needed on serverless hosts (Netlify),
// which may freeze the function as soon as the response is sent. Replies then
// take at least MIN_REPLY_MS so the timing doesn't reveal whether an account
// exists.
const MIN_REPLY_MS = 2000;

function createPasswordResetRoutes({ store, mailer, now = () => new Date(), waitForEmail = false }) {
  // Creates a link and emails it. Runs after the reply has been sent.
  async function sendResetLink(email) {
    const user = await store.findUserByEmail(email);
    if (!user) return; // same outcome for the requester as a real account
    await store.cancelOpenTokens(user.id);
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(now().getTime() + RESET_TOKEN_MINUTES * 60 * 1000);
    await store.createToken(user.id, hashToken(token), expiresAt);
    const resetUrl = `${mailer.appUrl()}/reset-password.html?token=${token}`;
    await mailer.sendMail({ to: user.email, ...mailer.passwordResetEmail({ name: user.name, resetUrl, minutes: RESET_TOKEN_MINUTES }) });
  }

  return {
    // POST /api/auth/forgot-password { email }
    // Returns the background job's promise so tests can wait for it.
    async requestReset(req, res) {
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        return res.status(400).json({ error: "Enter a valid email address, like student@dut4life.ac.za." });
      }
      if (!mailer.isMailConfigured()) {
        console.error("Password reset requested, but email (SMTP_*) is not configured.");
        return res.status(503).json({ error: "Password reset emails aren't available right now. Please try again later or contact support." });
      }
      const sending = sendResetLink(email).catch(err => {
        console.error("Password reset email could not be sent:", err.code || err.name || "error");
      });
      if (waitForEmail) {
        await Promise.all([sending, new Promise(resolve => setTimeout(resolve, MIN_REPLY_MS))]);
      }
      res.json({ message: SENT_MESSAGE });
      return sending;
    },

    // GET /api/auth/reset-password/check?token=...  (lets the page say
    // "this link has expired" before the student types a new password)
    async checkToken(req, res) {
      try {
        const token = String(req.query.token || "");
        const valid = TOKEN_PATTERN.test(token) && !!(await store.findValidToken(hashToken(token), now()));
        if (!valid) return res.status(400).json({ error: INVALID_LINK_MESSAGE });
        res.json({ valid: true });
      } catch (err) {
        console.error("Reset link check failed:", err.name);
        res.status(500).json({ error: "Something went wrong. Please try again." });
      }
    },

    // POST /api/auth/reset-password { token, password, confirmPassword }
    async resetPassword(req, res) {
      try {
        const { token, password, confirmPassword } = req.body || {};
        if (!TOKEN_PATTERN.test(String(token || ""))) return res.status(400).json({ error: INVALID_LINK_MESSAGE });
        // Check the password first so a typo doesn't use up the link.
        const problem = passwordProblem(password, confirmPassword);
        if (problem) return res.status(400).json({ error: problem });
        if (!(await store.findValidToken(hashToken(token), now()))) {
          return res.status(400).json({ error: INVALID_LINK_MESSAGE });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        // Atomic: only one request can use a link, even if sent twice at once.
        const userId = await store.consumeToken(hashToken(token), now());
        if (!userId) return res.status(400).json({ error: INVALID_LINK_MESSAGE });
        await store.updatePassword(userId, passwordHash);
        await store.cancelOpenTokens(userId);
        res.json({ message: "Your password has been reset. You can now sign in with your new password." });
      } catch (err) {
        console.error("Password reset failed:", err.name);
        res.status(500).json({ error: "Something went wrong. Please try again." });
      }
    },
  };
}

function registerPasswordResetRoutes(app, routes, { requestLimiter, resetLimiter }) {
  app.post("/api/auth/forgot-password", requestLimiter, routes.requestReset);
  app.get("/api/auth/reset-password/check", resetLimiter, routes.checkToken);
  app.post("/api/auth/reset-password", resetLimiter, routes.resetPassword);
}

module.exports = {
  RESET_TOKEN_MINUTES,
  SENT_MESSAGE,
  INVALID_LINK_MESSAGE,
  hashToken,
  passwordProblem,
  createPasswordResetRoutes,
  registerPasswordResetRoutes,
};
