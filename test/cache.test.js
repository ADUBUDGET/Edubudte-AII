// Tests for the browser cache in public/shared.js (createApiCache), run in
// Node with an in-memory stand-in for localStorage.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiCache, EB_MAX_AGE } = require("../public/shared.js");

function memoryStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    map,
    failWrites,
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      if (this.failWrites) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: k => map.delete(k),
  };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

test("stores and returns data with its age for the signed-in user", () => {
  const c = clock();
  const cache = createApiCache(memoryStorage(), c.now);
  cache.setOwner(7);
  cache.set("/api/favourites", [{ id: 1 }]);
  c.advance(5000);
  const hit = cache.get("/api/favourites");
  assert.deepEqual(hit.data, [{ id: 1 }]);
  assert.equal(hit.ageMs, 5000);
});

test("nothing is cached or returned before a user is known", () => {
  const storage = memoryStorage();
  const cache = createApiCache(storage);
  cache.set("/api/favourites", [1]);
  assert.equal(cache.get("/api/favourites"), null);
  assert.equal(storage.map.size, 0);
});

test("a different student signing in wipes the previous student's data", () => {
  const storage = memoryStorage();
  const cache = createApiCache(storage);
  cache.setOwner(1);
  cache.set("/api/budget", { secret: "student 1 spending" });
  cache.setOwner(2);
  assert.equal(cache.get("/api/budget"), null);
  assert.ok(![...storage.map.values()].some(v => v.includes("student 1")));
});

test("the same student signing in again keeps their cache", () => {
  const storage = memoryStorage();
  createApiCache(storage).setOwner(5);
  const first = createApiCache(storage);
  first.setOwner(5);
  first.set("/api/favourites", ["x"]);
  const reopened = createApiCache(storage);
  reopened.setOwner(5);
  assert.deepEqual(reopened.get("/api/favourites").data, ["x"]);
});

test("offline, the last signed-in student's data can be resumed", () => {
  const storage = memoryStorage();
  const online = createApiCache(storage);
  online.setOwner(9);
  online.set("/api/auth/me", { id: 9, name: "Thandi" });
  const offline = createApiCache(storage);
  offline.resumeLastOwner();
  assert.equal(offline.get("/api/auth/me").data.name, "Thandi");
});

test("clear() (logout) removes every cached entry and the owner", () => {
  const storage = memoryStorage();
  storage.setItem("unrelated-app-setting", "keep me");
  const cache = createApiCache(storage);
  cache.setOwner(3);
  cache.set("/api/favourites", [1]);
  cache.set("/api/grocery-list", [2]);
  cache.clear();
  assert.deepEqual([...storage.map.keys()], ["unrelated-app-setting"]);
  assert.equal(cache.get("/api/favourites"), null);
});

test("changing favourites clears cached favourites only", () => {
  const cache = createApiCache(memoryStorage());
  cache.setOwner(1);
  cache.set("/api/favourites", [1]);
  cache.set("/api/grocery-list", [2]);
  cache.invalidateFor("/api/favourites/12");
  assert.equal(cache.get("/api/favourites"), null);
  assert.ok(cache.get("/api/grocery-list"));
});

test("logging a purchase clears budget, dashboard, analytics and Smart Basket caches", () => {
  const cache = createApiCache(memoryStorage());
  cache.setOwner(1);
  for (const url of ["/api/budget", "/api/dashboard", "/api/analytics", "/api/smart-basket", "/api/smart-basket/hidden", "/api/favourites"]) {
    cache.set(url, {});
  }
  cache.invalidateFor("/api/budget");
  for (const url of ["/api/budget", "/api/dashboard", "/api/analytics", "/api/smart-basket", "/api/smart-basket/hidden"]) {
    assert.equal(cache.get(url), null, url);
  }
  assert.ok(cache.get("/api/favourites"));
});

test("a new search refreshes the frequently-searched list", () => {
  const cache = createApiCache(memoryStorage());
  cache.setOwner(1);
  cache.set("/api/search/frequent", { items: [] });
  cache.invalidateFor("/api/search");
  assert.equal(cache.get("/api/search/frequent"), null);
});

test("updating the grocery list clears the list and Smart Basket suggestions", () => {
  const cache = createApiCache(memoryStorage());
  cache.setOwner(1);
  cache.set("/api/grocery-list", []);
  cache.set("/api/smart-basket", {});
  cache.invalidateFor("/api/grocery-list/4");
  assert.equal(cache.get("/api/grocery-list"), null);
  assert.equal(cache.get("/api/smart-basket"), null);
});

test("prices expire much sooner than they could be mistaken for current", () => {
  assert.ok(EB_MAX_AGE.prices <= 15 * 60 * 1000);
});

test("keeps at most 60 entries, dropping the oldest", () => {
  const c = clock();
  const cache = createApiCache(memoryStorage(), c.now);
  cache.setOwner(1);
  for (let i = 0; i < 65; i++) {
    cache.set("/api/item/" + i, i);
    c.advance(1);
  }
  assert.equal(cache.get("/api/item/0"), null);
  assert.equal(cache.get("/api/item/64").data, 64);
});

test("broken or unreadable entries are ignored, not thrown", () => {
  const storage = memoryStorage();
  const cache = createApiCache(storage);
  cache.setOwner(1);
  storage.map.set("eb-cache:1:/api/favourites", "{not json");
  assert.equal(cache.get("/api/favourites"), null);
});

test("a full or blocked storage never breaks the page", () => {
  const storage = memoryStorage();
  const cache = createApiCache(storage);
  cache.setOwner(1);
  storage.failWrites = true;
  assert.doesNotThrow(() => cache.set("/api/favourites", [1]));
  assert.equal(cache.get("/api/favourites"), null);
});

test("confirming a purchase refreshes the basket, budget, dashboard and analytics", () => {
  const cache = createApiCache(memoryStorage());
  cache.setOwner(1);
  for (const url of ["/api/basket", "/api/grocery-list", "/api/budget", "/api/dashboard", "/api/analytics", "/api/favourites"]) cache.set(url, {});
  cache.invalidateFor("/api/basket/checkout");
  for (const url of ["/api/basket", "/api/grocery-list", "/api/budget", "/api/dashboard", "/api/analytics"]) {
    assert.equal(cache.get(url), null, url);
  }
  assert.ok(cache.get("/api/favourites"));
});

test("basket changes and a new shopping area clear the right caches", () => {
  const cache = createApiCache(memoryStorage());
  cache.setOwner(1);
  cache.set("/api/basket", {});
  cache.set("/api/location", {});
  cache.set("/api/smart-basket", {});
  cache.invalidateFor("/api/grocery-list/9");
  assert.equal(cache.get("/api/basket"), null);
  cache.set("/api/smart-basket", {});
  cache.invalidateFor("/api/location");
  assert.equal(cache.get("/api/location"), null);
  assert.equal(cache.get("/api/smart-basket"), null, "suggestions are re-priced for the new area");
});
