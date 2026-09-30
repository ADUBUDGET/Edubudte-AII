// ---------------------------------------------------------------
// NEARBY SHOPS: distance maths and "nearby first" sorting. Pure functions
// (no database or network) so they're easy to test - see
// test/nearby.test.js. location.js does the lookups and storage.
// ---------------------------------------------------------------

const DEFAULT_RADIUS_KM = 15;
const MIN_RADIUS_KM = 1;
const MAX_RADIUS_KM = 200;

// Rough bounding box of South Africa (incl. Lesotho/Eswatini). Coordinates
// outside it - or (0, 0), which usually means "missing" - are treated as
// invalid location data.
const SA_BOUNDS = { minLat: -35.5, maxLat: -21.5, minLng: 16, maxLng: 33.5 };

function validCoords(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === 0 && ln === 0) return false;
  return la >= SA_BOUNDS.minLat && la <= SA_BOUNDS.maxLat && ln >= SA_BOUNDS.minLng && ln <= SA_BOUNDS.maxLng;
}

function clampRadius(km) {
  const n = Math.round(Number(km));
  if (!Number.isFinite(n)) return DEFAULT_RADIUS_KM;
  return Math.min(MAX_RADIUS_KM, Math.max(MIN_RADIUS_KM, n));
}

// Straight-line distance in km.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Branch lookups are cached per ~5 km grid cell, so nearby students share
// them and a small move doesn't trigger a new lookup.
function areaKey(lat, lng) {
  const cell = v => (Math.round(Number(v) * 20) / 20).toFixed(2);
  return `${cell(lat)},${cell(lng)}`;
}

// Closest valid branch to the origin, or null.
function nearestBranch(branches, origin) {
  let best = null;
  for (const b of branches || []) {
    if (!validCoords(b.lat, b.lng)) continue;
    const d = haversineKm(origin.lat, origin.lng, b.lat, b.lng);
    if (!best || d < best.distanceKm) best = { branch: b, distanceKm: Math.round(d * 10) / 10 };
  }
  return best;
}

// "nearby" (inside the radius), "far" (known distance, outside it) or
// "unknown" (no valid branch location found).
function proximity(distanceKm, radiusKm) {
  if (distanceKm == null || !Number.isFinite(Number(distanceKm))) return "unknown";
  return Number(distanceKm) <= radiusKm ? "nearby" : "far";
}

// "850 m away", "2.4 km away", "32 km away".
function formatDistance(km) {
  const n = km == null || km === "" ? NaN : Number(km);
  if (!Number.isFinite(n)) return "Distance unknown";
  if (n < 1) return `${Math.max(50, Math.round((n * 1000) / 50) * 50)} m away`;
  if (n < 10) return `${n.toFixed(1)} km away`;
  return `${Math.round(n)} km away`;
}

const GROUP_ORDER = { nearby: 0, far: 1, unknown: 2 };
const priceOf = r => (Number.isFinite(Number(r.extracted_price)) ? Number(r.extracted_price) : Infinity);

// Adds proximity to each result and orders them: nearby shops first
// (cheapest first), then farther shops (closest first), then shops whose
// distance couldn't be worked out. Also marks the cheapest nearby result.
// With no origin at all, everything is "unknown" and keeps price order.
function sortNearbyFirst(results, radiusKm) {
  const annotated = results.map(r => ({ ...r, proximity: proximity(r.distanceKm, radiusKm), cheapestNearby: false }));
  annotated.sort((a, b) =>
    GROUP_ORDER[a.proximity] - GROUP_ORDER[b.proximity] ||
    (a.proximity === "far" ? a.distanceKm - b.distanceKm : priceOf(a) - priceOf(b)));
  const nearby = annotated.filter(r => r.proximity === "nearby" && Number.isFinite(priceOf(r)));
  if (nearby.length) nearby.reduce((min, r) => (priceOf(r) < priceOf(min) ? r : min)).cheapestNearby = true;
  return annotated;
}

module.exports = {
  DEFAULT_RADIUS_KM,
  MIN_RADIUS_KM,
  MAX_RADIUS_KM,
  validCoords,
  clampRadius,
  haversineKm,
  areaKey,
  nearestBranch,
  proximity,
  formatDistance,
  sortNearbyFirst,
};
