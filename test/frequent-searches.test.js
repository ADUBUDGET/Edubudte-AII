// Tests for "Most frequently searched" ranking and the Shop search cache.
const test = require("node:test");
const assert = require("node:assert/strict");
const { rankFrequentSearches, frequentSearchKey } = require("../frequent-searches");
const { searchCacheKey, getOrFetchResults } = require("../search-cache");

const NOW = new Date("2026-09-29T12:00:00Z");
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

test("merges spelling/case/plural variants into one chip", () => {
  assert.equal(frequentSearchKey(" Eggs! "), frequentSearchKey("egg"));
  const out = rankFrequentSearches([
    { query: "eggs", count: 2, lastAt: daysAgo(3) },
    { query: "Egg", count: 1, lastAt: daysAgo(1) },
  ], { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
  assert.equal(out[0].label, "Egg"); // latest wording
});

test("most searched first, most recent breaks ties", () => {
  const out = rankFrequentSearches([
    { query: "rice", count: 2, lastAt: daysAgo(5) },
    { query: "bread", count: 5, lastAt: daysAgo(10) },
    { query: "milk", count: 2, lastAt: daysAgo(1) },
  ], { now: NOW });
  assert.deepEqual(out.map(i => i.label), ["Bread", "Milk", "Rice"]);
});

test("drops blank, junk, sentence-long and outdated searches", () => {
  const out = rankFrequentSearches([
    { query: "   ", count: 9, lastAt: daysAgo(1) },
    { query: "!!!", count: 9, lastAt: daysAgo(1) },
    { query: "12345", count: 9, lastAt: daysAgo(1) },
    { query: "a", count: 9, lastAt: daysAgo(1) },
    { query: "cheap wireless headphones that work with my old laptop from 2015 please", count: 9, lastAt: daysAgo(1) },
    { query: "textbook", count: 9, lastAt: daysAgo(120) },
    { query: "peanut butter", count: 1, lastAt: daysAgo(2) },
  ], { now: NOW });
  assert.deepEqual(out.map(i => i.label), ["Peanut butter"]);
});

test("tidies labels and keeps a runnable query", () => {
  const [item] = rankFrequentSearches([{ query: "  long   life milk ", count: 1, lastAt: daysAgo(1) }], { now: NOW });
  assert.equal(item.label, "Long life milk");
  assert.equal(item.query, "Long life milk");
});

test("returns at most 10 chips, and none for a new student", () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ query: "item " + String.fromCharCode(97 + i), count: 1, lastAt: daysAgo(1) }));
  assert.equal(rankFrequentSearches(rows, { now: NOW }).length, 10);
  assert.deepEqual(rankFrequentSearches([], { now: NOW }), []);
});

// ---------------------------------------------------------------
// Shop search cache
// ---------------------------------------------------------------
function fakeStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async getCachedPrices(k) { return map.get(k) || null; },
    async saveCachedPrices(k, results) { map.set(k, { results, fetchedAt: NOW }); },
  };
}

test("search cache keys ignore case and spacing, and separate locations", () => {
  assert.equal(searchCacheKey("  Brown Bread ", null), searchCacheKey("brown bread", ""));
  assert.notEqual(searchCacheKey("bread", "Durban"), searchCacheKey("bread", "Cape Town"));
});

test("a repeat search within 6 hours reuses results without calling SerpAPI", async () => {
  const store = fakeStore({ "search:za:rice": { results: [{ title: "Rice" }], fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000) } });
  let calls = 0;
  const out = await getOrFetchResults({ store, key: "search:za:rice", fetcher: async () => { calls++; return []; }, now: NOW });
  assert.equal(calls, 0);
  assert.equal(out.fromCache, true);
  assert.deepEqual(out.results, [{ title: "Rice" }]);
});

test("expired results are fetched again and saved, with the new check time", async () => {
  const store = fakeStore({ "search:za:rice": { results: [], fetchedAt: new Date(NOW.getTime() - 7 * 60 * 60 * 1000) } });
  const out = await getOrFetchResults({ store, key: "search:za:rice", fetcher: async () => [{ title: "Fresh rice" }], now: NOW });
  assert.equal(out.fromCache, false);
  assert.equal(out.fetchedAt, NOW);
  assert.deepEqual(store.map.get("search:za:rice").results, [{ title: "Fresh rice" }]);
});

test("a broken cache never breaks the search", async () => {
  const store = {
    async getCachedPrices() { throw new Error("db down"); },
    async saveCachedPrices() { throw new Error("db down"); },
  };
  const out = await getOrFetchResults({ store, key: "k", fetcher: async () => [{ title: "Live" }], now: NOW });
  assert.deepEqual(out.results, [{ title: "Live" }]);
});

test("a failed live lookup is reported, not cached", async () => {
  const store = fakeStore();
  await assert.rejects(getOrFetchResults({ store, key: "k", fetcher: async () => { throw new Error("SerpAPI down"); }, now: NOW }), /SerpAPI down/);
  assert.equal(store.map.size, 0);
});
