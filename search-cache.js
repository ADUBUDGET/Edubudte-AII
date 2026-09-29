// ---------------------------------------------------------------
// SEARCH CACHE: Shop searches reuse the same real SerpAPI results for a few
// hours instead of paying for an identical search again. Stored in the
// shared price_cache table (no personal data). Filters, radius and the AI
// recommendation still run on every search.
// ---------------------------------------------------------------
const { normaliseKey } = require("./smart-basket");

const SEARCH_CACHE_HOURS = 6;

function searchCacheKey(item, location) {
  return `search:${normaliseKey(location) || "za"}:${normaliseKey(item)}`;
}

// Returns { results, fetchedAt, fromCache }. A cache read/write problem never
// breaks the search: it just falls back to a live lookup.
async function getOrFetchResults({ store, key, fetcher, now = new Date(), maxAgeMs = SEARCH_CACHE_HOURS * 60 * 60 * 1000 }) {
  let cached = null;
  try {
    cached = await store.getCachedPrices(key);
  } catch (e) {
    console.error("Search cache read failed:", e.message);
  }
  if (cached && now - new Date(cached.fetchedAt) < maxAgeMs) {
    return { results: cached.results, fetchedAt: new Date(cached.fetchedAt), fromCache: true };
  }
  const results = await fetcher();
  try {
    await store.saveCachedPrices(key, results, now);
  } catch (e) {
    console.error("Search cache save failed:", e.message);
  }
  return { results, fetchedAt: now, fromCache: false };
}

module.exports = { SEARCH_CACHE_HOURS, searchCacheKey, getOrFetchResults };
