// ---------------------------------------------------------------
// SHOPPING RESULTS: the one place that turns real SerpAPI Google Shopping
// results into what the app caches and shows. Used by the Shop search,
// Smart Basket pricing, basket price refresh and the deals script, so every
// cache holds the same, complete, real data:
//   product_id, title, price, extracted_price, old_price (if on sale),
//   source (shop), link, thumbnail, availability, multiple_sources.
// The time the prices were checked is stored alongside (price_cache.fetched_at).
//
// Cache keys carry CACHE_VERSION. Entries written in an older format (or
// under an older key) are never read and are deleted at startup
// (see db.js), so the app can't show stale or incomplete cached results.
// ---------------------------------------------------------------
const { normaliseKey } = require("./text-keys");

const CACHE_VERSION = "v2";
const SHOPPING_LOCATION = process.env.SHOPPING_LOCATION || "Durban, KwaZulu-Natal, South Africa";
const MAX_RESULTS = 40; // SerpAPI returns up to 40; many are later filtered out by suppliers.js

// "in_stock" | "out_of_stock" | "unknown" from the result's tags/extensions.
function availabilityOf(r = {}) {
  const text = [r.tag, r.delivery, ...(Array.isArray(r.extensions) ? r.extensions : [])]
    .filter(v => typeof v === "string").join(" ").toLowerCase();
  if (/out of stock|sold out|unavailable|not available/.test(text)) return "out_of_stock";
  if (/in stock|available/.test(text)) return "in_stock";
  return "unknown";
}

function mapShoppingResult(r = {}) {
  const num = v => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    product_id: r.product_id != null ? String(r.product_id) : null,
    title: r.title || null,
    price: r.price || null,
    extracted_price: num(r.extracted_price),
    old_price: r.old_price || null,
    extracted_old_price: num(r.extracted_old_price),
    source: r.source || null,
    link: r.product_link || r.link || null,
    thumbnail: r.thumbnail || null,
    availability: availabilityOf(r),
    multiple_sources: !!r.multiple_sources,
  };
}

// A cached entry is only used if every result has the current shape.
function isValidCachedResults(results) {
  return Array.isArray(results) && results.every(x =>
    x && typeof x === "object" && typeof x.title === "string" &&
    "product_id" in x && "availability" in x && "extracted_price" in x);
}

// e.g. versionedKey("search", "Durban, KZN", "Brown Bread") -> "v2:search:durban kzn:brown bread"
function versionedKey(kind, ...parts) {
  return [CACHE_VERSION, kind, ...parts.map(p => normaliseKey(p))].join(":");
}

function isCurrentCacheKey(key) {
  return String(key || "").startsWith(CACHE_VERSION + ":");
}

// Live SerpAPI lookup, mapped. Throws with status 502 when SerpAPI fails.
async function fetchShoppingResults(query, { location = SHOPPING_LOCATION, fetchImpl = fetch } = {}) {
  if (!process.env.SERPAPI_KEY) throw Object.assign(new Error("SERPAPI_KEY not configured on server"), { status: 500 });
  const params = new URLSearchParams({
    engine: "google_shopping",
    // Lowercase on purpose: "Pasta" returned only foreign shops while "pasta"
    // returned Shoprite and Makro.
    q: String(query).trim().toLowerCase(),
    api_key: process.env.SERPAPI_KEY,
    gl: "za",
    hl: "en",
    location,
  });
  const resp = await fetchImpl(`https://serpapi.com/search.json?${params.toString()}`);
  if (!resp.ok) {
    throw Object.assign(new Error("SerpAPI request failed"), { status: 502, detail: `status ${resp.status}` });
  }
  const data = await resp.json();
  return (data.shopping_results || []).slice(0, MAX_RESULTS).map(mapShoppingResult);
}

// Product id and "price checked at" sent with a basket item or favourite.
// The id is kept as-is (trimmed); the time must be a real date that isn't in
// the future and isn't older than the price cache allows (7 days) - if it's
// missing or invalid, the price is treated as checked now only when a price
// was given, else null.
function cleanPriceMeta(body = {}, { hasPrice = false, now = new Date() } = {}) {
  const productId = typeof body.productId === "string" && body.productId.trim() ? body.productId.trim().slice(0, 64) : null;
  const t = body.priceCheckedAt ? new Date(body.priceCheckedAt) : null;
  const valid = t && !isNaN(t) && t <= new Date(now.getTime() + 5 * 60 * 1000) && now - t <= 7 * 24 * 60 * 60 * 1000;
  return { productId, priceCheckedAt: valid ? t : hasPrice ? now : null };
}

module.exports = {
  CACHE_VERSION,
  cleanPriceMeta,
  SHOPPING_LOCATION,
  availabilityOf,
  mapShoppingResult,
  isValidCachedResults,
  versionedKey,
  isCurrentCacheKey,
  fetchShoppingResults,
};
