// Email features for EduBudget AI, wired into server.js with one call:
//   const emailSvc = createEmailService({ app, sql, requireAuth, generators });
//   - welcomeEmailHook   sends a welcome email after a successful registration
//   - startEmailJob      periodically emails users their new, unread notifications
//   - routes             /api/email-prefs (get/set) and /unsubscribe (link in every email)
const mailer = require("./mailer");

const MAX_EMAILS_PER_RUN = 100; // stays well under free-plan daily limits
const NEW_NOTIFICATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // never email anything older than 3 days
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function maskEmail(email) {
  const [user, domain] = String(email).split("@");
  return (user ? user[0] : "") + "***@" + (domain || "");
}

const UNSUBSCRIBE_PAGE = (title, message) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1C1C1E;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#e2e2e2;">
<div style="max-width:420px;margin:24px;padding:32px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);border-radius:16px;text-align:center;">
<div style="font-size:14px;font-weight:700;color:#ffb77d;margin-bottom:12px;">EduBudget AI</div>
<h1 style="font-size:22px;margin:0 0 12px;">${title}</h1>
<p style="margin:0 0 24px;color:#ddc1ae;line-height:22px;">${message}</p>
<a href="/dashboard.html" style="display:inline-block;background:#ffb77d;color:#4d2600;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:9999px;">Open EduBudget AI</a>
</div></body></html>`;

function createEmailService({ app, sql, requireAuth, generators }) {
  async function ensureEmailSchema() {
    await sql`
      CREATE TABLE IF NOT EXISTS email_prefs (
        user_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ`;
  }

  // ---------------- Welcome email ----------------
  async function sendWelcomeEmail({ email, name }) {
    if (!mailer.isMailConfigured()) {
      console.log("Email is not configured - skipping the welcome email.");
      return;
    }
    let unsubscribeUrl = null;
    try {
      const [u] = await sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (u) unsubscribeUrl = mailer.unsubscribeUrl(u.id);
    } catch (e) {
      // The email is still worth sending without an unsubscribe link.
    }
    const message = mailer.welcomeEmail({ name, unsubscribeUrl });
    await mailer.sendMail({ to: email, ...message });
    console.log("Welcome email sent to", maskEmail(email));
  }

  // Runs before the register handler. It waits for the response to finish and
  // only then sends the email, so a slow or broken mail server can never make
  // signing up fail or slow down.
  function welcomeEmailHook(req, res, next) {
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const name = String((req.body && req.body.name) || "").trim();
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      if (!EMAIL_PATTERN.test(email)) return;
      sendWelcomeEmail({ email, name }).catch((err) => console.error("Welcome email failed:", err.message));
    });
    next();
  }

  // ---------------- Notification emails ----------------
  async function sendNotificationEmails() {
    if (!mailer.isMailConfigured()) return;
    const users = await sql`
      SELECT u.id, u.name, u.email
      FROM users u
      LEFT JOIN email_prefs p ON p.user_id = u.id::text
      WHERE COALESCE(p.enabled, TRUE) = TRUE AND u.email IS NOT NULL
    `;
    let sent = 0;
    for (const u of users) {
      if (sent >= MAX_EMAILS_PER_RUN) break;
      try {
        // Make sure the newest notifications exist (same ones the bell shows).
        for (const generate of generators) {
          try {
            await generate(u.id);
          } catch (e) {
            console.error("Notification generator failed:", e.message);
          }
        }
        const uid = String(u.id);
        const pending = await sql`
          SELECT id, title, body, is_read, created_at
          FROM notifications WHERE user_id = ${uid} AND emailed_at IS NULL ORDER BY id
        `;
        if (pending.length === 0) continue;

        // Only email things that are still unread and recent. Anything the user
        // already saw in the app, or old backlog, is marked as handled silently.
        const toSend = pending.filter(
          (n) => !n.is_read && Date.now() - new Date(n.created_at).getTime() < NEW_NOTIFICATION_WINDOW_MS
        );
        if (toSend.length > 0 && EMAIL_PATTERN.test(String(u.email))) {
          const message = mailer.digestEmail({
            name: u.name,
            items: toSend,
            unsubscribeUrl: mailer.unsubscribeUrl(u.id),
          });
          await mailer.sendMail({ to: u.email, ...message });
          sent++;
          console.log(`Notification email sent to ${maskEmail(u.email)} (${toSend.length} item(s))`);
        }
        const lastId = pending[pending.length - 1].id;
        await sql`UPDATE notifications SET emailed_at = NOW() WHERE user_id = ${uid} AND emailed_at IS NULL AND id <= ${lastId}`;
      } catch (err) {
        // If sending failed we do NOT mark anything as emailed, so it is retried next run.
        console.error("Could not email a user:", err.message);
      }
    }
  }

  let running = false;
  async function runEmailJobOnce() {
    if (running) return;
    running = true;
    try {
      await sendNotificationEmails();
    } catch (err) {
      console.error("Email job failed:", err.message);
    } finally {
      running = false;
    }
  }

  function startEmailJob() {
    if (!mailer.isMailConfigured()) {
      console.log("Email is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS missing in .env) - emails are switched off.");
      return;
    }
    const minutes = Number(process.env.EMAIL_JOB_MINUTES) || 60;
    setTimeout(runEmailJobOnce, 30 * 1000);
    setInterval(runEmailJobOnce, minutes * 60 * 1000);
    console.log(`Email job on: checking for new notifications every ${minutes} minute(s).`);
  }

  // ---------------- Routes ----------------
  app.get("/api/email-prefs", requireAuth, async (req, res) => {
    try {
      const [row] = await sql`SELECT enabled FROM email_prefs WHERE user_id = ${String(req.userId)}`;
      res.json({ enabled: row ? row.enabled : true, configured: mailer.isMailConfigured() });
    } catch (err) {
      res.status(500).json({ error: "Failed to load email settings", detail: err.message });
    }
  });

  app.put("/api/email-prefs", requireAuth, async (req, res) => {
    try {
      if (typeof req.body.enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be true or false" });
      }
      await sql`
        INSERT INTO email_prefs (user_id, enabled) VALUES (${String(req.userId)}, ${req.body.enabled})
        ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
      `;
      res.json({ enabled: req.body.enabled });
    } catch (err) {
      res.status(500).json({ error: "Failed to save email settings", detail: err.message });
    }
  });

  // Public link from every email (no login needed, protected by the signed token).
  app.get("/unsubscribe", async (req, res) => {
    try {
      const userId = String(req.query.u || "");
      if (!userId || !mailer.verifyUnsubscribe(userId, req.query.t)) {
        return res.status(400).send(UNSUBSCRIBE_PAGE("Link not valid", "This unsubscribe link is invalid or incomplete. You can also turn emails off from the bell in the app."));
      }
      await sql`
        INSERT INTO email_prefs (user_id, enabled) VALUES (${userId}, FALSE)
        ON CONFLICT (user_id) DO UPDATE SET enabled = FALSE, updated_at = NOW()
      `;
      res.send(UNSUBSCRIBE_PAGE("You're unsubscribed", "We won't send you notification emails any more. You can turn them back on any time from the bell in the app."));
    } catch (err) {
      console.error(err);
      res.status(500).send(UNSUBSCRIBE_PAGE("Something went wrong", "We couldn't update your settings. Please try again later."));
    }
  });

  return { ensureEmailSchema, welcomeEmailHook, startEmailJob, sendNotificationEmails, sendWelcomeEmail };
}

module.exports = { createEmailService };
