// Tests for the Forgot Password flow: request, link checks, reset, sign-in.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const pr = require("../password-reset");

const T0 = new Date("2026-09-29T12:00:00Z");

function setup({ mailConfigured = true, mailFails = false } = {}) {
  let now = T0;
  const users = [{ id: 1, name: "Thandi Mokoena", email: "thandi@dut4life.ac.za", password_hash: bcrypt.hashSync("oldpassword1", 4) }];
  const tokens = [];
  const sent = [];
  const store = {
    users,
    tokens,
    async findUserByEmail(email) { return users.find(u => u.email === email) || null; },
    async createToken(userId, tokenHash, expiresAt) { tokens.push({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null }); },
    async cancelOpenTokens(userId) { tokens.filter(t => t.user_id === userId && !t.used_at).forEach(t => { t.used_at = now; }); },
    async findValidToken(hash, at) { return tokens.find(t => t.token_hash === hash && !t.used_at && t.expires_at > at) || null; },
    async consumeToken(hash, at) {
      const t = tokens.find(x => x.token_hash === hash && !x.used_at && x.expires_at > at);
      if (!t) return null;
      t.used_at = at;
      return t.user_id;
    },
    async updatePassword(userId, hash) { users.find(u => u.id === userId).password_hash = hash; },
  };
  const mailer = {
    appUrl: () => "http://localhost:3000",
    isMailConfigured: () => mailConfigured,
    passwordResetEmail: ({ resetUrl, minutes }) => ({ subject: "Reset", text: `${resetUrl} ${minutes}`, html: resetUrl }),
    async sendMail(msg) {
      if (mailFails) throw Object.assign(new Error("smtp to thandi@dut4life.ac.za failed"), { code: "EAUTH" });
      sent.push(msg);
    },
  };
  const routes = pr.createPasswordResetRoutes({ store, mailer, now: () => now });
  return { store, sent, routes, advance: ms => { now = new Date(now.getTime() + ms); } };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function requestLink(ctx, email) {
  const res = fakeRes();
  await ctx.routes.requestReset({ body: { email } }, res);
  return res;
}

const tokenFrom = msg => msg.text.match(/token=([a-f0-9]{64})/)[1];

async function reset(ctx, token, password, confirmPassword = password) {
  const res = fakeRes();
  await ctx.routes.resetPassword({ body: { token, password, confirmPassword } }, res);
  return res;
}

test("a known email gets a reset link; the reply is the generic one", async () => {
  const ctx = setup();
  const res = await requestLink(ctx, "  Thandi@DUT4life.ac.za ");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, pr.SENT_MESSAGE);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].to, "thandi@dut4life.ac.za");
  assert.match(ctx.sent[0].text, /^http:\/\/localhost:3000\/reset-password\.html\?token=[a-f0-9]{64} 30$/);
});

test("an unknown email gets exactly the same reply, and no email is sent", async () => {
  const ctx = setup();
  const known = await requestLink(ctx, "thandi@dut4life.ac.za");
  const unknown = await requestLink(ctx, "nobody@dut4life.ac.za");
  assert.deepEqual(unknown.body, known.body);
  assert.equal(unknown.statusCode, known.statusCode);
  assert.equal(ctx.sent.length, 1);
});

test("invalid email addresses get a helpful validation error", async () => {
  const ctx = setup();
  for (const email of ["", "thandi", "thandi@", "@dut.ac.za", "a b@c.d"]) {
    const res = await requestLink(ctx, email);
    assert.equal(res.statusCode, 400, email);
    assert.match(res.body.error, /valid email/);
  }
});

test("only a hash of the token is stored", async () => {
  const ctx = setup();
  await requestLink(ctx, "thandi@dut4life.ac.za");
  const token = tokenFrom(ctx.sent[0]);
  assert.notEqual(ctx.store.tokens[0].token_hash, token);
  assert.equal(ctx.store.tokens[0].token_hash, pr.hashToken(token));
});

test("without email set up, the page is told reset emails aren't available", async () => {
  const ctx = setup({ mailConfigured: false });
  const res = await requestLink(ctx, "thandi@dut4life.ac.za");
  assert.equal(res.statusCode, 503);
  assert.equal(ctx.store.tokens.length, 0);
});

test("a mail server failure doesn't change the reply or log the address", async () => {
  const ctx = setup({ mailFails: true });
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const res = await requestLink(ctx, "thandi@dut4life.ac.za");
    assert.equal(res.body.message, pr.SENT_MESSAGE);
  } finally {
    console.error = original;
  }
  assert.ok(logged.length > 0);
  assert.ok(!logged.some(l => l.includes("thandi")), "email must not appear in logs");
});

test("full flow: reset with the link, then sign in with the new password", async () => {
  const ctx = setup();
  await requestLink(ctx, "thandi@dut4life.ac.za");
  const token = tokenFrom(ctx.sent[0]);

  const check = fakeRes();
  await ctx.routes.checkToken({ query: { token } }, check);
  assert.deepEqual(check.body, { valid: true });

  const res = await reset(ctx, token, "newpassword2");
  assert.equal(res.statusCode, 200);
  const user = ctx.store.users[0];
  assert.ok(await bcrypt.compare("newpassword2", user.password_hash));
  assert.ok(!(await bcrypt.compare("oldpassword1", user.password_hash)));
});

test("a link works only once", async () => {
  const ctx = setup();
  await requestLink(ctx, "thandi@dut4life.ac.za");
  const token = tokenFrom(ctx.sent[0]);
  assert.equal((await reset(ctx, token, "newpassword2")).statusCode, 200);
  const again = await reset(ctx, token, "anotherpass3");
  assert.equal(again.statusCode, 400);
  assert.equal(again.body.error, pr.INVALID_LINK_MESSAGE);
});

test("links expire after 30 minutes", async () => {
  const ctx = setup();
  await requestLink(ctx, "thandi@dut4life.ac.za");
  const token = tokenFrom(ctx.sent[0]);
  ctx.advance(31 * 60 * 1000);
  const check = fakeRes();
  await ctx.routes.checkToken({ query: { token } }, check);
  assert.equal(check.statusCode, 400);
  assert.equal((await reset(ctx, token, "newpassword2")).statusCode, 400);
});

test("asking for a new link cancels the old one", async () => {
  const ctx = setup();
  await requestLink(ctx, "thandi@dut4life.ac.za");
  await requestLink(ctx, "thandi@dut4life.ac.za");
  const [first, second] = ctx.sent.map(tokenFrom);
  assert.equal((await reset(ctx, first, "newpassword2")).statusCode, 400);
  assert.equal((await reset(ctx, second, "newpassword2")).statusCode, 200);
});

test("made-up or malformed tokens are rejected with the same message", async () => {
  const ctx = setup();
  for (const token of ["", "abc", "z".repeat(64), "a".repeat(64), undefined]) {
    const res = await reset(ctx, token, "newpassword2");
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, pr.INVALID_LINK_MESSAGE);
  }
});

test("password rules: length, confirmation, and a typo doesn't use up the link", async () => {
  const ctx = setup();
  await requestLink(ctx, "thandi@dut4life.ac.za");
  const token = tokenFrom(ctx.sent[0]);
  assert.match((await reset(ctx, token, "short")).body.error, /at least 8/);
  assert.match((await reset(ctx, token, "newpassword2", "newpassword3")).body.error, /don't match/);
  assert.match((await reset(ctx, token, "x".repeat(80))).body.error, /too long/);
  assert.equal((await reset(ctx, token, "newpassword2")).statusCode, 200); // link still valid
});

test("passwordProblem accepts a good password", () => {
  assert.equal(pr.passwordProblem("goodpass1", "goodpass1"), null);
  assert.match(pr.passwordProblem("", ""), /Enter a new password/);
});
