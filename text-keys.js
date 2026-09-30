// Small text helpers shared by Smart Basket, suppliers, favourites and
// search: one normalised key per product/store name, so "Brown Bread!" and
// "brown  bread" are recognised as the same thing.

// Lowercase, letters/digits only, single spaces. "Brown Bread!" -> "brown bread".
function normaliseKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 100);
}

// "eggs" -> "egg" (but "glass" stays "glass").
const singular = w => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

module.exports = { normaliseKey, singular };
