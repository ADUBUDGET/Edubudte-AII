// ---------------------------------------------------------------
// MOST FREQUENTLY SEARCHED: ranks a student's own search history into a
// short list of chips for the Shop and Bank pages. Pure logic, tested in
// test/frequent-searches.test.js; the query lives in server.js.
// ---------------------------------------------------------------
const { normaliseKey, singular } = require("./smart-basket");

const FREQUENT_MAX_AGE_DAYS = 90;  // older searches are no longer "frequent"
const FREQUENT_LIMIT = 10;
const MIN_LENGTH = 2;
const MAX_LENGTH = 60;             // long sentences aren't useful as chips
const DAY_MS = 24 * 60 * 60 * 1000;

// "Eggs", " eggs " and "EGG!" all count as the same search.
function frequentSearchKey(query) {
  return normaliseKey(query).split(" ").filter(Boolean).map(singular).join(" ");
}

function cleanLabel(query) {
  const text = String(query || "").trim().replace(/\s+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// rows: [{ query, count, lastAt }] (lastAt = most recent time it was searched).
// Returns [{ label, query, count, lastAt }], most searched first, then most recent.
function rankFrequentSearches(rows, { now = new Date(), limit = FREQUENT_LIMIT } = {}) {
  const byKey = new Map();
  for (const r of rows) {
    const key = frequentSearchKey(r.query);
    const lastAt = new Date(r.lastAt);
    if (key.length < MIN_LENGTH || key.length > MAX_LENGTH) continue; // blank or sentence-long
    if (!/[a-z]/.test(key)) continue;                                  // "123", "!!!"
    if (!(now - lastAt <= FREQUENT_MAX_AGE_DAYS * DAY_MS)) continue;   // outdated (or bad date)

    const entry = byKey.get(key) || { key, label: cleanLabel(r.query), count: 0, lastAt };
    entry.count += Number(r.count) || 0;
    if (lastAt > entry.lastAt) {
      entry.lastAt = lastAt;
      entry.label = cleanLabel(r.query); // show the student's latest wording
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map(({ label, count, lastAt }) => ({ label, query: label, count, lastAt }));
}

module.exports = { FREQUENT_MAX_AGE_DAYS, frequentSearchKey, rankFrequentSearches };
