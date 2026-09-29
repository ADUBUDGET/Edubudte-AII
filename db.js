const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Neon's serverless driver runs queries over HTTP - no connection pool to manage.
const sql = neon(process.env.DATABASE_URL);

// Creates every table the app needs if it doesn't already exist, and adds
// any new columns to ones that do. Nothing here is ever dropped, so restarting
// the app never loses a student's favourites, spending log or search history.
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

  // No longer dropped on startup - see the note above CREATE TABLE budget_log.
  // Resetting this every restart would also reset "most frequently searched".
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

  // budget_log is created before favourites so favourites.budget_log_id can
  // point at it. Both used to be dropped and recreated on every startup -
  // fine while the schema was still changing, but it silently wiped every
  // user's favourites and spending log on every restart. Now that the shape
  // is stable, both are created once and only ever gain new columns.
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
  // Set only on entries created automatically (e.g. from marking a favourite),
  // so they can be matched up with search history by item name. Manual log
  // entries from the "Log a Purchase" form leave this blank.
  await sql`ALTER TABLE budget_log ADD COLUMN IF NOT EXISTS item_name TEXT`;

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
  // Points at the budget_log row auto-created when this favourite was saved
  // (if it had a price), so we know a favourite has already been logged.
  // Not a foreign key on purpose: deleting the log entry should never be
  // blocked by, or silently delete, the favourite that pointed at it.
  await sql`ALTER TABLE favourites ADD COLUMN IF NOT EXISTS budget_log_id INTEGER`;

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
