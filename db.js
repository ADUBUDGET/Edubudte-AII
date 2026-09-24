const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Neon's serverless driver runs queries over HTTP - no connection pool to manage.
const sql = neon(process.env.DATABASE_URL);

// Creates the app's tables if they don't exist yet. Existing tables and their
// data are left untouched, so user data survives server restarts.
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

  await sql`
    CREATE TABLE IF NOT EXISTS search_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_query TEXT NOT NULL,
      budget NUMERIC,
      location TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS favourites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      store_name TEXT,
      price NUMERIC,
      link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS budget_log (
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

  // SMART BASKET: the user's grocery list. item_key is the normalised item
  // name (see normaliseKey in smart-basket.js) so "Brown Bread" and
  // "brown bread!" count as the same item. Ticking an item off sets
  // purchased_at instead of deleting it, so past lists can feed future
  // suggestions. Only one *active* (not yet bought) row per item per user.
  await sql`
    CREATE TABLE IF NOT EXISTS grocery_list (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      item_key TEXT NOT NULL,
      product_title TEXT,
      store_name TEXT,
      price NUMERIC,
      link TEXT,
      thumbnail TEXT,
      added_from TEXT NOT NULL DEFAULT 'manual',
      purchased_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS grocery_list_active_item_idx
    ON grocery_list (user_id, item_key) WHERE purchased_at IS NULL
  `;

  // SMART BASKET: per-user swipe decisions. 'skipped' hides a suggestion
  // until skipped_until; 'hidden' hides it until the user restores it.
  await sql`
    CREATE TABLE IF NOT EXISTS smart_basket_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      item_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('skipped', 'hidden')),
      skipped_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, item_key)
    )
  `;

  // SMART BASKET: shared cache of real SerpAPI shopping results per search
  // term (no user data). Filled by /api/search and Smart Basket lookups so
  // the same term isn't paid for twice within a day - protects the quota.
  await sql`
    CREATE TABLE IF NOT EXISTS price_cache (
      query_key TEXT PRIMARY KEY,
      results JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  console.log("Database schema ready.");
}

module.exports = { sql, initSchema };
