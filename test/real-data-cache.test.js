// Cached/saved results must be the real system data: the listing's product
// id, shop, price, picture and the time it was checked - and anything old or
// no longer listed is refreshed or flagged, never shown as current.
const test = require("node:test");
const assert = require("node:assert/strict");
const { mapShoppingResult, availabilityOf, cleanPriceMeta, isValidCachedResults, versionedKey, isCurrentCacheKey } = require("../shopping-results");
const basket = require("../basket");
const sb = require("../smart-basket");
const fav = require("../favourites");

const NOW = new Date("2026-10-01T12:00:00Z");
const hoursAgo = h => new Date(NOW.getTime() - h * 60 * 60 * 1000);
// For code that checks against the real clock (e.g. input validation).
const REAL_NOW = Date.now();
const realHoursAgo = h => new Date(REAL_NOW - h * 60 * 60 * 1000);

// A raw result exactly as SerpAPI returns it today.
const serp = {
  position: 3, title: "Tastic Long Grain Rice 2kg", product_id: "12193149534309090114",
  product_link: "https://www.google.com/search?ibp=oshop&prds=catalogid:12193149534309090114",
  source: "Shoprite", price: "R 39,99", extracted_price: 39.99, old_price: "R 44,99", extracted_old_price: 44.99,
  thumbnail: "https://serpapi.com/images/rice.webp", multiple_sources: true, extensions: ["In stock online"],
};

test("the real listing's fields are kept exactly (id, shop, price, sale price, link, picture, availability)", () => {
  const r = mapShoppingResult(serp);
  assert.deepEqual(r, {
    product_id: "12193149534309090114", title: "Tastic Long Grain Rice 2kg", price: "R 39,99", extracted_price: 39.99,
    old_price: "R 44,99", extracted_old_price: 44.99, source: "Shoprite", link: serp.product_link,
    thumbnail: serp.thumbnail, availability: "in_stock", multiple_sources: true,
  });
  assert.ok(isValidCachedResults([r]));
});

test("availability comes from the listing's own tags", () => {
  assert.equal(availabilityOf({ tag: "Out of stock" }), "out_of_stock");
  assert.equal(availabilityOf({ extensions: ["Sold out"] }), "out_of_stock");
  assert.equal(availabilityOf({ extensions: ["Free delivery"] }), "unknown");
});

test("old-format cache entries and keys are recognised as invalid", () => {
  assert.ok(!isValidCachedResults([{ title: "Rice", extracted_price: 20, source: "Spar" }]));
  assert.ok(!isValidCachedResults(null));
  assert.ok(isCurrentCacheKey(versionedKey("search", "Durban", "rice")));
  for (const legacy of ["rice", "durban:rice", "search:za:rice", "search:durban:rice"]) assert.ok(!isCurrentCacheKey(legacy), legacy);
});

test("price-checked time: real dates kept, future or week-old dates rejected", () => {
  assert.equal(cleanPriceMeta({ priceCheckedAt: hoursAgo(2).toISOString() }, { hasPrice: true, now: NOW }).priceCheckedAt.getTime(), hoursAgo(2).getTime());
  assert.equal(cleanPriceMeta({ priceCheckedAt: hoursAgo(-2).toISOString() }, { hasPrice: true, now: NOW }).priceCheckedAt.getTime(), NOW.getTime());
  assert.equal(cleanPriceMeta({ priceCheckedAt: hoursAgo(24 * 8).toISOString() }, { hasPrice: true, now: NOW }).priceCheckedAt.getTime(), NOW.getTime());
  assert.equal(cleanPriceMeta({}, { hasPrice: false, now: NOW }).priceCheckedAt, null, "no price, no checked time");
  assert.equal(cleanPriceMeta({ productId: " 123 " }).productId, "123");
});

test("adding a Shop result to the basket saves the listing's real id, shop, price and checked time", () => {
  const item = sb.cleanItemInput({
    itemName: serp.title, productTitle: serp.title, supplierId: "shoprite", price: serp.extracted_price,
    productId: serp.product_id, priceCheckedAt: realHoursAgo(1).toISOString(), link: serp.product_link, thumbnail: serp.thumbnail,
  });
  assert.deepEqual(
    [item.productId, item.supplierId, item.storeName, item.price, item.link, item.thumbnail],
    [serp.product_id, "shoprite", "Shoprite", 39.99, serp.product_link, serp.thumbnail]);
  assert.equal(item.priceCheckedAt.getTime(), realHoursAgo(1).getTime());
});

test("saving a favourite keeps the real supplier and product id", () => {
  const f = fav.cleanFavouriteInput({ itemName: serp.title, storeName: "Checkers Sixty60", price: 41, productId: "abc", priceCheckedAt: realHoursAgo(3).toISOString() });
  assert.deepEqual([f.supplierId, f.storeName, f.productId], ["checkers", "Checkers", "abc"]);
  assert.equal(f.priceCheckedAt.getTime(), realHoursAgo(3).getTime());
});

test("basket price status: current, stale (older than 24h or undated), not listed, unknown", () => {
  assert.equal(basket.priceStatusOf({ price: 10, price_checked_at: hoursAgo(2) }, NOW), "current");
  assert.equal(basket.priceStatusOf({ price: 10, price_checked_at: hoursAgo(30) }, NOW), "stale");
  assert.equal(basket.priceStatusOf({ price: 10, price_checked_at: null }, NOW), "stale");
  assert.equal(basket.priceStatusOf({ price: 10, price_checked_at: hoursAgo(1), availability: "not_listed" }, NOW), "not_listed");
  assert.equal(basket.priceStatusOf({ price: null }, NOW), "unknown");
});

test("refresh matches the same listing by product id at the same shop (or by title if no id)", () => {
  const results = [
    { product_id: "A", title: "Rice 2kg", supplierId: "checkers", extracted_price: 38 },
    { product_id: "A", title: "Rice 2kg", supplierId: "shoprite", extracted_price: 40.5 },
    { product_id: "B", title: "Rice 1kg", supplierId: "shoprite", extracted_price: 22 },
  ];
  assert.equal(basket.matchListing({ product_id: "A", supplier_id: "shoprite", product_title: "x" }, results).extracted_price, 40.5);
  assert.equal(basket.matchListing({ product_id: null, supplier_id: "shoprite", product_title: "rice 1KG" }, results).extracted_price, 22);
  assert.equal(basket.matchListing({ product_id: "Z", supplier_id: "spar", product_title: "Rice 2kg" }, results), null, "never another shop's price");
});

function refreshStore(items) {
  const updates = [];
  return {
    updates,
    async getList() { return items; },
    async updateItemPrice(userId, id, u) { updates.push({ id, ...u }); Object.assign(items.find(i => i.id === id), u); },
  };
}

test("Refresh prices replaces stale prices with the real current price and its checked time", async () => {
  const items = [
    { id: 1, item_name: "Rice", product_title: "Rice 2kg", product_id: "A", supplier_id: "shoprite", price: "39.99", price_checked_at: hoursAgo(48) },
    { id: 2, item_name: "Milk", product_title: "Milk 1L", product_id: "M", supplier_id: "checkers", price: "18.99", price_checked_at: hoursAgo(1) }, // current: skipped
    { id: 3, item_name: "Gone", product_title: "Gone item", product_id: "G", supplier_id: "spar", price: "10", price_checked_at: hoursAgo(72) },
    { id: 4, item_name: "Typed", supplier_id: null, price: null }, // nothing to refresh
  ];
  const store = refreshStore(items);
  const fetchedAt = hoursAgo(0.5);
  const lookups = [];
  const lookup = async term => {
    lookups.push(term);
    return { fetchedAt, results: [mapShoppingResult({ product_id: "A", title: "Rice 2kg", extracted_price: 42.49, source: "Shoprite", product_link: "https://g/new", thumbnail: "https://img/new" })] };
  };
  const out = await basket.refreshPrices(store, 1, { lookup, now: NOW });
  assert.deepEqual(lookups, ["Rice 2kg", "Gone item"]);
  assert.deepEqual(out, { checked: 2, changed: 1, confirmed: 0, notListed: 1, failed: 0, skipped: 0 });
  const rice = store.updates.find(u => u.id === 1);
  assert.deepEqual([rice.price, rice.priceCheckedAt, rice.availability, rice.link], [42.49, fetchedAt, "listed", "https://g/new"]);
  assert.deepEqual(store.updates.find(u => u.id === 3), { id: 3, availability: "not_listed" }, "price not invented, just flagged");
});

test("a failed lookup leaves the price alone and is reported", async () => {
  const items = [{ id: 1, item_name: "Rice", supplier_id: "shoprite", price: "39.99", price_checked_at: hoursAgo(48) }];
  const store = refreshStore(items);
  const out = await basket.refreshPrices(store, 1, { lookup: async () => { throw new Error("offline"); }, now: NOW });
  assert.equal(out.failed, 1);
  assert.equal(store.updates.length, 0);
});

test("refresh is capped per request", async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, item_name: "Item " + i, supplier_id: "shoprite", price: "5", price_checked_at: null }));
  const out = await basket.refreshPrices(refreshStore(items), 1, { lookup: async () => ({ results: [], fetchedAt: NOW }), now: NOW, maxItems: 8 });
  assert.equal(out.checked, 8);
  assert.equal(out.skipped, 4);
});

test("GET /api/basket marks each saved price as current or stale and counts stale ones", async () => {
  const items = [
    { id: 1, item_name: "Rice", price: "39.99", quantity: 1, price_checked_at: hoursAgo(2), purchased_at: null },
    { id: 2, item_name: "Milk", price: "18.99", quantity: 1, price_checked_at: hoursAgo(40), purchased_at: null },
  ];
  const routes = basket.createBasketRoutes({ store: { getList: async () => items, getBudgetNumbers: async () => ({ monthlyBudget: 500, totalSpent: 0 }) }, now: () => NOW });
  const res = { body: null, status() { return this; }, json(b) { this.body = b; return this; } };
  await routes.get({ userId: 1 }, res);
  assert.deepEqual(res.body.items.map(i => i.price_status), ["current", "stale"]);
  assert.equal(res.body.totals.stalePriceCount, 1);
  assert.equal(res.body.priceFreshHours, 24);
});
