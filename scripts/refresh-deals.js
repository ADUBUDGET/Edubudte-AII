// Run with: npm run refresh-deals
// Refreshes "Trending Student Deals" from real data only:
//  1. the terms students really search for most (search_history, searched by
//     at least DEAL_MIN_USERS different students in the last 30 days),
//  2. live Google Shopping results for each (SerpAPI, same mapping as the
//     Shop), keeping only approved suppliers and in-stock listings.
// Nothing is hard-coded: with no qualifying searches, nothing is fetched and
// the Bank page shows its empty state. Run it manually or on a schedule you
// control - each run uses up to DEAL_QUERIES SerpAPI searches. On Netlify it
// also runs daily as a scheduled function (netlify/functions/refresh-deals.js).
require("dotenv").config();
const { sql, initSchema } = require("../db");
const { fetchShoppingResults } = require("../shopping-results");
const { cleanShoppingResults } = require("../suppliers");
const { DEAL_MIN_USERS, DEAL_QUERIES, DEALS_PER_QUERY } = require("../deals");

// Returns { terms, saved }. Throws when SerpAPI isn't configured.
async function refreshDeals({ log = console.log } = {}) {
  if (!process.env.SERPAPI_KEY) throw new Error("SERPAPI_KEY not set in .env");
  await initSchema();

  const terms = await sql`
    SELECT (array_agg(item_query ORDER BY created_at DESC))[1] AS term, COUNT(DISTINCT user_id)::int AS students
    FROM search_history
    WHERE created_at > NOW() - INTERVAL '30 days' AND length(trim(item_query)) BETWEEN 2 AND 60
    GROUP BY lower(trim(item_query))
    HAVING COUNT(DISTINCT user_id) >= ${DEAL_MIN_USERS}
    ORDER BY students DESC, COUNT(*) DESC
    LIMIT ${DEAL_QUERIES}
  `;
  if (!terms.length) {
    log(`No term has been searched by ${DEAL_MIN_USERS}+ students in the last 30 days yet - nothing to refresh.`);
    return { terms: 0, saved: 0 };
  }

  const fresh = [];
  for (const { term } of terms) {
    try {
      const { results } = cleanShoppingResults(await fetchShoppingResults(term));
      const cheapest = results.sort((a, b) => a.extracted_price - b.extracted_price).slice(0, DEALS_PER_QUERY);
      cheapest.forEach(r => fresh.push({ term, r }));
      log(`${term}: ${cheapest.length} deal(s) from approved shops`);
    } catch (err) {
      console.error(`${term}: lookup failed (${err.message})`);
    }
  }

  // Replace the whole list so old prices never linger next to new ones.
  await sql`DELETE FROM trending_deals`;
  for (const { term, r } of fresh) {
    await sql`
      INSERT INTO trending_deals (query_label, title, price_text, extracted_price, source, link, thumbnail, product_id, supplier_id)
      VALUES (${term}, ${r.title}, ${r.price}, ${r.extracted_price}, ${r.source}, ${r.link}, ${r.thumbnail}, ${r.product_id}, ${r.supplierId})
    `;
  }
  log(`\nDone. ${fresh.length} current deal(s) saved.`);
  return { terms: terms.length, saved: fresh.length };
}

if (require.main === module) {
  refreshDeals()
    .then(() => process.exit(0))
    .catch(err => {
      console.error("Refresh failed:", err.message);
      process.exit(1);
    });
}

module.exports = { refreshDeals };
