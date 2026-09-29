// Run with: npm test
// Uses Node's built-in test runner and an in-memory store, so no database,
// API keys or network access are needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const sb = require("../smart-basket");

const NOW = new Date("2026-09-24T12:00:00Z");
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

// Minimal in-memory version of smart-basket-store.js.
function createFakeStore(seed = {}) {
  const data = {
    searches: seed.searches || [],
    purchases: seed.purchases || [],
    popular: seed.popular || [],
    specials: seed.specials || [],
    cache: new Map(Object.entries(seed.cache || {})),
    states: new Map(),
    list: [],
    nextId: 1,
  };
  const key = (u, k) => `${u}:${k}`;
  return {
    data,
    async getSearchSignals() { return data.searches; },
    async getPurchaseSignals() { return data.purchases; },
    async getListHistorySignals(userId) {
      return data.list.filter(r => r.user_id === userId && r.purchased_at)
        .map(r => ({ name: r.item_name, count: 1, lastAt: r.purchased_at }));
    },
    async getActiveListKeys(userId) {
      return data.list.filter(r => r.user_id === userId && !r.purchased_at).map(r => r.item_key);
    },
    async getStates(userId) {
      return [...data.states.values()].filter(s => s.user_id === userId);
    },
    async getPopularSearches() { return data.popular; },
    async getActiveSpecials() { return data.specials; },
    async getCachedPrices(k) { return data.cache.get(k) || null; },
    async saveCachedPrices(k, results) { data.cache.set(k, { results, fetchedAt: NOW }); },
    async upsertState(userId, s) {
      data.states.set(key(userId, s.itemKey), { user_id: userId, item_key: s.itemKey, item_name: s.itemName, status: s.status, skipped_until: s.skippedUntil });
    },
    async deleteState(userId, itemKey) { data.states.delete(key(userId, itemKey)); },
    async getHidden(userId) {
      return [...data.states.values()].filter(s => s.user_id === userId && s.status === "hidden");
    },
    async getRemainingBudget() { return 500; },
    async findActiveListItem(userId, itemKey) {
      return data.list.find(r => r.user_id === userId && r.item_key === itemKey && !r.purchased_at) || null;
    },
    async insertListItem(userId, item) {
      // Mirrors the partial unique index grocery_list_active_item_idx.
      if (data.list.some(r => r.user_id === userId && r.item_key === item.itemKey && !r.purchased_at)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      const row = { id: data.nextId++, user_id: userId, item_name: item.itemName, item_key: item.itemKey, supplier_id: item.supplierId ?? null,
        store_name: item.storeName, price: item.price, quantity: item.quantity ?? 1, unit: item.unit ?? null, category: item.category ?? null, purchased_at: null };
      data.list.push(row);
      return row;
    },
    async mergeListItem(userId, id, m) {
      const row = data.list.find(r => r.id === id && r.user_id === userId);
      const map = { supplierId: "supplier_id", storeName: "store_name", price: "price", productTitle: "product_title", link: "link", thumbnail: "thumbnail", unit: "unit", quantity: "quantity" };
      for (const [k, col] of Object.entries(map)) if (k in m) row[col] = m[k] ?? null;
      return row;
    },
    async setQuantity(userId, id, quantity) {
      const row = data.list.find(r => r.id === Number(id) && r.user_id === userId && !r.purchased_at);
      if (row) row.quantity = quantity;
      return row || null;
    },
    async setPurchased(userId, id, purchased) {
      const row = data.list.find(r => r.id === Number(id) && r.user_id === userId);
      if (row) row.purchased_at = purchased ? NOW : null;
      return row || null;
    },
  };
}

// ---------------------------------------------------------------
// Recommendation building and filtering
// ---------------------------------------------------------------
test("normaliseKey treats spacing, case and punctuation as the same item", () => {
  assert.equal(sb.normaliseKey("  Brown   Bread! "), "brown bread");
  assert.equal(sb.normaliseKey("BROWN-bread"), "brown bread");
});

test("ranks purchases above searches and explains why", () => {
  const out = sb.buildPersonalCandidates({
    searches: [{ name: "rice", count: 2, lastAt: daysAgo(1) }],
    purchases: [{ name: "Milk", category: "Food", count: 2, lastAt: daysAgo(1) }],
    now: NOW,
  });
  assert.deepEqual(out.map(c => c.itemKey), ["milk", "rice"]);
  assert.match(out[0].reasons[0], /logged buying this 2 times/);
  assert.match(out[1].reasons[0], /searched for this 2 times/);
});

test("a single search is not yet 'regular', two searches are", () => {
  const out = sb.buildPersonalCandidates({
    searches: [
      { name: "headphones", count: 1, lastAt: daysAgo(1) },
      { name: "rice", count: 2, lastAt: daysAgo(1) },
    ],
    now: NOW,
  });
  assert.deepEqual(out.map(c => c.itemKey), ["rice"]);
});

test("recent activity outranks the same activity months ago", () => {
  const out = sb.buildPersonalCandidates({
    searches: [
      { name: "pasta", count: 3, lastAt: daysAgo(120) },
      { name: "eggs", count: 3, lastAt: daysAgo(2) },
    ],
    now: NOW,
  });
  assert.deepEqual(out.map(c => c.itemKey), ["eggs", "pasta"]);
});

test("merges the same item across signals and ignores non-product purchases", () => {
  const out = sb.buildPersonalCandidates({
    searches: [{ name: "Peanut butter", count: 1, lastAt: daysAgo(3) }],
    purchases: [
      { name: "peanut butter", category: "Food", count: 1, lastAt: daysAgo(5) },
      { name: "Uber to campus", category: "Transport", count: 4, lastAt: daysAgo(1) },
      { name: "groceries", category: "Food", count: 6, lastAt: daysAgo(1) },
    ],
    now: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].itemKey, "peanut butter");
  assert.equal(out[0].name, "Peanut butter"); // most recent wording wins
  assert.equal(out[0].reasons.length, 2);
});

test("filters hidden items, items skipped within the cooldown, and items already on the list", () => {
  const candidates = ["milk", "rice", "eggs", "bread", "pasta"].map(k => ({ itemKey: k, name: k }));
  const out = sb.filterCandidates(candidates, {
    states: [
      { item_key: "milk", status: "hidden", skipped_until: null },
      { item_key: "rice", status: "skipped", skipped_until: daysAgo(-1) }, // still cooling down
      { item_key: "eggs", status: "skipped", skipped_until: daysAgo(1) },  // cooldown over
    ],
    activeListKeys: ["bread"],
    now: NOW,
  });
  assert.deepEqual(out.map(c => c.itemKey), ["eggs", "pasta"]);
});

test("new users get popular terms, then staples, never duplicates", () => {
  const { suggestions, personalised } = sb.composeSuggestions({
    personal: [],
    popular: [{ name: "Rice" }, { name: "Two minute noodles" }],
    now: NOW,
    limit: 5,
  });
  assert.equal(personalised, false);
  assert.equal(suggestions.length, 5);
  assert.deepEqual(suggestions.slice(0, 2).map(s => s.source), ["popular", "popular"]);
  assert.ok(suggestions.slice(2).every(s => s.source === "staple"));
  const keys = suggestions.map(s => s.itemKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.slice(2).includes("rice"));
});

test("users with enough history get only personal suggestions", () => {
  const personal = ["a1", "b2", "c3"].map(k => ({ itemKey: k, name: k, source: "personal", reasons: [] }));
  const { suggestions, personalised } = sb.composeSuggestions({ personal, popular: [{ name: "Rice" }], now: NOW });
  assert.equal(personalised, true);
  assert.deepEqual(suggestions.map(s => s.source), ["personal", "personal", "personal"]);
});

test("fallback suggestions also respect hidden items", () => {
  const { suggestions } = sb.composeSuggestions({
    personal: [],
    states: [{ item_key: "eggs", status: "hidden" }],
    now: NOW,
    limit: 20,
  });
  assert.ok(!suggestions.some(s => s.itemKey === "eggs"));
});

// ---------------------------------------------------------------
// Cheapest price selection
// ---------------------------------------------------------------
test("titleMatches requires every word and handles plurals", () => {
  assert.ok(sb.titleMatches("eggs", "Nulaid Large Egg 18 pack"));
  assert.ok(sb.titleMatches("Brown bread", "Albany Superior Brown Bread 700g"));
  assert.ok(!sb.titleMatches("Brown bread", "Albany White Bread 700g"));
  assert.ok(!sb.titleMatches("", "anything"));
});

test("parseSize reads pack sizes from titles", () => {
  assert.equal(sb.parseSize("Clover Full Cream Milk 2L"), "2L");
  assert.equal(sb.parseSize("Coca-Cola 6 x 330ml"), "6 x 330ml");
  assert.equal(sb.parseSize("Tastic Rice 2kg"), "2kg");
  assert.equal(sb.parseSize("Nulaid Eggs 18 pack"), "18 pack");
  assert.equal(sb.parseSize("Twinsaver 9 Rolls"), "9 rolls");
  assert.equal(sb.parseSize("Albany 3 large"), null);
});

test("pickCheapest chooses the lowest relevant price and compares with another store", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "Milk frother", extracted_price: 9.99, source: "Takealot" },     // cheapest, but not Clover 2L milk
      { title: "Clover Milk 2L", extracted_price: 32.99, source: "Checkers" },
      { title: "Clover Milk 2L", extracted_price: 29.99, source: "Shoprite" },
      { title: "Clover Milk 2L", extracted_price: 30.49, source: "Shoprite" },
      { title: "Parmalat Milk 1L", extracted_price: null, source: "Spar" },      // no price
    ],
  });
  const best = sb.pickCheapest("clover milk 2l", offers);
  assert.equal(best.price, 29.99);
  assert.equal(best.store, "Shoprite");
  assert.equal(best.size, "2L");
  assert.deepEqual(best.nextCheapest, { store: "Checkers", price: 32.99 });
  assert.equal(best.savingVsNext, 3);
  assert.equal(best.storesCompared, 2);
});

test("pickCheapest ignores listings that don't match the item", () => {
  const offers = sb.toOffers({ shoppingResults: [{ title: "Bread bin", extracted_price: 15, source: "Mr Price Home" }] });
  assert.equal(sb.pickCheapest("brown bread", offers), null);
});

test("pickCheapest includes store specials and reports the special's saving", () => {
  const offers = sb.toOffers({
    shoppingResults: [{ title: "Tastic Rice 2kg", extracted_price: 49.99, source: "Checkers" }],
    specials: [{ store: "Shoprite", item: "Tastic Rice 2kg", price: "39.99", was_price: "49.99", ends_on: "2026-09-30" }],
  });
  const best = sb.pickCheapest("rice", offers);
  assert.equal(best.kind, "special");
  assert.equal(best.store, "Shoprite");
  assert.equal(best.wasPrice, 49.99);
  assert.equal(best.savingVsNext, 10);
});

test("pickCheapest returns null rather than inventing a price", () => {
  assert.equal(sb.pickCheapest("rice", []), null);
});

test("priceItem uses the cache, limits live lookups, and never guesses", async () => {
  const store = createFakeStore({
    cache: { "durban:rice": { results: [{ title: "Rice 2kg", extracted_price: 40, source: "Spar" }], fetchedAt: daysAgo(0.5) } },
  });
  let liveCalls = 0;
  const fetchShopping = async () => { liveCalls++; return [{ title: "Pasta 500g", extracted_price: 18, source: "Boxer" }]; };
  const budget = { live: 1 };
  const ctx = { store, fetchShopping, specials: [], budget, now: NOW };

  const rice = await sb.priceItem("Rice", ctx);           // fresh cache: no live call
  const pasta = await sb.priceItem("Pasta", ctx);         // uses the one live lookup
  const eggs = await sb.priceItem("Eggs", ctx);           // no quota left

  assert.equal(liveCalls, 1);
  assert.equal(rice.price.price, 40);
  assert.equal(pasta.price.store, "Boxer");
  assert.ok(store.data.cache.has("durban:pasta"));
  assert.equal(eggs.price, null);
  assert.equal(eggs.priceStatus, "not_checked");
});

test("priceItem reports a failed lookup as an error, not a price", async () => {
  const store = createFakeStore();
  const fetchShopping = async () => { throw new Error("SerpAPI down"); };
  const out = await sb.priceItem("Rice", { store, fetchShopping, specials: [], budget: { live: 1 }, now: NOW });
  assert.equal(out.price, null);
  assert.equal(out.priceStatus, "error");
});

// ---------------------------------------------------------------
// Swipe actions: add (right), skip (left), hide (up)
// ---------------------------------------------------------------
test("swipe right adds to the grocery list and removes the card from suggestions", async () => {
  const store = createFakeStore({ searches: [{ name: "Rice", count: 3, lastAt: daysAgo(1) }] });
  const result = await sb.addItemToList(store, 1, { itemName: "Rice", price: 39.99, storeName: "Shoprite", addedFrom: "smart_basket" });
  assert.equal(result.alreadyExisted, false);
  assert.equal(store.data.list.length, 1);

  const { suggestions } = await sb.loadSuggestions(store, 1, NOW);
  assert.ok(!suggestions.some(s => s.itemKey === "rice"));
});

test("adding the same product from the same shop increases the quantity", async () => {
  const store = createFakeStore();
  await sb.addItemToList(store, 1, { itemName: "Brown Bread", price: 18, storeName: "Spar", quantity: 2 });
  const again = await sb.addItemToList(store, 1, { itemName: "brown  bread!", price: 17.5, supplierId: "spar" });
  assert.equal(again.alreadyExisted, true);
  assert.equal(again.merge, "quantity");
  assert.equal(store.data.list.length, 1);
  assert.equal(store.data.list[0].quantity, 3);
  assert.equal(store.data.list[0].price, 17.5, "latest price kept");
});

test("adding the same product from another shop switches shop and price, keeping one line", async () => {
  const store = createFakeStore();
  await sb.addItemToList(store, 1, { itemName: "Brown Bread", price: 18, storeName: "Spar" });
  const again = await sb.addItemToList(store, 1, { itemName: "Brown bread", price: 16.5, storeName: "Shoprite" });
  assert.equal(again.merge, "switched");
  assert.equal(store.data.list.length, 1);
  assert.equal(store.data.list[0].store_name, "Shoprite");
  assert.equal(store.data.list[0].supplier_id, "shoprite");
  assert.equal(store.data.list[0].price, 16.5);
  assert.equal(store.data.list[0].quantity, 2);
});

test("quantity is capped at 99 when merging", async () => {
  const store = createFakeStore();
  await sb.addItemToList(store, 1, { itemName: "Eggs", quantity: 98 });
  await sb.addItemToList(store, 1, { itemName: "Eggs", quantity: 5 });
  assert.equal(store.data.list[0].quantity, 99);
});

test("basket input is validated: quantity, approved shops, sensible defaults", async () => {
  const store = createFakeStore();
  for (const bad of [{ itemName: "Rice", quantity: 0 }, { itemName: "Rice", quantity: 1.5 }, { itemName: "Rice", quantity: 100 },
    { itemName: "Rice", storeName: "Desertcart.ae" }, { itemName: "Rice", supplierId: "nope" }]) {
    await assert.rejects(sb.addItemToList(store, 1, bad), { status: 400 }, JSON.stringify(bad));
  }
  const { item } = await sb.addItemToList(store, 1, { itemName: "Tastic Rice", productTitle: "Tastic Long Grain Rice 2kg", storeName: "PnP" });
  assert.equal(item.store_name, "Pick n Pay");
  assert.equal(item.unit, "2kg");
  assert.equal(item.category, "Pantry");
  assert.equal(item.quantity, 1);
});

test("quantity can be changed on basket items but not on bought ones", async () => {
  const store = createFakeStore();
  const { item } = await sb.addItemToList(store, 1, { itemName: "Milk" });
  assert.equal((await sb.setItemQuantity(store, 1, item.id, 4)).quantity, 4);
  await assert.rejects(sb.setItemQuantity(store, 1, item.id, 0), { status: 400 });
  await store.setPurchased(1, item.id, true);
  assert.equal(await sb.setItemQuantity(store, 1, item.id, 2), null);
  assert.equal(await sb.setItemQuantity(store, 2, item.id, 2), null, "other users can't change it");
});

test("duplicate prevention still works when two adds race past the first check", async () => {
  const store = createFakeStore();
  await sb.addItemToList(store, 1, { itemName: "Milk" });
  const realFind = store.findActiveListItem;
  let first = true;
  store.findActiveListItem = async (...args) => (first ? ((first = false), null) : realFind(...args));
  const result = await sb.addItemToList(store, 1, { itemName: "Milk" });
  assert.equal(result.alreadyExisted, true);
  assert.equal(store.data.list.length, 1);
});

test("an item can be re-added once the earlier one is ticked off", async () => {
  const store = createFakeStore();
  const { item } = await sb.addItemToList(store, 1, { itemName: "Milk" });
  await store.setPurchased(1, item.id, true);
  const again = await sb.addItemToList(store, 1, { itemName: "Milk" });
  assert.equal(again.alreadyExisted, false);
  assert.equal(store.data.list.length, 2);
});

test("lists are per user", async () => {
  const store = createFakeStore();
  await sb.addItemToList(store, 1, { itemName: "Milk" });
  const other = await sb.addItemToList(store, 2, { itemName: "Milk" });
  assert.equal(other.alreadyExisted, false);
});

test("adding without a name is rejected", async () => {
  await assert.rejects(sb.addItemToList(createFakeStore(), 1, { itemName: "  " }), { status: 400 });
});

test("swipe left skips an item for the cooldown, then it becomes eligible again", async () => {
  const store = createFakeStore({ searches: [{ name: "Rice", count: 3, lastAt: daysAgo(1) }] });
  const { skippedUntil } = await sb.setSuggestionState(store, 1, { itemName: "Rice" }, "skipped", NOW);
  assert.equal(skippedUntil.getTime() - NOW.getTime(), sb.SKIP_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

  const soon = await sb.loadSuggestions(store, 1, new Date(NOW.getTime() + 60 * 60 * 1000));
  assert.ok(!soon.suggestions.some(s => s.itemKey === "rice"));

  const later = await sb.loadSuggestions(store, 1, new Date(skippedUntil.getTime() + 1000));
  assert.ok(later.suggestions.some(s => s.itemKey === "rice"));
});

test("swipe up hides an item permanently until the user restores it", async () => {
  const store = createFakeStore({ searches: [{ name: "Rice", count: 3, lastAt: daysAgo(1) }] });
  await sb.setSuggestionState(store, 1, { itemName: "Rice" }, "hidden", NOW);

  const muchLater = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000);
  const hidden = await sb.loadSuggestions(store, 1, muchLater);
  assert.ok(!hidden.suggestions.some(s => s.itemKey === "rice"));
  assert.equal((await store.getHidden(1)).length, 1);

  await store.deleteState(1, "rice");
  const restored = await sb.loadSuggestions(store, 1, NOW);
  assert.ok(restored.suggestions.some(s => s.itemKey === "rice"));
});

test("hiding one user's item doesn't affect another user", async () => {
  const store = createFakeStore({ searches: [{ name: "Rice", count: 3, lastAt: daysAgo(1) }] });
  await sb.setSuggestionState(store, 1, { itemName: "Rice" }, "hidden", NOW);
  const other = await sb.loadSuggestions(store, 2, NOW);
  assert.ok(other.suggestions.some(s => s.itemKey === "rice"));
});

// ---------------------------------------------------------------
// Route wiring
// ---------------------------------------------------------------
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send() { return this; },
  };
}

test("GET /api/smart-basket returns priced cards with reasons", async () => {
  const store = createFakeStore({
    searches: [{ name: "Rice", count: 4, lastAt: daysAgo(1) }],
    specials: [{ store: "Shoprite", item: "Tastic Rice 2kg", price: "39.99", was_price: "49.99", ends_on: "2026-09-30" }],
  });
  const routes = sb.createSmartBasketRoutes({ store, fetchShopping: async () => [], now: () => NOW });
  const res = fakeRes();
  await routes.getSuggestions({ userId: 1 }, res);

  assert.equal(res.statusCode, 200);
  const rice = res.body.suggestions.find(s => s.itemKey === "rice");
  assert.equal(rice.source, "personal");
  assert.equal(rice.priceStatus, "ok");
  assert.equal(rice.price.store, "Shoprite");
  assert.equal(res.body.remainingBudget, 500);
});

test("POST /api/grocery-list answers 201 for new items and 200 for duplicates", async () => {
  const routes = sb.createSmartBasketRoutes({ store: createFakeStore(), now: () => NOW });
  const first = fakeRes();
  await routes.addToList({ userId: 1, body: { itemName: "Eggs" } }, first);
  const second = fakeRes();
  await routes.addToList({ userId: 1, body: { itemName: "eggs" } }, second);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.alreadyExisted, true);
});

test("skip/hide endpoints validate input", async () => {
  const routes = sb.createSmartBasketRoutes({ store: createFakeStore(), now: () => NOW });
  const res = fakeRes();
  await routes.hide({ userId: 1, body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test("titleMatches skips accessories unless the student asked for one", () => {
  assert.ok(!sb.titleMatches("milk", "Electric Milk Frother"));
  assert.ok(!sb.titleMatches("bread", "Stainless Steel Bread Bin"));
  assert.ok(sb.titleMatches("milk frother", "Electric Milk Frother"));
  assert.ok(sb.titleMatches("milk", "Clover Full Cream Milk 2L"));
});

test("grocery list routes accept numeric ids and 404 anything else", async () => {
  const store = createFakeStore();
  const { item } = await sb.addItemToList(store, 1, { itemName: "Milk" });
  const routes = sb.createSmartBasketRoutes({ store, now: () => NOW });

  const ok = fakeRes();
  await routes.updateListItem({ userId: 1, params: { id: String(item.id) }, body: { purchased: true } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.body.purchased_at);

  const bad = fakeRes();
  await routes.updateListItem({ userId: 1, params: { id: "abc" }, body: { purchased: true } }, bad);
  assert.equal(bad.statusCode, 404);

  const otherUser = fakeRes();
  await routes.updateListItem({ userId: 2, params: { id: String(item.id) }, body: { purchased: false } }, otherUser);
  assert.equal(otherUser.statusCode, 404);
});

// ---------------------------------------------------------------
// South African retailers and price outliers
// ---------------------------------------------------------------
test("only approved suppliers count (see suppliers.test.js for the full list)", () => {
  for (const s of ["Shoprite", "Checkers Sixty60", "Pick n Pay Online", "makro.co.za", "SPAR", "Food Lover's Market", "Dis-Chem", "Woolworths"]) {
    assert.ok(sb.matchSupplier(s), s);
  }
  for (const s of ["Musafir Cash & Carry", "Desertcart.ae", "Sparkle Deals", "Takealot", "IndiaBazaar.co.za"]) {
    assert.equal(sb.matchSupplier(s), null, s);
  }
});

test("drops a listing priced far below the others (e.g. R0.90 rice)", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "Spekko Parboiled Rice (10 x 500g)", extracted_price: 0.9, source: "Musafir Cash & Carry" },
      { title: "Econo White Parboiled Rice 500g", extracted_price: 8.95, source: "makro.co.za" },
      { title: "White Rice 1kg", extracted_price: 14.99, source: "Spice World" },
      { title: "Tastic Parboiled Rice 1kg", extracted_price: 24.99, source: "Shoprite" },
    ],
  });
  const best = sb.pickCheapest("rice", offers);
  assert.equal(best.price, 8.95);
  assert.equal(best.store, "Makro"); // shown under the supplier's standard name
  assert.equal(best.supplierId, "makro");
});

test("brown bread: R5 outlier is ignored and a Shoprite price wins over other stores", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "Standard Brown Bread 600g", extracted_price: 5, source: "Shoprite" },
      { title: "Sasko Low GI Wholewheat Brown Bread 800g", extracted_price: 28.99, source: "Shoprite" },
      { title: "Sasko Brown Low GI Seeded Bread", extracted_price: 32, source: "Impala Vleis" },
      { title: "Lamb Curry Toast Brown Bread", extracted_price: 91, source: "Delivery 24" },
    ],
  });
  const best = sb.pickCheapest("brown bread", offers);
  assert.equal(best.price, 28.99);
  assert.equal(best.store, "Shoprite");
});

test("prefers SA retailers even when another store is cheaper", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "Peanut Butter 400g", extracted_price: 29.99, source: "International Food Group" },
      { title: "Black Cat Peanut Butter 400g", extracted_price: 36.99, source: "Checkers" },
      { title: "Black Cat Peanut Butter 400g", extracted_price: 38.49, source: "Pick n Pay" },
    ],
  });
  const best = sb.pickCheapest("peanut butter", offers);
  assert.equal(best.store, "Checkers");
  assert.deepEqual(best.nextCheapest, { store: "Pick n Pay", price: 38.49 });
  assert.equal(best.storesCompared, 2);
});

test("never falls back to foreign shops or non-grocery listings", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "La Molisana Pasta Anellini", extracted_price: 236.77, source: "Desertcart.ae" },
      { title: "Bob the Builder: Pilchard Steals", extracted_price: 75.95, source: "World of Books" },
    ],
  });
  assert.equal(sb.pickCheapest("pasta", offers), null);
  assert.equal(sb.pickCheapest("pilchards", offers), null);
});

test("unapproved .co.za shops and marketplaces are not used for prices", () => {
  const offers = sb.toOffers({ shoppingResults: [
    { title: "Basmati Rice 1kg", extracted_price: 39, source: "IndiaBazaar.co.za" },
    { title: "Basmati Rice 1kg", extracted_price: 35, source: "amazon.co.za" },
  ] });
  assert.equal(sb.pickCheapest("rice", offers), null);
});

test("with a nearby filter, only suppliers inside the radius are compared", () => {
  const offers = sb.toOffers({ shoppingResults: [
    { title: "Tastic Rice 2kg", extracted_price: 39.99, source: "Makro" },
    { title: "Tastic Rice 2kg", extracted_price: 44.99, source: "Shoprite" },
    { title: "Tastic Rice 2kg", extracted_price: 46.99, source: "Checkers" },
  ] });
  const best = sb.pickCheapest("rice", offers, { nearbySupplierIds: new Set(["shoprite", "checkers"]) });
  assert.equal(best.store, "Shoprite");
  assert.deepEqual(best.nextCheapest, { store: "Checkers", price: 46.99 });
  assert.equal(sb.pickCheapest("rice", offers, { nearbySupplierIds: new Set() }), null);
});

test("product links come from SerpAPI's product_link", () => {
  const [offer] = sb.toOffers({ shoppingResults: [{ title: "Rice", extracted_price: 20, source: "Shoprite", product_link: "https://www.google.com/search?ibp=oshop&prds=catalogid:1" }] });
  assert.match(offer.link, /catalogid:1/);
});

test("outlier check compares against the next cheapest SA listing", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "Pasta 500g", extracted_price: 18.99, source: "Shoprite" },
      { title: "Pasta Screws 500g", extracted_price: 18.95, source: "Makro" },
      { title: "Corn Pasta 500g", extracted_price: 82.99, source: "Dis-Chem" },
    ],
  });
  const best = sb.pickCheapest("pasta", offers);
  assert.equal(best.price, 18.95);
  assert.deepEqual(best.nextCheapest, { store: "Shoprite", price: 18.99 });
});

test("store specials are never treated as outliers", () => {
  const offers = sb.toOffers({
    shoppingResults: [
      { title: "Rice 2kg", extracted_price: 45, source: "Checkers" },
      { title: "Rice 2kg", extracted_price: 48, source: "Spar" },
      { title: "Rice 2kg", extracted_price: 50, source: "Pick n Pay" },
    ],
    specials: [{ store: "Shoprite", item: "Rice 2kg", price: "12.99", was_price: "44.99", ends_on: "2026-10-01" }],
  });
  assert.equal(sb.pickCheapest("rice", offers).price, 12.99);
});

test("titleMatches copes with run-together words but not short prefixes", () => {
  assert.ok(sb.titleMatches("baked beans", "Baked Beansin Tomato Sauce 400G"));
  assert.ok(!sb.titleMatches("eggs", "Fresh Eggplant 1kg"));
  assert.ok(!sb.titleMatches("rice", "Best price on pasta"));
});
