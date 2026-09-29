// Postgres queries for Forgot Password (see password-reset.js).
const { sql } = require("./db");

module.exports = {
  async findUserByEmail(email) {
    const [user] = await sql`SELECT id, name, email FROM users WHERE email = ${email} LIMIT 1`;
    return user || null;
  },

  async createToken(userId, tokenHash, expiresAt) {
    await sql`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (${userId}, ${tokenHash}, ${expiresAt})
    `;
  },

  // Asking for a new link (or resetting) cancels any older unused links.
  async cancelOpenTokens(userId) {
    await sql`UPDATE password_resets SET used_at = NOW() WHERE user_id = ${userId} AND used_at IS NULL`;
  },

  async findValidToken(tokenHash, now) {
    const [row] = await sql`
      SELECT id, user_id FROM password_resets
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
    `;
    return row || null;
  },

  // Marks the link used and returns its user id, in one statement, so the
  // same link can never be used twice.
  async consumeToken(tokenHash, now) {
    const [row] = await sql`
      UPDATE password_resets SET used_at = NOW()
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
      RETURNING user_id
    `;
    return row ? row.user_id : null;
  },

  async updatePassword(userId, passwordHash) {
    await sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}`;
  },
};
