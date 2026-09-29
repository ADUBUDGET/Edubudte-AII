// Combines "what this student searches for" and "what this student actually
// buys" into one ranked list, matching items up by name (case/whitespace
// insensitive) so e.g. searching "airtime" and later buying an item named
// "Airtime" count as the same thing. A purchase counts for more than a
// search, since it's a stronger signal of what the student actually wants.
// Pure function (no database) so it can be unit-tested directly.
const BUY_WEIGHT = 2;

function buildPopularItems(topSearches, topBought, limit = 6) {
  const nameKey = (s) => String(s || "").trim().toLowerCase();
  const merged = new Map();

  for (const r of topSearches || []) {
    const key = nameKey(r.item_query);
    if (!key) continue;
    merged.set(key, {
      name: r.item_query,
      searchCount: Number(r.search_count) || 0,
      buyCount: 0,
      totalSpent: 0,
      weight: Number(r.search_count) || 0,
    });
  }
  for (const r of topBought || []) {
    const key = nameKey(r.item_name);
    if (!key) continue;
    const buyCount = Number(r.buy_count) || 0;
    const totalSpent = Number(r.total_spent) || 0;
    const existing = merged.get(key);
    if (existing) {
      existing.buyCount += buyCount;
      existing.totalSpent += totalSpent;
      existing.weight += buyCount * BUY_WEIGHT;
    } else {
      merged.set(key, { name: r.item_name, searchCount: 0, buyCount, totalSpent, weight: buyCount * BUY_WEIGHT });
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(({ weight, ...rest }) => rest);
}

module.exports = { buildPopularItems };
