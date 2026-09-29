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

function createBasketRoutes({ store }) {
  const fail = (res, err, message) => {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code || null });
    console.error(err);
    res.status(500).json({ error: message });
  };
  return {
    // The basket (active items first, then the last few bought) with totals
    // and the Budget Bank summary.
    async get(req, res) {
      try {
        const [items, numbers] = await Promise.all([store.getList(req.userId), store.getBudgetNumbers(req.userId)]);
        const totals = summariseItems(items);
        res.json({ items, totals, budget: budgetView(numbers, totals.estimatedTotal) });
      } catch (err) {
        fail(res, err, "Failed to load your basket");
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

function registerBasketRoutes(app, requireAuth, routes, { checkoutLimiter } = {}) {
  app.get("/api/basket", requireAuth, routes.get);
  app.post("/api/basket/checkout", ...(checkoutLimiter ? [requireAuth, checkoutLimiter] : [requireAuth]), routes.checkout);
}

module.exports = { summariseItems, budgetView, cleanCheckout, checkout, createBasketRoutes, registerBasketRoutes };
