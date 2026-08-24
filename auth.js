const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { sql } = require("./db");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Copy .env.example to .env and fill it in.");
}

const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = "token";
const TOKEN_TTL = "7d";
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const isEmailValid = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function setAuthCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,       // not readable by JS - protects against XSS token theft
    secure: process.env.NODE_ENV === "production", // set true automatically once served over HTTPS
    sameSite: "lax",      // reasonable CSRF protection for a same-site app
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

// Attaches req.userId if a valid session cookie is present, otherwise 401s.
function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid, please log in again" });
  }
}

async function register(req, res) {
  try {
    const { name, email, password, monthlyBudget, spendingTarget } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email and password are required" });
    }
    if (!isEmailValid(email)) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await sql`
      INSERT INTO users (name, email, password_hash, monthly_budget, spending_target)
      VALUES (${name}, ${email.toLowerCase()}, ${passwordHash}, ${monthlyBudget || 0}, ${spendingTarget || null})
      RETURNING id, name, email, monthly_budget, spending_target
    `;

    setAuthCookie(res, user.id);
    res.status(201).json({ id: user.id, name: user.name, email: user.email, monthlyBudget: user.monthly_budget, spendingTarget: user.spending_target });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed", detail: err.message });
  }
}

// Basic in-memory attempt tracking is handled by express-rate-limit at the
// route level (see server.js) - this function just verifies credentials.
async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const [user] = await sql`SELECT * FROM users WHERE email = ${email.toLowerCase()}`;
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    setAuthCookie(res, user.id);
    res.json({ id: user.id, name: user.name, email: user.email, monthlyBudget: user.monthly_budget, spendingTarget: user.spending_target });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed", detail: err.message });
  }
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.status(204).send();
}

async function me(req, res) {
  try {
    const [user] = await sql`SELECT id, name, email, monthly_budget, spending_target FROM users WHERE id = ${req.userId}`;
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ id: user.id, name: user.name, email: user.email, monthlyBudget: user.monthly_budget, spendingTarget: user.spending_target });
  } catch (err) {
    res.status(500).json({ error: "Failed to load profile", detail: err.message });
  }
}

async function updateProfile(req, res) {
  try {
    const { name, monthlyBudget, spendingTarget } = req.body;
    const [user] = await sql`
      UPDATE users
      SET name = COALESCE(${name}, name),
          monthly_budget = COALESCE(${monthlyBudget}, monthly_budget),
          spending_target = COALESCE(${spendingTarget}, spending_target)
      WHERE id = ${req.userId}
      RETURNING id, name, email, monthly_budget, spending_target
    `;
    res.json({ id: user.id, name: user.name, email: user.email, monthlyBudget: user.monthly_budget, spendingTarget: user.spending_target });
  } catch (err) {
    res.status(500).json({ error: "Failed to update profile", detail: err.message });
  }
}

module.exports = { requireAuth, register, login, logout, me, updateProfile };
