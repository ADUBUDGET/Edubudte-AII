const { neon } = require("@neondatabase/serverless");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
}

// Neon's serverless driver runs queries over HTTP - no connection pool to manage.
const sql = neon(process.env.DATABASE_URL);
const { CACHE_VERSION } = require("./shopping-results");

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
  // Shopping area for nearby shops (location.js): typed suburb/postcode or
  // GPS (only after the student taps "Use my location"), rounded to ~100 m.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_label TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_source TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS search_radius_km INTEGER DEFAULT 15`;

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
  // Favourites: normalised name for duplicate checks (same rule as
  // normaliseKey in smart-basket.js), a "Purchased" tick and a picture.
  await sql`ALTER TABLE favourites ADD COLUMN IF NOT EXISTS item_key TEXT`;
  await sql`ALTER TABLE favourites ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ`;
  await sql`ALTER TABLE favourites ADD COLUMN IF NOT EXISTS thumbnail TEXT`;
  await sql`ALTER TABLE favourites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`;
  await sql`
    UPDATE favourites
    SET item_key = left(btrim(regexp_replace(lower(item_name), '[^a-z0-9]+', ' ', 'g')), 100)
    WHERE item_key IS NULL
  `;
  // Blocks duplicate favourites at the database level too. Favourites saved
  // twice before this check existed would make the index fail; the app still
  // prevents new duplicates in that case, so never let it stop startup.
  try {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS favourites_user_item_idx ON favourites (user_id, item_key)`;
  } catch (e) {
    console.warn("Existing duplicate favourites found - skipping the unique index (new duplicates are still blocked).");
    await sql`CREATE INDEX IF NOT EXISTS favourites_user_item_lookup_idx ON favourites (user_id, item_key)`;
  }

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
  // BASKET: the grocery list doubles as the basket - quantity, pack size
  // (unit), aisle category and the approved supplier the price is from.
  await sql`ALTER TABLE grocery_list ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE grocery_list ADD COLUMN IF NOT EXISTS unit TEXT`;
  await sql`ALTER TABLE grocery_list ADD COLUMN IF NOT EXISTS category TEXT`;
  await sql`ALTER TABLE grocery_list ADD COLUMN IF NOT EXISTS supplier_id TEXT`;
  await sql`ALTER TABLE grocery_list ADD COLUMN IF NOT EXISTS purchase_id INTEGER`;

  // BASKET CHECKOUT: one row per confirmed purchase. client_ref is sent by
  // the page with each "Confirm purchase", so a double tap or a retry after
  // a dropped connection can never charge the Budget Bank twice.
  await sql`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_ref TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
      estimated_total NUMERIC(10,2),
      item_count INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, client_ref)
    )
  `;
  // Links an automatic budget_log entry to the purchase that created it.
  await sql`ALTER TABLE budget_log ADD COLUMN IF NOT EXISTS purchase_id INTEGER`;

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

  // Cache clean-up: results written under older cache keys/formats are never
  // read again (see shopping-results.js), and anything older than a week is
  // too old to show, so both are removed. Only cached copies of SerpAPI
  // data are deleted here - never user data.
  await sql`
    DELETE FROM price_cache
    WHERE query_key NOT LIKE ${CACHE_VERSION + ":%"} OR fetched_at < NOW() - INTERVAL '7 days'
  `;
  // Deals keep the real product and supplier ids; week-old deals are removed.
  await sql`ALTER TABLE trending_deals ADD COLUMN IF NOT EXISTS product_id TEXT`;
  await sql`ALTER TABLE trending_deals ADD COLUMN IF NOT EXISTS supplier_id TEXT`;
  await sql`DELETE FROM trending_deals WHERE fetched_at < NOW() - INTERVAL '7 days'`;

  // NEARBY SHOPS: cached branch locations per approved supplier per ~5 km
  // area (see location.js). Shared, no personal data.
  await sql`
    CREATE TABLE IF NOT EXISTS store_locations (
      supplier_id TEXT NOT NULL,
      area_key TEXT NOT NULL,
      branches JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (supplier_id, area_key)
    )
  `;

  // FORGOT PASSWORD: one row per reset link. Only a SHA-256 hash of the
  // token is stored, so a database leak can't be used to reset passwords.
  await sql`
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id)`;

  console.log("Database schema ready.");
}

module.exports = { sql, initSchema };
