// ---------------------------------------------------------------
// SMART BASKET: personalised, swipeable product suggestions + grocery list.
//
// The top half of this file is pure logic (ranking, filtering, cheapest
// price selection) with no database or network access, so it can be unit
// tested on its own (see test/smart-basket.test.js). The bottom half,
// createSmartBasketRoutes(), wires that logic to a data store
// (smart-basket-store.js in the app, an in-memory fake in tests) and Express.
// ---------------------------------------------------------------

const SKIP_COOLDOWN_DAYS = 3;          // a skipped item can come back after this
const PRICE_CACHE_HOURS = 24;          // cached SerpAPI results count as current for this long
const MAX_SUGGESTIONS = 8;             // cards per Smart Basket load
const MAX_LIVE_PRICE_LOOKUPS = 3;      // live SerpAPI calls allowed per Smart Basket load
const MIN_PERSONAL_SUGGESTIONS = 3;    // below this, fill up with fallback suggestions
const POPULAR_MIN_USERS = 3;           // a "popular" term must be searched by at least this many students
const RECENCY_HALF_LIFE_DAYS = 30;     // activity this old counts half as much
const MIN_PERSONAL_SCORE = 2;          // e.g. 1 purchase, 1 past list item, or 2 searches

// How strongly each kind of activity says "this student needs this again".
const SIGNAL_WEIGHTS = { purchase: 3, list: 2, search: 1 };

// Purchases are only treated as products when logged under these categories.
const PRODUCT_CATEGORIES = ["food", "other"];

// Purchase descriptions that describe a shopping trip, not a product.
const GENERIC_TERMS = new Set([
  "groceries", "grocery", "shopping", "food", "lunch", "dinner", "breakfast",
  "snacks", "takeaway", "takeaways", "misc", "other", "stuff", "items",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

const { normaliseKey, singular } = require("./text-keys");

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Keeps only purchase descriptions that look like a product name.
function filterPurchaseSignals(rows) {
  return rows.filter(r => {
    if (!PRODUCT_CATEGORIES.includes(String(r.category || "").toLowerCase())) return false;
    const key = normaliseKey(r.name);
    if (!key || GENERIC_TERMS.has(key)) return false;
    return key.split(" ").length <= 5;
  });
}

// Merges search, purchase and past-list activity into one ranked list of
// candidate items. Each signal row is { name, count, lastAt }.
function buildPersonalCandidates({ searches = [], purchases = [], listHistory = [], now = new Date() }) {
  const byKey = new Map();
  const add = (rows, type) => {
    for (const r of rows) {
      const key = normaliseKey(r.name);
      if (!key) continue;
      const lastAt = new Date(r.lastAt);
      const c = byKey.get(key) || { itemKey: key, name: r.name, lastAt, counts: { purchase: 0, list: 0, search: 0 } };
      c.counts[type] += Number(r.count) || 0;
      if (lastAt > c.lastAt) {
        c.lastAt = lastAt;
        c.name = r.name; // show the student's most recent wording
      }
      byKey.set(key, c);
    }
  };
  add(filterPurchaseSignals(purchases), "purchase");
  add(listHistory, "list");
  add(searches, "search");

  const candidates = [];
  for (const c of byKey.values()) {
    const rawScore = Object.entries(c.counts).reduce((sum, [type, n]) => sum + SIGNAL_WEIGHTS[type] * n, 0);
    if (rawScore < MIN_PERSONAL_SCORE) continue;
    const ageDays = Math.max(0, (now - c.lastAt) / DAY_MS);
    const score = rawScore * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);

    const reasons = [];
    if (c.counts.purchase) reasons.push(`You've logged buying this ${plural(c.counts.purchase, "time")}`);
    if (c.counts.list) reasons.push(`Ticked off ${plural(c.counts.list, "past grocery list")}`);
    if (c.counts.search) reasons.push(`You searched for this ${plural(c.counts.search, "time")}`);

    candidates.push({ itemKey: c.itemKey, name: c.name, source: "personal", reasons, score });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// Removes hidden items, items skipped within the cooldown, and items already
// on the active grocery list.
function filterCandidates(candidates, { states = [], activeListKeys = [], now = new Date() }) {
  const onList = new Set(activeListKeys);
  const blocked = new Set();
  for (const s of states) {
    if (s.status === "hidden") blocked.add(s.item_key);
    if (s.status === "skipped" && s.skipped_until && new Date(s.skipped_until) > now) blocked.add(s.item_key);
  }
  return candidates.filter(c => !blocked.has(c.itemKey) && !onList.has(c.itemKey));
}

// Personal suggestions first; if there are too few (new users), top up with
// terms that at least POPULAR_MIN_USERS different students really searched
// for. Nothing is made up: with no real activity at all the list is empty
// and the page says how to get suggestions.
function composeSuggestions({ personal = [], popular = [], states = [], activeListKeys = [], now = new Date(), limit = MAX_SUGGESTIONS }) {
  const ctx = { states, activeListKeys, now };
  const picked = filterCandidates(personal, ctx).slice(0, limit);
  if (picked.length >= MIN_PERSONAL_SUGGESTIONS) return { suggestions: picked, personalised: true };

  const seen = new Set(picked.map(c => c.itemKey));
  const fallback = [
    ...popular.map(p => ({ itemKey: normaliseKey(p.name), name: p.name, source: "popular", reasons: ["Popular with students on EduBudget"], score: 0 })),
  ];
  for (const c of filterCandidates(fallback, ctx)) {
    if (picked.length >= limit) break;
    if (!c.itemKey || seen.has(c.itemKey)) continue;
    seen.add(c.itemKey);
    picked.push(c);
  }
  return { suggestions: picked, personalised: picked.some(c => c.source === "personal") };
}

// ---------------------------------------------------------------
// PRICING
// ---------------------------------------------------------------
const STOP_WORDS = new Set(["a", "an", "and", "the", "of", "for", "with", "in"]);

// Words that turn a grocery title into an accessory ("milk frother",
// "bread bin"). Such listings only count if the student searched for them.
const ACCESSORY_WORDS = new Set([
  "frother", "holder", "dispenser", "bin", "container", "maker", "storage",
  "toy", "costume", "keyring", "keychain", "case", "cover", "mould", "mold",
]);

// True if every meaningful word of the query appears in the listing title
// and the title isn't an accessory the student didn't ask for, so "milk"
// can't be "cheapest" via a R10 milk frother. Plurals match singulars
// ("eggs" ~ "egg").
// Words of 4+ letters may also match the start of a title word, which copes
// with run-together listings like "Baked Beansin Tomato Sauce".
function titleMatches(query, title) {
  const words = normaliseKey(query).split(" ").filter(w => w && !STOP_WORDS.has(w)).map(singular);
  if (words.length === 0) return false;
  const titleWords = new Set(normaliseKey(title).split(" ").map(singular));
  const found = w => titleWords.has(w) || (w.length >= 4 && [...titleWords].some(t => t.startsWith(w)));
  if (!words.every(found)) return false;
  const queryWords = new Set(words);
  return ![...titleWords].some(w => ACCESSORY_WORDS.has(w) && !queryWords.has(w));
}

// Reads a pack size out of a listing title, e.g. "Clover Milk 2L" -> "2L",
// "Coke 6 x 330ml" -> "6 x 330ml". Returns null if the title has none.
function parseSize(title) {
  const t = String(title || "");
  const unit = u => {
    u = u.toLowerCase();
    if (u === "l" || u.startsWith("lit")) return "L";
    return u;
  };
  const multi = t.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|litres?|liters?)\b/i);
  if (multi) return `${multi[1]} x ${multi[2].replace(",", ".")}${unit(multi[3])}`;
  const single = t.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|litres?|liters?)\b/i);
  if (single) return `${single[1].replace(",", ".")}${unit(single[2])}`;
  const count = t.match(/(\d+)\s*(pack|pk|rolls?|pieces?|pcs|eggs)\b/i);
  if (count) return `${count[1]} ${count[2].toLowerCase()}`;
  return null;
}

// Turns SerpAPI shopping results and store_specials rows into one offer shape.
function toOffers({ shoppingResults = [], specials = [] }) {
  const offers = [];
  for (const r of shoppingResults) {
    offers.push({
      kind: "online",
      productId: r.product_id || null,
      title: r.title,
      price: r.extracted_price != null ? Number(r.extracted_price) : NaN,
      store: r.source || null,
      link: r.product_link || r.link || null,
      thumbnail: r.thumbnail || null,
    });
  }
  for (const s of specials) {
    offers.push({
      kind: "special",
      title: s.item,
      price: s.price != null ? Number(s.price) : NaN,
      wasPrice: s.was_price != null ? Number(s.was_price) : null,
      store: s.store || null,
      link: null,
      thumbnail: null,
      endsOn: s.ends_on || null,
    });
  }
  return offers;
}

const round2 = n => Math.round(n * 100) / 100;

// Only approved suppliers (suppliers.js) count - foreign shops, marketplaces
// and unknown sellers are never used for a price.
const { matchSupplier } = require("./suppliers");

// A listing priced under this fraction of the next cheapest one is treated
// as a listing error, e.g. R5 brown bread when the next is R28.99.
const OUTLIER_FRACTION = 1 / 3;

// Drops implausibly cheap listings from a price-sorted list. Store specials
// entered by the team are trusted and never dropped.
function dropPriceOutliers(sorted) {
  const out = [...sorted];
  while (out.length >= 2 && out[0].kind !== "special" && out[0].price < out[1].price * OUTLIER_FRACTION) {
    out.shift();
  }
  return out;
}

// Picks the cheapest offer from an approved supplier (including the team's
// store specials, which must also name an approved supplier) that genuinely
// matches the item, and compares it with the cheapest offer from a
// *different* supplier. `nearbySupplierIds` (a Set), when given, limits the
// choice to suppliers with a branch inside the student's search radius.
// Returns null if nothing qualifies - never a guessed or foreign price.
function pickCheapest(query, offers, { nearbySupplierIds = null } = {}) {
  const local = offers
    .filter(o => Number.isFinite(o.price) && o.price > 0 && titleMatches(query, o.title))
    .map(o => ({ ...o, supplier: matchSupplier(o.store) }))
    .filter(o => o.supplier && (!nearbySupplierIds || nearbySupplierIds.has(o.supplier.id)))
    .sort((a, b) => a.price - b.price);
  const relevant = dropPriceOutliers(local);
  if (relevant.length === 0) return null;

  const best = relevant[0];
  const next = relevant.find(o => o.supplier.id !== best.supplier.id) || null;
  const stores = new Set(relevant.map(o => o.supplier.id));

  return {
    title: best.title,
    productId: best.productId || null,
    price: best.price,
    store: best.supplier.name,
    supplierId: best.supplier.id,
    link: best.link,
    thumbnail: best.thumbnail || relevant.find(o => o.thumbnail)?.thumbnail || null,
    size: parseSize(best.title),
    kind: best.kind,
    wasPrice: best.kind === "special" ? best.wasPrice : null,
    endsOn: best.kind === "special" ? best.endsOn : null,
    storesCompared: stores.size,
    offersCompared: relevant.length,
    nextCheapest: next ? { store: next.supplier.name, price: next.price } : null,
    savingVsNext: next ? round2(next.price - best.price) : null,
  };
}

// Smart Basket prices come from the same real Google Shopping lookup as the
// Shop (shopping-results.js), pinned to SHOPPING_LOCATION (default Durban),
// cached under a versioned key.
const { SHOPPING_LOCATION, fetchShoppingResults, versionedKey, isValidCachedResults, cleanPriceMeta } = require("./shopping-results");
const priceCacheKey = name => versionedKey("basket", SHOPPING_LOCATION, name);

// ---------------------------------------------------------------
// SERVICE: store-backed actions (store = smart-basket-store.js or a fake)
// ---------------------------------------------------------------
const MAX_QUANTITY = 99;
const { getSupplier } = require("./suppliers");
const { guessCategory } = require("./categories");

const badInput = message => Object.assign(new Error(message), { status: 400 });

// Validates what the page sends when adding to the basket (grocery list).
// A shop must be an approved supplier: given by id (from Shop / Smart
// Basket results) or by a name that maps to one. Items without a shop
// (typed by hand, or from a favourite with no store) are fine.
function cleanItemInput(body) {
  const name = typeof body?.itemName === "string" ? body.itemName.trim().replace(/\s+/g, " ").slice(0, 120) : "";
  const price = body?.price != null && body.price !== "" ? Number(body.price) : null;
  const httpLink = v => (typeof v === "string" && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : null);
  const qty = body?.quantity == null || body.quantity === "" ? 1 : Number(body.quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) throw badInput(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);

  let supplier = null;
  if (body?.supplierId) {
    supplier = getSupplier(body.supplierId);
    if (!supplier) throw badInput("That shop isn't one of our approved stores.");
  } else if (typeof body?.storeName === "string" && body.storeName.trim()) {
    supplier = matchSupplier(body.storeName);
    if (!supplier) throw badInput(`"${body.storeName.trim().slice(0, 60)}" isn't one of our approved stores.`);
  }
  const productTitle = typeof body?.productTitle === "string" ? body.productTitle.slice(0, 300) : null;
  const category = typeof body?.category === "string" && body.category.trim() ? body.category.trim().slice(0, 40) : guessCategory(productTitle || name);
  const cleanPrice = Number.isFinite(price) && price >= 0 && price <= 100000 ? Math.round(price * 100) / 100 : null;
  const { productId, priceCheckedAt } = cleanPriceMeta(body || {}, { hasPrice: cleanPrice != null });
  return {
    productId,
    priceCheckedAt,
    itemName: name,
    itemKey: normaliseKey(name),
    productTitle,
    supplierId: supplier ? supplier.id : null,
    storeName: supplier ? supplier.name : null,
    price: cleanPrice,
    quantity: qty,
    unit: typeof body?.unit === "string" && body.unit.trim() ? body.unit.trim().slice(0, 30) : parseSize(productTitle || name),
    category,
    link: httpLink(body?.link),
    thumbnail: httpLink(body?.thumbnail),
    addedFrom: ["smart_basket", "shop", "favourite"].includes(body?.addedFrom) ? body.addedFrom : "manual",
  };
}

// Adds an item to the basket (the active grocery list). The same product
// (normalised name) is never added twice:
// - same shop (or no shop): the quantities are added together
// - a different shop: the item switches to the new shop and price, and the
//   quantities are added together
// Returns { item, alreadyExisted, merge: null | "quantity" | "switched" }.
async function addItemToList(store, userId, body) {
  const item = cleanItemInput(body);
  if (!item.itemKey) throw badInput("itemName is required");

  const merge = async existing => {
    const switched = item.supplierId && item.supplierId !== existing.supplier_id;
    const quantity = Math.min(MAX_QUANTITY, (Number(existing.quantity) || 1) + item.quantity);
    const updated = await store.mergeListItem(userId, existing.id, {
      quantity,
      // Keep the saved shop/price unless a (new) shop or price was given.
      ...(switched || item.price != null
        ? { supplierId: item.supplierId ?? existing.supplier_id, storeName: item.storeName ?? existing.store_name,
            price: item.price, productTitle: item.productTitle ?? existing.product_title,
            link: item.link ?? existing.link, thumbnail: item.thumbnail ?? existing.thumbnail, unit: item.unit ?? existing.unit,
            productId: item.productId ?? (switched ? null : existing.product_id),
            priceCheckedAt: item.price != null ? item.priceCheckedAt : existing.price_checked_at }
        : {}),
    });
    return { item: updated, alreadyExisted: true, merge: switched ? "switched" : "quantity" };
  };

  const existing = await store.findActiveListItem(userId, item.itemKey);
  if (existing) return merge(existing);
  try {
    return { item: await store.insertListItem(userId, item), alreadyExisted: false, merge: null };
  } catch (err) {
    // Two taps at once: the unique index caught the duplicate.
    if (err.code === "23505") {
      const raced = await store.findActiveListItem(userId, item.itemKey);
      if (raced) return merge(raced);
    }
    throw err;
  }
}

// Sets an item's quantity (active items only).
async function setItemQuantity(store, userId, id, quantity) {
  const q = Number(quantity);
  if (!Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) throw badInput(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  return store.setQuantity(userId, id, q);
}

async function setSuggestionState(store, userId, body, status, now = new Date()) {
  const itemName = typeof body?.itemName === "string" ? body.itemName.trim().slice(0, 120) : "";
  const itemKey = normaliseKey(body?.itemKey || itemName);
  if (!itemKey) {
    const err = new Error("itemName is required");
    err.status = 400;
    throw err;
  }
  const skippedUntil = status === "skipped" ? new Date(now.getTime() + SKIP_COOLDOWN_DAYS * DAY_MS) : null;
  await store.upsertState(userId, { itemKey, itemName: itemName || itemKey, status, skippedUntil });
  return { itemKey, status, skippedUntil };
}

async function loadSuggestions(store, userId, now = new Date()) {
  const [searches, purchases, listHistory, states, activeListKeys] = await Promise.all([
    store.getSearchSignals(userId),
    store.getPurchaseSignals(userId),
    store.getListHistorySignals(userId),
    store.getStates(userId),
    store.getActiveListKeys(userId),
  ]);
  const personal = buildPersonalCandidates({ searches, purchases, listHistory, now });
  // Only fetch the (anonymous, aggregated) popular list when it's needed.
  const needsFallback = filterCandidates(personal, { states, activeListKeys, now }).length < MIN_PERSONAL_SUGGESTIONS;
  const popular = needsFallback ? await store.getPopularSearches(POPULAR_MIN_USERS, 20) : [];
  return composeSuggestions({ personal, popular, states, activeListKeys, now });
}

// Finds the current cheapest price for one item from store specials plus
// cached or live SerpAPI results. `budget.live` is a shared counter of how
// many live lookups this request may still make. `nearbySupplierIds` (a
// Set, or null for no area) limits "cheapest" to shops near the student.
async function priceItem(name, { store, fetchShopping, specials, budget, now = new Date(), nearbySupplierIds = null }) {
  const key = priceCacheKey(name);
  const matchingSpecials = specials.filter(s => titleMatches(name, s.item));
  let shoppingResults = [];
  let checkedAt = null;
  let status = "ok";

  const cached = await store.getCachedPrices(key);
  // Only fresh entries in the current full format count; older or
  // incomplete ones are fetched again, never shown.
  const fresh = cached && isValidCachedResults(cached.results) &&
    now - new Date(cached.fetchedAt) < PRICE_CACHE_HOURS * 60 * 60 * 1000;
  if (fresh) {
    shoppingResults = cached.results;
    checkedAt = cached.fetchedAt;
  } else if (budget.live > 0) {
    budget.live -= 1;
    try {
      shoppingResults = await fetchShopping(name);
      await store.saveCachedPrices(key, shoppingResults);
      checkedAt = now;
    } catch (e) {
      console.error("Smart Basket price lookup failed:", e.message);
      status = "error";
    }
  } else {
    status = "not_checked";
  }
  // An expired price is never used: the card says "not checked yet" (and is
  // priced live when it reaches the top) or "couldn't check prices".

  const best = pickCheapest(name, toOffers({ shoppingResults, specials: matchingSpecials }), { nearbySupplierIds });
  if (best) {
    // Specials are only for today's date range, so they count as checked now.
    return { price: best, priceStatus: "ok", priceCheckedAt: best.kind === "special" ? now : checkedAt };
  }
  return { price: null, priceStatus: status === "ok" ? "no_match" : status, priceCheckedAt: checkedAt };
}

// ---------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------
// nearbyFor(userId) -> { nearbySupplierIds: Set | null, area: { label, radiusKm } | null }
function createSmartBasketRoutes({ store, fetchShopping = name => fetchShoppingResults(name), now = () => new Date(), nearbyFor = null }) {
  const nearbyContext = async userId => (nearbyFor ? nearbyFor(userId) : { nearbySupplierIds: null, area: null });

  const fail = (res, err, message) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: message, detail: err.message });
  };

  return {
    async getSuggestions(req, res) {
      try {
        const at = now();
        const { suggestions, personalised } = await loadSuggestions(store, req.userId, at);
        const specials = await store.getActiveSpecials();
        const { nearbySupplierIds, area } = await nearbyContext(req.userId);
        const budget = { live: MAX_LIVE_PRICE_LOOKUPS };
        const priced = [];
        for (const s of suggestions) {
          const p = await priceItem(s.name, { store, fetchShopping, specials, budget, now: at, nearbySupplierIds });
          priced.push({ itemKey: s.itemKey, name: s.name, source: s.source, reasons: s.reasons, ...p });
        }
        const remainingBudget = await store.getRemainingBudget(req.userId);
        res.json({ suggestions: priced, personalised, remainingBudget, skipCooldownDays: SKIP_COOLDOWN_DAYS, area });
      } catch (err) {
        fail(res, err, "Failed to load Smart Basket");
      }
    },

    // One-item price check for cards the first load didn't have quota to price.
    async getPrice(req, res) {
      try {
        const name = typeof req.query.item === "string" ? req.query.item.trim().slice(0, 120) : "";
        if (!normaliseKey(name)) return res.status(400).json({ error: "item is required" });
        const specials = await store.getActiveSpecials();
        const { nearbySupplierIds } = await nearbyContext(req.userId);
        const p = await priceItem(name, { store, fetchShopping, specials, budget: { live: 1 }, now: now(), nearbySupplierIds });
        res.json(p);
      } catch (err) {
        fail(res, err, "Price check failed");
      }
    },

    async skip(req, res) {
      try {
        res.json(await setSuggestionState(store, req.userId, req.body, "skipped", now()));
      } catch (err) {
        fail(res, err, "Failed to skip item");
      }
    },

    async hide(req, res) {
      try {
        res.json(await setSuggestionState(store, req.userId, req.body, "hidden", now()));
      } catch (err) {
        fail(res, err, "Failed to hide item");
      }
    },

    async listHidden(req, res) {
      try {
        res.json(await store.getHidden(req.userId));
      } catch (err) {
        fail(res, err, "Failed to load hidden items");
      }
    },

    async restore(req, res) {
      try {
        await store.deleteState(req.userId, normaliseKey(req.params.itemKey));
        res.status(204).send();
      } catch (err) {
        fail(res, err, "Failed to restore item");
      }
    },

    async getList(req, res) {
      try {
        res.json(await store.getList(req.userId));
      } catch (err) {
        fail(res, err, "Failed to load grocery list");
      }
    },

    async addToList(req, res) {
      try {
        const result = await addItemToList(store, req.userId, req.body);
        res.status(result.alreadyExisted ? 200 : 201).json(result);
      } catch (err) {
        fail(res, err, "Failed to add to grocery list");
      }
    },

    // Tick an item off (purchased: true) or put it back (purchased: false).
    async updateListItem(req, res) {
      try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "Grocery list item not found" });
        const body = req.body || {};
        if (body.quantity === undefined && body.purchased === undefined) {
          return res.status(400).json({ error: "Send a quantity or purchased: true/false." });
        }
        let row = null;
        if (body.quantity !== undefined) {
          row = await setItemQuantity(store, req.userId, req.params.id, body.quantity);
          if (!row) return res.status(404).json({ error: "That item isn't in your basket any more." });
        }
        if (body.purchased !== undefined) {
          if (typeof body.purchased !== "boolean") return res.status(400).json({ error: "purchased must be true or false" });
          row = await store.setPurchased(req.userId, req.params.id, body.purchased);
          if (!row) return res.status(404).json({ error: "Grocery list item not found" });
        }
        res.json(row);
      } catch (err) {
        if (err.code === "23505") return res.status(409).json({ error: "That item is already on your list." });
        fail(res, err, "Failed to update grocery list item");
      }
    },

    async removeFromList(req, res) {
      try {
        if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: "Grocery list item not found" });
        await store.deleteListItem(req.userId, req.params.id);
        res.status(204).send();
      } catch (err) {
        fail(res, err, "Failed to remove grocery list item");
      }
    },
  };
}

function registerSmartBasketRoutes(app, requireAuth, routes, { priceLimiter } = {}) {
  const priceGuard = priceLimiter ? [requireAuth, priceLimiter] : [requireAuth];
  app.get("/api/smart-basket", requireAuth, routes.getSuggestions);
  app.get("/api/smart-basket/price", ...priceGuard, routes.getPrice);
  app.post("/api/smart-basket/skip", requireAuth, routes.skip);
  app.post("/api/smart-basket/hide", requireAuth, routes.hide);
  app.get("/api/smart-basket/hidden", requireAuth, routes.listHidden);
  app.delete("/api/smart-basket/hidden/:itemKey", requireAuth, routes.restore);
  app.get("/api/grocery-list", requireAuth, routes.getList);
  app.post("/api/grocery-list", requireAuth, routes.addToList);
  app.put("/api/grocery-list/:id", requireAuth, routes.updateListItem);
  app.delete("/api/grocery-list/:id", requireAuth, routes.removeFromList);
}

module.exports = {
  SKIP_COOLDOWN_DAYS,
  PRICE_CACHE_HOURS,
  MAX_LIVE_PRICE_LOOKUPS,
  MIN_PERSONAL_SUGGESTIONS,
  normaliseKey,
  singular,
  filterPurchaseSignals,
  buildPersonalCandidates,
  filterCandidates,
  composeSuggestions,
  titleMatches,
  parseSize,
  toOffers,
  matchSupplier,
  dropPriceOutliers,
  pickCheapest,
  priceCacheKey,
  addItemToList,
  setItemQuantity,
  cleanItemInput,
  MAX_QUANTITY,
  setSuggestionState,
  loadSuggestions,
  priceItem,
  createSmartBasketRoutes,
  registerSmartBasketRoutes,
};
