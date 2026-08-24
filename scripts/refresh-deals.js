// Run with: npm run refresh-deals
// Populates the trending_deals table with a small set of real, live
// SerpAPI searches for common student purchase categories. Run this
// manually (or on a schedule you control, e.g. a daily cron job) rather
// than on every page load, since the free SerpAPI tier is 100/month.
require("dotenv").config();
const { sql, initSchema } = require("../db");

const QUERIES = [
  "textbook",
  "desk lamp",
  "wireless headphones",
  "backpack",
  "laptop stand",
];

async function refreshDeals() {
  if (!process.env.SERPAPI_KEY) {
    console.error("SERPAPI_KEY not set in .env");
    process.exit(1);
  }

  await initSchema();

  for (const query of QUERIES) {
    console.log(`Fetching real results for: ${query}`);
    const params = new URLSearchParams({
      engine: "google_shopping",
      q: query,
      api_key: process.env.SERPAPI_KEY,
      gl: "za",
      hl: "en",
    });

    const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!resp.ok) {
      console.error(`  Failed: ${resp.status} ${await resp.text()}`);
      continue;
    }
    const data = await resp.json();
    const results = (data.shopping_results || []).slice(0, 4);

    for (const r of results) {
      await sql`
        INSERT INTO trending_deals (query_label, title, price_text, extracted_price, source, link, thumbnail)
        VALUES (${query}, ${r.title || null}, ${r.price || null}, ${r.extracted_price || null}, ${r.source || null}, ${r.link || null}, ${r.thumbnail || null})
      `;
    }
    console.log(`  Cached ${results.length} results.`);
  }

  // Keep only the most recent batch so the table doesn't grow forever.
  await sql`
    DELETE FROM trending_deals
    WHERE id NOT IN (SELECT id FROM trending_deals ORDER BY fetched_at DESC LIMIT 100)
  `;

  console.log("\nDone. Trending deals cache refreshed.");
  process.exit(0);
}

refreshDeals().catch(err => {
  console.error("Refresh failed:", err);
  process.exit(1);
});
