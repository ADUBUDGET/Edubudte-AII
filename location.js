// ---------------------------------------------------------------
// LOCATION: the student's shopping area and distances to each supplier's
// nearest branch.
//
// - Current location (GPS) is only used when the page sends it, which it
//   does only after the student taps "Use my location" and the browser asks
//   for permission. Saved coordinates are rounded to ~100 m.
// - Without GPS the student can type a suburb, address or postcode; it's
//   geocoded (South Africa only) and saved with their search radius.
// - Branch locations come from a maps search per supplier, cached per
//   ~5 km area for BRANCH_CACHE_DAYS, and only branches whose name belongs
//   to that supplier are used.
// Store: location-store.js (tests use an in-memory fake).
// ---------------------------------------------------------------
const nearby = require("./nearby");
const { getSupplier, matchSupplier } = require("./suppliers");

const BRANCH_CACHE_DAYS = 30;
// Maps place types that can be a branch of a grocery/toiletries supplier.
// "Boxer Boxing Gym" matches Boxer by name but not by type.
const SHOP_TYPE = /supermarket|grocery|hypermarket|wholesale|warehouse|cash and carry|pharmacy|chemist|department store|food|market|convenience|shop|store/i;
const MAX_LIVE_BRANCH_LOOKUPS = 6; // per request, to protect the SerpAPI quota
const round3 = v => Math.round(Number(v) * 1000) / 1000;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function createLocationService({ store, geocode, fetchBranches, now = () => new Date() }) {
  // Where to measure from for this request: GPS sent with the request (only
  // after consent), then a typed area, then the student's saved area.
  // Returns { origin: {lat, lng, label, source} | null, radiusKm, saved }.
  async function resolveOrigin(userId, { originLat, originLng, locationText, radiusKm } = {}) {
    const saved = await store.getUserLocation(userId);
    const radius = nearby.clampRadius(radiusKm ?? saved?.radiusKm ?? nearby.DEFAULT_RADIUS_KM);
    if (nearby.validCoords(originLat, originLng)) {
      return { origin: { lat: Number(originLat), lng: Number(originLng), label: "your current location", source: "gps" }, radiusKm: radius, saved };
    }
    const text = typeof locationText === "string" ? locationText.trim() : "";
    if (text) {
      const geo = await geocode(text);
      if (geo && nearby.validCoords(geo.lat, geo.lng)) {
        return { origin: { lat: Number(geo.lat), lng: Number(geo.lng), label: text, source: "typed" }, radiusKm: radius, saved };
      }
    }
    if (saved && nearby.validCoords(saved.lat, saved.lng)) {
      return { origin: { lat: saved.lat, lng: saved.lng, label: saved.label, source: saved.source }, radiusKm: radius, saved };
    }
    return { origin: null, radiusKm: radius, saved };
  }

  // Branches of one supplier around the origin, from cache or a live lookup
  // (while `budget.live` allows). Returns an array (possibly empty) or null
  // if unknown.
  async function branchesFor(supplier, origin, budget) {
    const area = nearby.areaKey(origin.lat, origin.lng);
    const cached = await store.getBranches(supplier.id, area);
    const fresh = cached && now() - new Date(cached.fetchedAt) < BRANCH_CACHE_DAYS * 24 * 60 * 60 * 1000;
    if (fresh) return cached.branches;
    if (budget.live <= 0) return cached ? cached.branches : null;
    budget.live -= 1;
    try {
      const found = await fetchBranches(supplier, origin);
      // Only real branches of this supplier with valid coordinates - a maps
      // search for "Game" can also return arcades and toy shops.
      const branches = (found || [])
        .filter(b => matchSupplier(b.name)?.id === supplier.id && nearby.validCoords(b.lat, b.lng))
        .filter(b => !b.type || SHOP_TYPE.test(b.type))
        .slice(0, 20)
        .map(b => ({ name: b.name, address: b.address || null, lat: Number(b.lat), lng: Number(b.lng) }));
      await store.saveBranches(supplier.id, area, branches);
      return branches;
    } catch (err) {
      console.error("Branch lookup failed:", err.message);
      return cached ? cached.branches : null;
    }
  }

  // Map of supplierId -> { distanceKm, branch } (distanceKm null = unknown).
  async function supplierDistances(origin, supplierIds, { maxLive = MAX_LIVE_BRANCH_LOOKUPS } = {}) {
    const out = new Map();
    if (!origin) return out;
    const budget = { live: maxLive };
    for (const id of [...new Set(supplierIds)]) {
      const supplier = getSupplier(id);
      if (!supplier) continue;
      const branches = await branchesFor(supplier, origin, budget);
      const near = branches ? nearby.nearestBranch(branches, origin) : null;
      out.set(id, near ? { distanceKm: near.distanceKm, branch: near.branch } : { distanceKm: null, branch: null });
    }
    return out;
  }

  // Adds distanceKm / branch / proximity to supplier-tagged results and
  // sorts them nearby-first (see nearby.sortNearbyFirst).
  async function annotateResults(results, origin, radiusKm) {
    const distances = await supplierDistances(origin, results.map(r => r.supplierId));
    const withDistance = results.map(r => {
      const d = distances.get(r.supplierId);
      return {
        ...r,
        distanceKm: d ? d.distanceKm : null,
        branchName: d?.branch?.name || null,
        branchAddress: d?.branch?.address || null,
        storeLat: d?.branch?.lat ?? null,
        storeLng: d?.branch?.lng ?? null,
      };
    });
    return nearby.sortNearbyFirst(withDistance, radiusKm);
  }

  // Suppliers with a branch inside the radius (for "cheapest nearby").
  // Returns null when there's no origin (no filtering), else a Set.
  async function nearbySupplierIds(origin, radiusKm, supplierIds, opts) {
    if (!origin) return null;
    const distances = await supplierDistances(origin, supplierIds, opts);
    return new Set([...distances].filter(([, d]) => d.distanceKm != null && d.distanceKm <= radiusKm).map(([id]) => id));
  }

  return { resolveOrigin, supplierDistances, annotateResults, nearbySupplierIds };
}

function createLocationRoutes({ store, geocode }) {
  const fail = (res, err, message) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: message });
  };
  const publicView = loc => ({
    label: loc?.label || null,
    source: loc?.source || null,
    hasLocation: !!(loc && nearby.validCoords(loc.lat, loc.lng)),
    radiusKm: nearby.clampRadius(loc?.radiusKm ?? nearby.DEFAULT_RADIUS_KM),
    updatedAt: loc?.updatedAt || null,
  });

  return {
    async get(req, res) {
      try {
        res.json(publicView(await store.getUserLocation(req.userId)));
      } catch (err) {
        fail(res, err, "Failed to load your shopping area");
      }
    },

    // Body: { source: "gps", lat, lng } | { source: "typed", label } and/or { radiusKm }.
    async put(req, res) {
      try {
        const body = req.body || {};
        if (body.radiusKm !== undefined) {
          const r = Number(body.radiusKm);
          if (!Number.isFinite(r) || r < nearby.MIN_RADIUS_KM || r > nearby.MAX_RADIUS_KM) {
            throw badRequest(`Search radius must be between ${nearby.MIN_RADIUS_KM} and ${nearby.MAX_RADIUS_KM} km.`);
          }
          await store.saveRadius(req.userId, nearby.clampRadius(r));
        }
        if (body.source === "gps") {
          if (!nearby.validCoords(body.lat, body.lng)) throw badRequest("That location isn't in South Africa, so it can't be used for nearby shops.");
          await store.saveUserLocation(req.userId, { label: "My current location", lat: round3(body.lat), lng: round3(body.lng), source: "gps" });
        } else if (body.source === "typed") {
          const label = typeof body.label === "string" ? body.label.trim().slice(0, 120) : "";
          if (label.length < 2) throw badRequest("Type a suburb, address or postcode.");
          const geo = await geocode(label);
          if (!geo || !nearby.validCoords(geo.lat, geo.lng)) {
            throw badRequest(`We couldn't find "${label}" in South Africa. Try a suburb and city, like "Musgrave, Durban", or a postcode.`);
          }
          await store.saveUserLocation(req.userId, { label, lat: round3(geo.lat), lng: round3(geo.lng), source: "typed" });
        } else if (body.radiusKm === undefined) {
          throw badRequest("Nothing to save.");
        }
        res.json(publicView(await store.getUserLocation(req.userId)));
      } catch (err) {
        fail(res, err, "Failed to save your shopping area");
      }
    },

    async remove(req, res) {
      try {
        await store.clearUserLocation(req.userId);
        res.json(publicView(await store.getUserLocation(req.userId)));
      } catch (err) {
        fail(res, err, "Failed to clear your shopping area");
      }
    },
  };
}

function registerLocationRoutes(app, requireAuth, routes, { limiter } = {}) {
  const guard = limiter ? [requireAuth, limiter] : [requireAuth];
  app.get("/api/location", requireAuth, routes.get);
  app.put("/api/location", ...guard, routes.put);
  app.delete("/api/location", requireAuth, routes.remove);
}

module.exports = { BRANCH_CACHE_DAYS, createLocationService, createLocationRoutes, registerLocationRoutes };
