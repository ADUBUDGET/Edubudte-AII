// Tests for "Trending Student Deals": only recent, real, approved-supplier
// prices are shown; old or invalid rows are left out.
const test = require("node:test");
const assert = require("node:assert/strict");
const { selectCurrentDeals, DEALS_MAX_AGE_DAYS } = require("../deals");

const NOW = new Date("2026-10-01T12:00:00Z");
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const row = (source, price, age, extra = {}) => ({ query_label: "rice", title: "Rice 2kg", source, extracted_price: price, fetched_at: daysAgo(age), product_id: "p1", ...extra });

test("deals older than the limit are not shown (their prices aren't current)", () => {
  const out = selectCurrentDeals([row("Shoprite", 39.99, 1), row("Shoprite", 29.99, DEALS_MAX_AGE_DAYS + 1)], NOW);
  assert.deepEqual(out.map(d => d.extracted_price), [39.99]);
});

test("only approved suppliers, tagged with their id and standard name", () => {
  const out = selectCurrentDeals([row("Amazon.co.za - Seller", 10, 0), row("Mr Price", 20, 0), row("Checkers Sixty60", 35, 0)], NOW);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].supplier_id, out[0].supplier_name], ["checkers", "Checkers"]);
});

test("rows without a real price are dropped", () => {
  assert.equal(selectCurrentDeals([row("Shoprite", null, 0), row("Shoprite", 0, 0), row("Shoprite", "abc", 0)], NOW).length, 0);
});

test("the real product data is kept as stored", () => {
  const [d] = selectCurrentDeals([row("Makro", 18.95, 0.5, { product_id: "13587375456778672003", thumbnail: "https://img/1", link: "https://google/p" })], NOW);
  assert.equal(d.product_id, "13587375456778672003");
  assert.equal(d.thumbnail, "https://img/1");
  assert.equal(d.extracted_price, 18.95);
});

test("no rows means no deals (the page shows an empty state, never placeholders)", () => {
  assert.deepEqual(selectCurrentDeals([], NOW), []);
});

test("the old hard-coded, non-grocery deal searches are gone", () => {
  const script = require("fs").readFileSync(require("path").join(__dirname, "..", "scripts", "refresh-deals.js"), "utf8");
  assert.ok(!/desk lamp|wireless headphones|laptop stand/.test(script));
  assert.match(script, /FROM search_history/);
});
