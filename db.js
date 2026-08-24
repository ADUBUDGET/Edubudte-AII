const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Neon's serverless driver runs queries over HTTP - no connection pool to manage.
const sql = neon(process.env.DATABASE_URL);

// Rebuilds the app's tables against real user accounts. Old anonymous-ID test
// tables from the earlier version are dropped and recreated cleanly, since
// that data was only ever test data and the schema shape has fundamentally
// changed (text anonymous id -> real integer user id with a foreign key).
async function initSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      monthly_budget NUMERIC DEFAULT 0,
      spending_target NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  // Safe no-op if the column already exists (older DBs created before this feature).
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS spending_target NUMERIC`;

  await sql`DROP TABLE IF EXISTS search_history`;
  await sql`
    CREATE TABLE search_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_query TEXT NOT NULL,
      budget NUMERIC,
      location TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`DROP TABLE IF EXISTS favourites`;
  await sql`
    CREATE TABLE favourites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      store_name TEXT,
      price NUMERIC,
      link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`DROP TABLE IF EXISTS budget_log`;
  await sql`
    CREATE TABLE budget_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      description TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // Cached real search results for the "Nearby / Trending Deals" feeds.
  // Populated by scripts/refresh-deals.js (run manually or on a schedule),
  // NOT on every page load - protects the SerpAPI free-tier quota.
  await sql`
    CREATE TABLE IF NOT EXISTS trending_deals (
      id SERIAL PRIMARY KEY,
      query_label TEXT NOT NULL,
      title TEXT,
      price_text TEXT,
      extracted_price NUMERIC,
      source TEXT,
      link TEXT,
      thumbnail TEXT,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  console.log("Database schema ready.");
}

module.exports = { sql, initSchema };
