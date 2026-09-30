// ---------------------------------------------------------------
// APPROVED SUPPLIERS: the only shops whose products and prices the app
// shows. Google Shopping (via SerpAPI) returns any seller - foreign shops,
// marketplaces, one-off online stores - so every product is checked here
// before it reaches the Shop, Smart Basket or the basket.
//
// To approve a new shop, add it below (with the name variants Google uses).
// To stop showing one without deleting it, set active: false.
// ---------------------------------------------------------------
const { normaliseKey } = require("./text-keys");

const SUPPLIERS = [
  { id: "shoprite", name: "Shoprite", match: /\bshoprite\b/, active: true },
  { id: "checkers", name: "Checkers", match: /\bcheckers\b|\bsixty60\b/, active: true },
  { id: "pick-n-pay", name: "Pick n Pay", match: /\bpick n pay\b|\bpicknpay\b|^pnp\b/, active: true },
  { id: "spar", name: "SPAR", match: /\b(super|kwik)?spar\b/, active: true },
  { id: "woolworths", name: "Woolworths", match: /\bwoolworths\b/, active: true },
  { id: "boxer", name: "Boxer", match: /\bboxer\b/, active: true },
  { id: "makro", name: "Makro", match: /\bmakro\b/, active: true },
  { id: "usave", name: "Usave", match: /\busave\b/, active: true },
  { id: "ok-foods", name: "OK Foods", match: /^ok (foods|grocer|minimark|express)\b/, active: true },
  { id: "food-lovers", name: "Food Lover's Market", match: /\bfood lovers? (s )?market\b|\bfood lover s market\b/, active: true },
  { id: "clicks", name: "Clicks", match: /^clicks\b/, active: true },
  { id: "dis-chem", name: "Dis-Chem", match: /\bdis ?chem\b/, active: true },
];

const byId = new Map(SUPPLIERS.map(s => [s.id, s]));

// Returns the approved, active supplier a store name belongs to, or null.
// "Makro - Makro Business", "makro.co.za" and "Makro" all map to Makro.
function matchSupplier(storeName) {
  const key = normaliseKey(storeName);
  if (!key) return null;
  const s = SUPPLIERS.find(x => x.match.test(key));
  return s && s.active ? s : null;
}

function getSupplier(id) {
  const s = byId.get(String(id || ""));
  return s && s.active ? s : null;
}

// Why a product can't be shown, or null if it's fine.
function offerProblem({ title, price, store }) {
  if (!String(title || "").trim()) return "no_title";
  const n = Number(price);
  if (price == null || price === "" || !Number.isFinite(n)) return "no_price";
  if (n <= 0 || n > 100000) return "bad_price";
  const key = normaliseKey(store);
  if (!key) return "no_store";
  const s = SUPPLIERS.find(x => x.match.test(key));
  if (!s) return "unknown_supplier";
  if (!s.active) return "inactive_supplier";
  return null;
}

// Filters raw Google Shopping results to approved suppliers, tags each with
// its supplier, and collapses duplicates (same supplier + same product
// title) to the cheapest listing. Returns { results, rejected } where
// rejected counts the dropped listings by reason.
function cleanShoppingResults(results = []) {
  const rejected = {};
  const kept = new Map();
  for (const r of results) {
    const problem = r.availability === "out_of_stock"
      ? "out_of_stock"
      : offerProblem({ title: r.title, price: r.extracted_price, store: r.source });
    if (problem) {
      rejected[problem] = (rejected[problem] || 0) + 1;
      continue;
    }
    const supplier = matchSupplier(r.source);
    const dupKey = supplier.id + "|" + normaliseKey(r.title);
    const tagged = { ...r, extracted_price: Number(r.extracted_price), supplierId: supplier.id, supplierName: supplier.name };
    const existing = kept.get(dupKey);
    if (existing) {
      rejected.duplicate = (rejected.duplicate || 0) + 1;
      if (tagged.extracted_price < existing.extracted_price) kept.set(dupKey, tagged);
    } else {
      kept.set(dupKey, tagged);
    }
  }
  return { results: [...kept.values()], rejected };
}

module.exports = { SUPPLIERS, matchSupplier, getSupplier, offerProblem, cleanShoppingResults };
