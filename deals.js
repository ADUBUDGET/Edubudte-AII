// ---------------------------------------------------------------
// DEALS ("Trending Student Deals" on the Bank page).
// Built only from real data: the terms students actually search for most
// (search_history, at least DEAL_MIN_USERS different students so nobody's
// searches are singled out), priced with real Google Shopping results from
// approved suppliers. Deals older than DEALS_MAX_AGE_DAYS are not shown -
// their prices can't be treated as current.
// Filled by `npm run refresh-deals` (scripts/refresh-deals.js).
// ---------------------------------------------------------------
const { matchSupplier } = require("./suppliers");

const DEALS_MAX_AGE_DAYS = 3;
const DEAL_MIN_USERS = 2;
const DEAL_QUERIES = 5;
const DEALS_PER_QUERY = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

// Deals that may be shown now: recent, priced, from an approved supplier.
function selectCurrentDeals(rows, now = new Date(), limit = 12) {
  return (rows || [])
    .filter(d => now - new Date(d.fetched_at) <= DEALS_MAX_AGE_DAYS * DAY_MS)
    .filter(d => Number.isFinite(Number(d.extracted_price)) && Number(d.extracted_price) > 0)
    .map(d => ({ d, supplier: matchSupplier(d.source) }))
    .filter(x => x.supplier)
    .sort((a, b) => new Date(b.d.fetched_at) - new Date(a.d.fetched_at))
    .slice(0, limit)
    .map(({ d, supplier }) => ({ ...d, supplier_id: supplier.id, supplier_name: supplier.name }));
}

module.exports = { DEALS_MAX_AGE_DAYS, DEAL_MIN_USERS, DEAL_QUERIES, DEALS_PER_QUERY, selectCurrentDeals };
