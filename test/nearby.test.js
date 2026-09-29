// Tests for nearby-shop sorting, distance filtering and the shopping area.
const test = require("node:test");
const assert = require("node:assert/strict");
const nearby = require("../nearby");
const { createLocationService, createLocationRoutes } = require("../location");

// Durban CBD, Musgrave (~3 km away) and Pietermaritzburg (~70 km away).
const DURBAN = { lat: -29.858, lng: 31.029 };
const MUSGRAVE = { lat: -29.845, lng: 31.0 };
const PMB = { lat: -29.6, lng: 30.38 };

test("haversine distances are sensible", () => {
  const d = nearby.haversineKm(DURBAN.lat, DURBAN.lng, MUSGRAVE.lat, MUSGRAVE.lng);
  assert.ok(d > 2 && d < 4, String(d));
  const far = nearby.haversineKm(DURBAN.lat, DURBAN.lng, PMB.lat, PMB.lng);
  assert.ok(far > 60 && far < 80, String(far));
});

test("invalid location data is rejected", () => {
  assert.ok(nearby.validCoords(DURBAN.lat, DURBAN.lng));
  assert.ok(!nearby.validCoords(0, 0));
  assert.ok(!nearby.validCoords(51.5, -0.12)); // London
  assert.ok(!nearby.validCoords("abc", 31));
  assert.ok(!nearby.validCoords(null, undefined));
});

test("radius is clamped to a sensible range", () => {
  assert.equal(nearby.clampRadius(0), 1);
  assert.equal(nearby.clampRadius(5000), 200);
  assert.equal(nearby.clampRadius("abc"), 15);
  assert.equal(nearby.clampRadius(12.4), 12);
});

test("distance labels read naturally", () => {
  assert.equal(nearby.formatDistance(0.83), "850 m away");
  assert.equal(nearby.formatDistance(2.43), "2.4 km away");
  assert.equal(nearby.formatDistance(32.4), "32 km away");
  assert.equal(nearby.formatDistance(null), "Distance unknown");
});

test("nearest branch ignores invalid coordinates", () => {
  const near = nearby.nearestBranch([
    { name: "Bad", lat: 0, lng: 0 },
    { name: "PMB", ...PMB },
    { name: "Musgrave", ...MUSGRAVE },
  ], DURBAN);
  assert.equal(near.branch.name, "Musgrave");
});

test("nearby shops first (cheapest first), then farther (closest first), then unknown", () => {
  const sorted = nearby.sortNearbyFirst([
    { title: "A", extracted_price: 10, distanceKm: 40 },
    { title: "B", extracted_price: 30, distanceKm: 3 },
    { title: "C", extracted_price: 20, distanceKm: 5 },
    { title: "D", extracted_price: 5, distanceKm: null },
    { title: "E", extracted_price: 12, distanceKm: 25 },
  ], 15);
  assert.deepEqual(sorted.map(r => `${r.title}:${r.proximity}`), ["C:nearby", "B:nearby", "E:far", "A:far", "D:unknown"]);
  assert.deepEqual(sorted.filter(r => r.cheapestNearby).map(r => r.title), ["C"]);
});

test("a cheaper shop outside the radius is not 'cheapest nearby'", () => {
  const sorted = nearby.sortNearbyFirst([
    { title: "Far but cheap", extracted_price: 5, distanceKm: 60 },
    { title: "Near", extracted_price: 9, distanceKm: 2 },
  ], 15);
  assert.equal(sorted.find(r => r.cheapestNearby).title, "Near");
});

test("changing the radius changes what counts as nearby", () => {
  const results = [{ title: "A", extracted_price: 10, distanceKm: 25 }];
  assert.equal(nearby.sortNearbyFirst(results, 15)[0].proximity, "far");
  assert.equal(nearby.sortNearbyFirst(results, 30)[0].proximity, "nearby");
});

// ---------------------------------------------------------------
// location.js with fakes
// ---------------------------------------------------------------
function fakeStore() {
  const users = new Map();
  const branches = new Map();
  return {
    users,
    branches,
    async getUserLocation(id) { return users.get(id) || null; },
    async saveUserLocation(id, loc) { users.set(id, { ...(users.get(id) || { radiusKm: 15 }), ...loc }); },
    async clearUserLocation(id) { const u = users.get(id) || {}; users.set(id, { radiusKm: u.radiusKm ?? 15 }); },
    async saveRadius(id, km) { users.set(id, { ...(users.get(id) || {}), radiusKm: km }); },
    async getBranches(sid, area) { return branches.get(sid + "|" + area) || null; },
    async saveBranches(sid, area, list) { branches.set(sid + "|" + area, { branches: list, fetchedAt: new Date() }); },
  };
}

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

const geocode = async text => (/musgrave/i.test(text) ? MUSGRAVE : /london/i.test(text) ? { lat: 51.5, lng: -0.12 } : null);

test("GPS is used only when sent with the request; otherwise the saved area", async () => {
  const store = fakeStore();
  const svc = createLocationService({ store, geocode, fetchBranches: async () => [] });
  assert.equal((await svc.resolveOrigin(1)).origin, null); // nothing saved, no GPS
  await store.saveUserLocation(1, { label: "Musgrave", ...MUSGRAVE, source: "typed" });
  assert.equal((await svc.resolveOrigin(1)).origin.label, "Musgrave");
  const gps = await svc.resolveOrigin(1, { originLat: DURBAN.lat, originLng: DURBAN.lng });
  assert.equal(gps.origin.source, "gps");
});

test("branch lookups keep only real branches of the supplier and are cached", async () => {
  const store = fakeStore();
  let calls = 0;
  const fetchBranches = async supplier => {
    calls++;
    return [
      { name: `${supplier.name} Musgrave`, type: "Supermarket", ...MUSGRAVE },
      { name: "Sparkle Car Wash", type: "Car wash", ...DURBAN },       // wrong name
      { name: "Boxer Boxing Gym Durban", type: "Boxing gym", ...DURBAN }, // right name, wrong type
      { name: `${supplier.name} Nowhere`, type: "Supermarket", lat: 0, lng: 0 }, // bad coordinates
    ];
  };
  const svc = createLocationService({ store, geocode, fetchBranches });
  const area = nearby.areaKey(DURBAN.lat, DURBAN.lng);
  const first = await svc.supplierDistances(DURBAN, ["spar", "boxer"]);
  assert.equal(first.get("spar").branch.name, "SPAR Musgrave");
  assert.equal(first.get("boxer").branch.name, "Boxer Musgrave");
  assert.deepEqual(store.branches.get("spar|" + area).branches.map(b => b.name), ["SPAR Musgrave"]);
  assert.deepEqual(store.branches.get("boxer|" + area).branches.map(b => b.name), ["Boxer Musgrave"], "boxing gym dropped by type");
  await svc.supplierDistances(DURBAN, ["spar", "boxer"]);
  assert.equal(calls, 2, "second request served from cache");
});

test("live lookups are capped; unknown suppliers get no distance", async () => {
  const svc = createLocationService({ store: fakeStore(), geocode, fetchBranches: async s => [{ name: s.name, ...MUSGRAVE }] });
  const d = await svc.supplierDistances(DURBAN, ["shoprite", "checkers", "makro"], { maxLive: 1 });
  assert.ok(d.get("shoprite").distanceKm != null);
  assert.equal(d.get("checkers").distanceKm, null);
});

test("a failed maps lookup degrades to 'distance unknown'", async () => {
  const svc = createLocationService({ store: fakeStore(), geocode, fetchBranches: async () => { throw new Error("down"); } });
  const d = await svc.supplierDistances(DURBAN, ["shoprite"]);
  assert.equal(d.get("shoprite").distanceKm, null);
});

test("annotateResults sorts supplier results nearby-first with branch details", async () => {
  const svc = createLocationService({
    store: fakeStore(), geocode,
    fetchBranches: async s => (s.id === "makro" ? [{ name: "Makro Springfield", ...PMB }] : [{ name: `${s.name} Musgrave`, ...MUSGRAVE }]),
  });
  const out = await svc.annotateResults([
    { title: "Rice", extracted_price: 30, supplierId: "makro" },
    { title: "Rice", extracted_price: 35, supplierId: "shoprite" },
  ], DURBAN, 15);
  assert.deepEqual(out.map(r => `${r.supplierId}:${r.proximity}`), ["shoprite:nearby", "makro:far"]);
  assert.equal(out[0].branchName, "Shoprite Musgrave");
  assert.ok(out[0].cheapestNearby);
});

test("nearbySupplierIds is null without an area and a Set with one", async () => {
  const svc = createLocationService({ store: fakeStore(), geocode, fetchBranches: async s => (s.id === "makro" ? [{ name: "Makro", ...PMB }] : [{ name: s.name, ...MUSGRAVE }]) });
  assert.equal(await svc.nearbySupplierIds(null, 15, ["shoprite"]), null);
  const ids = await svc.nearbySupplierIds(DURBAN, 15, ["shoprite", "makro"]);
  assert.deepEqual([...ids], ["shoprite"]);
});

test("routes: typed area saved; unknown or foreign places and bad radius rejected; GPS rounded", async () => {
  const store = fakeStore();
  const routes = createLocationRoutes({ store, geocode });
  let res = fakeRes();
  await routes.put({ userId: 7, body: { source: "typed", label: "Musgrave, Durban", radiusKm: 10 } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual({ label: res.body.label, hasLocation: res.body.hasLocation, radiusKm: res.body.radiusKm }, { label: "Musgrave, Durban", hasLocation: true, radiusKm: 10 });

  for (const body of [{ source: "typed", label: "Atlantis" }, { source: "typed", label: "London" }, { radiusKm: 0 }, { radiusKm: 500 }, { source: "gps", lat: 0, lng: 0 }]) {
    res = fakeRes();
    await routes.put({ userId: 7, body }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }

  res = fakeRes();
  await routes.put({ userId: 8, body: { source: "gps", lat: -29.858123456, lng: 31.029987654 } }, res);
  assert.equal(store.users.get(8).lat, -29.858);
  assert.equal(store.users.get(8).lng, 31.03);

  res = fakeRes();
  await routes.remove({ userId: 7 }, res);
  assert.equal(res.body.hasLocation, false);
  assert.equal(res.body.radiusKm, 10, "radius kept when the area is cleared");
});

test("location data is per user", async () => {
  const store = fakeStore();
  const routes = createLocationRoutes({ store, geocode });
  await routes.put({ userId: 1, body: { source: "typed", label: "Musgrave" } }, fakeRes());
  const res = fakeRes();
  await routes.get({ userId: 2 }, res);
  assert.equal(res.body.hasLocation, false);
});
