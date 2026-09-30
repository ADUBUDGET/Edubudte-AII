// ---------------------------------------------------------------
// BASKET + BUDGET BANK: totals, the budget check, and "Confirm purchase".
//
// The basket is the student's active grocery list (grocery_list rows not
// yet bought). Every total here comes from the database - quantities and
// prices saved on the rows - never from numbers the page sends, and the
// Budget Bank balance uses the same formula as the Dashboard:
//   available = monthly budget - everything logged in budget_log.
//
// Confirm purchase (checkout) records what the student paid (pre-filled
// with the estimate, editable to match the till slip), deducts it by
// adding one budget_log entry, and moves the items to "Bought" - all in one
// database transaction (see basket-store.js), and:
//   - never takes the balance below R0 (and needs a monthly budget set),
//   - never charges the same items twice (items already bought are refused),
//   - never charges one tap twice (client_ref makes retries idempotent).
// Store: basket-store.js; tests use an in-memory fake.
// ---------------------------------------------------------------

const { normaliseKey } = require("./text-keys");
const { cleanShoppingResults } = require("./suppliers");

// A saved basket price counts as current for this long after it was
// checked against the real listing; after that it's labelled with its date
// and "Refresh prices" re-checks it.
const PRICE_FRESH_HOURS = 24;
const MAX_REFRESH_ITEMS = 8;

// "current" | "stale" (older than PRICE_FRESH_HOURS, or never dated) |
// "not_listed" (the listing wasn't found at the last refresh) | "unknown" (no price)
function priceStatusOf(item, now = new Date()) {
  if (item.price == null) return "unknown";
  if (item.availability === "not_listed") return "not_listed";
  if (!item.price_checked_at) return "stale";
  return now - new Date(item.price_checked_at) <= PRICE_FRESH_HOURS * 60 * 60 * 1000 ? "current" : "stale";
}

// The same real listing in fresh results: same product id at the same
// supplier, or (for items saved without an id) the same supplier and title.
function matchListing(item, cleanedResults) {
  const sameSupplier = r => r.supplierId === item.supplier_id;
  if (item.product_id) {
    const byId = cleanedResults.find(r => sameSupplier(r) && r.product_id === item.product_id);
    if (byId) return byId;
  }
  const title = normaliseKey(item.product_title || item.item_name);
  return cleanedResults.find(r => sameSupplier(r) && normaliseKey(r.title) === title) || null;
}

// Re-checks stale basket prices against real Google Shopping data (cached
// for a few hours, so several students refreshing the same product share
// one lookup). `lookup(term)` -> { results, fetchedAt }.
async function refreshPrices(store, userId, { lookup, now = new Date(), maxItems = MAX_REFRESH_ITEMS }) {
  const items = (await store.getList(userId)).filter(i => !i.purchased_at && i.supplier_id && ["stale", "not_listed"].includes(priceStatusOf(i, now)));
  const out = { checked: 0, changed: 0, confirmed: 0, notListed: 0, failed: 0, skipped: Math.max(0, items.length - maxItems) };
  for (const item of items.slice(0, maxItems)) {
    out.checked++;
    try {
      const { results, fetchedAt } = await lookup(item.product_title || item.item_name);
      const match = matchListing(item, cleanShoppingResults(results).results);
      if (match) {
        if (Number(match.extracted_price) !== Number(item.price)) out.changed++; else out.confirmed++;
        await store.updateItemPrice(userId, item.id, {
          price: match.extracted_price, priceCheckedAt: fetchedAt, availability: "listed",
          productId: match.product_id, link: match.link, thumbnail: match.thumbnail,
        });
      } else {
        out.notListed++;
        await store.updateItemPrice(userId, item.id, { availability: "not_listed" });
      }
    } catch (err) {
      out.failed++;
    }
  }
  return out;
}

const MAX_CHECKOUT_ITEMS = 100;
const MAX_AMOUNT = 100000;
const round2 = n => Math.round(Number(n) * 100) / 100;

function error(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// Line and basket totals. Items without a price can't be estimated, so
// they're counted separately and shown as "price unknown".
function summariseItems(items) {
  const active = items.filter(i => !i.purchased_at);
  let estimatedTotal = 0;
  let unpricedCount = 0;
  let quantity = 0;
  for (const i of active) {
    const qty = Number(i.quantity) || 1;
    quantity += qty;
    if (i.price == null || !Number.isFinite(Number(i.price))) unpricedCount++;
    else estimatedTotal += Number(i.price) * qty;
  }
  return { itemCount: active.length, quantity, estimatedTotal: round2(estimatedTotal), unpricedCount };
}

// Budget Bank numbers plus how the basket fits.
// status: "no_budget" | "over" | "close" (under 10% of the budget left) | "ok"
function budgetView({ monthlyBudget, totalSpent }, estimatedTotal) {
  const monthly = round2(monthlyBudget || 0);
  const spent = round2(totalSpent || 0);
  const available = round2(monthly - spent);
  const afterBasket = round2(available - estimatedTotal);
  let status = "ok";
  if (monthly <= 0) status = "no_budget";
  else if (afterBasket < 0) status = "over";
  else if (afterBasket < monthly * 0.1) status = "close";
  return { monthlyBudget: monthly, spent, available, afterBasket, overBy: afterBasket < 0 ? round2(-afterBasket) : 0, status };
}

// Validates a checkout request. Returns { itemIds, amount, clientRef }.
function cleanCheckout(body = {}) {
  const ids = Array.isArray(body.itemIds) ? body.itemIds : [];
  const itemIds = [...new Set(ids.map(Number))];
  if (!itemIds.length) throw error(400, "Choose at least one item you bought.");
  if (itemIds.length > MAX_CHECKOUT_ITEMS || itemIds.some(id => !Number.isInteger(id) || id <= 0)) {
    throw error(400, "Those items couldn't be read - refresh your basket and try again.");
  }
  const amount = Number(body.amountPaid);
  if (body.amountPaid === "" || body.amountPaid == null || !Number.isFinite(amount)) throw error(400, "Enter the amount you paid.");
  if (amount <= 0) throw error(400, "The amount paid must be more than R0.");
  if (amount > MAX_AMOUNT) throw error(400, `The amount paid can't be more than R${MAX_AMOUNT.toLocaleString("en-ZA")}.`);
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) throw error(400, "Use rands and cents, e.g. 245.90.");
  const clientRef = typeof body.clientRef === "string" ? body.clientRef.trim() : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clientRef)) throw error(400, "This purchase couldn't be confirmed - refresh the page and try again.");
  return { itemIds, amount: round2(amount), clientRef };
}

async function checkout(store, userId, body) {
  const { itemIds, amount, clientRef } = cleanCheckout(body);
  const items = await store.getActiveItemsByIds(userId, itemIds);
  const estimatedTotal = summariseItems(items).estimatedTotal;
  const result = await store.checkoutAtomic(userId, {
    itemIds, amount, clientRef, estimatedTotal,
    description: `Groceries: ${items.slice(0, 3).map(i => i.item_name).join(", ")}${items.length > 3 ? ` +${items.length - 3} more` : ""}`.slice(0, 200),
  });

  if (result.duplicateOf) {
    // Same tap sent again: nothing new is charged.
    return { duplicate: true, purchase: result.duplicateOf, budget: budgetView(await store.getBudgetNumbers(userId), 0) };
  }
  if (!result.purchase) {
    if (result.monthlyBudget <= 0) throw error(422, "Set your monthly budget on the Profile page before confirming purchases.", "no_budget");
    if (result.activeCount < itemIds.length) throw error(409, "Some of these items were already bought or removed. Your basket has been refreshed - check it and try again.", "stale_items");
    if (result.availableBefore < amount) {
      throw error(422, `That's R${round2(amount - result.availableBefore).toFixed(2)} more than you have left (R${round2(result.availableBefore).toFixed(2)} available). Remove some items or update your budget.`, "insufficient_funds");
    }
    throw error(409, "This purchase couldn't be confirmed. Please try again.", "not_confirmed");
  }
  return { duplicate: false, purchase: result.purchase, budget: budgetView(await store.getBudgetNumbers(userId), 0) };
}

function createBasketRoutes({ store, lookup = null, now = () => new Date() }) {
  const fail = (res, err, message) => {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || null });
    console.error(err);
    res.status(500).json({ error: message });
  };
  return {
    // The basket (active items first, then the last few bought) with totals
    // and the Budget Bank summary. Each item says whether its saved price is
    // current, stale (with the date it was checked) or no longer listed.
    async get(req, res) {
      try {
        const at = now();
        const [rows, numbers] = await Promise.all([store.getList(req.userId), store.getBudgetNumbers(req.userId)]);
        const items = rows.map(i => ({ ...i, price_status: priceStatusOf(i, at) }));
        const totals = summariseItems(items);
        totals.stalePriceCount = items.filter(i => !i.purchased_at && ["stale", "not_listed"].includes(i.price_status)).length;
        res.json({ items, totals, budget: budgetView(numbers, totals.estimatedTotal), priceFreshHours: PRICE_FRESH_HOURS });
      } catch (err) {
        fail(res, err, "Failed to load your basket");
      }
    },
    async refreshPrices(req, res) {
      try {
        if (!lookup) return res.status(503).json({ error: "Price checks aren't available right now." });
        res.json(await refreshPrices(store, req.userId, { lookup, now: now() }));
      } catch (err) {
        fail(res, err, "Prices couldn't be refreshed. Please try again.");
      }
    },
    async checkout(req, res) {
      try {
        const out = await checkout(store, req.userId, req.body);
        res.status(out.duplicate ? 200 : 201).json(out);
      } catch (err) {
        fail(res, err, "Purchase couldn't be confirmed. Nothing was charged - please try again.");
      }
    },
  };
}

function registerBasketRoutes(app, requireAuth, routes, { checkoutLimiter, refreshLimiter } = {}) {
  app.get("/api/basket", requireAuth, routes.get);
  app.post("/api/basket/refresh-prices", ...(refreshLimiter ? [requireAuth, refreshLimiter] : [requireAuth]), routes.refreshPrices);
  app.post("/api/basket/checkout", ...(checkoutLimiter ? [requireAuth, checkoutLimiter] : [requireAuth]), routes.checkout);
}

module.exports = {
  PRICE_FRESH_HOURS, priceStatusOf, matchListing, refreshPrices,
  summariseItems, budgetView, cleanCheckout, checkout, createBasketRoutes, registerBasketRoutes,
};
