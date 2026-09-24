// Email helper for EduBudget AI: sends mail over SMTP (Gmail, Brevo, etc.),
// builds the welcome / notification emails, and signs unsubscribe links.
// Settings come from .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, APP_URL.
const crypto = require("crypto");
const nodemailer = require("nodemailer");

function appUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, "");
}

function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 465;
    // Google shows app passwords in groups separated by spaces - remove them.
    const pass = /gmail/i.test(process.env.SMTP_HOST) ? process.env.SMTP_PASS.replace(/\s+/g, "") : process.env.SMTP_PASS;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 465 = SSL from the start, 587 = STARTTLS
      auth: { user: process.env.SMTP_USER, pass },
    });
  }
  return transporter;
}

function fromAddress() {
  return process.env.MAIL_FROM || `EduBudget AI <${process.env.SMTP_USER}>`;
}

async function sendMail({ to, subject, html, text, unsubscribeUrl }) {
  const message = {
    from: fromAddress(),
    to,
    subject: String(subject).replace(/[\r\n]+/g, " "),
    html,
    text,
  };
  if (unsubscribeUrl) {
    message.headers = { "List-Unsubscribe": `<${unsubscribeUrl}>` };
  }
  return getTransporter().sendMail(message);
}

// ---------------------------------------------------------------
// Unsubscribe links: signed with JWT_SECRET so nobody can unsubscribe
// somebody else by guessing a user id.
// ---------------------------------------------------------------
function unsubscribeSig(userId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return crypto.createHmac("sha256", secret).update("unsubscribe:" + String(userId)).digest("hex");
}

function unsubscribeUrl(userId) {
  return `${appUrl()}/unsubscribe?u=${encodeURIComponent(String(userId))}&t=${unsubscribeSig(userId)}`;
}

function verifyUnsubscribe(userId, sig) {
  try {
    const expected = Buffer.from(unsubscribeSig(userId), "hex");
    const given = Buffer.from(String(sig || ""), "hex");
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------
// Templates (same colours as the app: dark background, orange accent)
// ---------------------------------------------------------------
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstName(name) {
  // Keep only letters, marks, apostrophes, hyphens and dots so odd input can't end up in the subject line.
  const cleaned = String(name || "").replace(/[^\p{L}\p{M}'\u2019.\- ]/gu, "").trim().split(/\s+/)[0] || "";
  return cleaned.slice(0, 40);
}

function layout({ preheader, heading, bodyHtml, unsubscribeUrl: unsubUrl }) {
  const footer = unsubUrl
    ? `You're getting this email because you have an EduBudget AI account. <a href="${escapeHtml(unsubUrl)}" style="color:#ffb77d;">Unsubscribe</a> from these emails any time.`
    : "You're getting this email because you have an EduBudget AI account.";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#1C1C1E;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1C1C1E;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#1f1f1f;border:1px solid #353535;border-radius:16px;">
<tr><td style="padding:32px 28px;font-family:'Plus Jakarta Sans',Arial,Helvetica,sans-serif;color:#e2e2e2;font-size:16px;line-height:24px;">
<div style="font-size:14px;font-weight:700;color:#ffb77d;margin-bottom:16px;">EduBudget AI</div>
<h1 style="margin:0 0 16px;font-size:24px;line-height:32px;color:#e2e2e2;">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
<tr><td style="padding:16px 8px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#a48c7a;text-align:center;">${footer}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function button(url, label) {
  return `<p style="margin:24px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#ffb77d;color:#4d2600;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:9999px;">${escapeHtml(label)}</a></p>`;
}

function welcomeEmail({ name, unsubscribeUrl: unsubUrl }) {
  const hi = firstName(name);
  const greeting = hi ? `Hi ${hi},` : "Hi there,";
  const openUrl = `${appUrl()}/dashboard.html`;
  const bodyHtml = `
<p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
<p style="margin:0 0 16px;">Welcome to EduBudget AI. Thanks for signing up! We help you stay on top of your student budget and find better prices, all in Rand.</p>
<p style="margin:0 0 8px;font-weight:700;">Get started in three steps:</p>
<ol style="margin:0 0 8px;padding-left:20px;color:#e2e2e2;">
<li style="margin-bottom:6px;">Set your monthly budget on the Profile page.</li>
<li style="margin-bottom:6px;">Log your spending so we can track what's left.</li>
<li style="margin-bottom:6px;">Ask EduChatBot to plan your budget or build a grocery list.</li>
</ol>
${button(openUrl, "Open EduBudget AI")}
<p style="margin:24px 0 0;color:#ddc1ae;font-size:14px;line-height:20px;">We'll also email you about budget alerts and store specials. You can switch these emails off any time.</p>`;
  const text = [
    greeting,
    "",
    "Welcome to EduBudget AI. Thanks for signing up! We help you stay on top of your student budget and find better prices, all in Rand.",
    "",
    "Get started in three steps:",
    "1. Set your monthly budget on the Profile page.",
    "2. Log your spending so we can track what's left.",
    "3. Ask EduChatBot to plan your budget or build a grocery list.",
    "",
    `Open EduBudget AI: ${openUrl}`,
    "",
    "We'll also email you about budget alerts and store specials.",
    unsubUrl ? `Unsubscribe: ${unsubUrl}` : "",
  ].join("\n");
  return {
    subject: hi ? `Welcome to EduBudget AI, ${hi}!` : "Welcome to EduBudget AI!",
    html: layout({ preheader: "Your student budget buddy is ready.", heading: "Welcome to EduBudget AI", bodyHtml, unsubscribeUrl: unsubUrl }),
    text,
    unsubscribeUrl: unsubUrl,
  };
}

function digestEmail({ name, items, unsubscribeUrl: unsubUrl }) {
  const hi = firstName(name);
  const openUrl = `${appUrl()}/dashboard.html`;
  const rows = items.map((n) => `
<div style="margin:0 0 12px;padding:12px 16px;border-left:3px solid #ff8c00;background:#2a2a2a;border-radius:8px;">
<div style="font-weight:700;color:#e2e2e2;">${escapeHtml(n.title)}</div>
${n.body ? `<div style="font-size:14px;line-height:20px;color:#ddc1ae;margin-top:2px;">${escapeHtml(n.body)}</div>` : ""}
</div>`).join("");
  const bodyHtml = `
<p style="margin:0 0 16px;">${escapeHtml(hi ? `Hi ${hi}, here's what's new:` : "Here's what's new:")}</p>
${rows}
${button(openUrl, "Open EduBudget AI")}`;
  const text = [
    hi ? `Hi ${hi}, here's what's new:` : "Here's what's new:",
    "",
    ...items.map((n) => `- ${n.title}${n.body ? `\n  ${n.body}` : ""}`),
    "",
    `Open EduBudget AI: ${openUrl}`,
    unsubUrl ? `\nUnsubscribe: ${unsubUrl}` : "",
  ].join("\n");
  return {
    subject: items.length === 1 ? String(items[0].title) : `${items.length} new updates from EduBudget AI`,
    html: layout({ preheader: String(items[0].title), heading: items.length === 1 ? "You have a new update" : "You have new updates", bodyHtml, unsubscribeUrl: unsubUrl }),
    text,
    unsubscribeUrl: unsubUrl,
  };
}

module.exports = { appUrl, isMailConfigured, sendMail, unsubscribeUrl, verifyUnsubscribe, escapeHtml, welcomeEmail, digestEmail };
