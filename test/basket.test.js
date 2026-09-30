// Tests for the basket totals, Budget Bank maths and "Confirm purchase".
// The fake store follows the same rules as basket-store.js checkoutAtomic;
// the real transaction is exercised end to end against the database too
// (see README > Tests).
const test = require("node:test");
const assert = require("node:assert/strict");
const basket = require("../basket");

function fakeStore({ monthlyBudget = 1000, spent = 0 } = {}) {
  const data = {
    users: new Map([[1, { monthlyBudget }], [2, { monthlyBudget: 500 }]]),
    log: spent ? [{ user_id: 1, amount: spent }] : [],
    purchases: [],
    items: [
      { id: 1, user_id: 1, item_name: "Rice 2kg", price: "39.99", quantity: 2, purchased_at: null },
      { id: 2, user_id: 1, item_name: "Milk 1L", price: "18.50", quantity: 3, purchased_at: null },
      { id: 3, user_id: 1, item_name: "Hand-typed item", price: null, quantity: 1, purchased_at: null },
      { id: 4, user_id: 2, item_name: "Someone else's bread", price: "20", quantity: 1, purchased_at: null },
    ],
  };
  const spentBy = userId => data.log.filter(l => l.user_id === userId).reduce((a, l) => a + Number(l.amount), 0);
  return {
    data,
    async getList(userId) { return data.items.filter(i => i.user_id === userId); },
    async getBudgetNumbers(userId) { return { monthlyBudget: data.users.get(userId)?.monthlyBudget || 0, totalSpent: spentBy(userId) }; },
    async getActiveItemsByIds(userId, ids) { return data.items.filter(i => i.user_id === userId && ids.includes(i.id) && !i.purchased_at); },
    async checkoutAtomic(userId, { itemIds, amount, clientRef, estimatedTotal }) {
      const monthly = data.users.get(userId)?.monthlyBudget || 0;
      const availableBefore = monthly - spentBy(userId);
      const prev = data.purchases.find(p => p.user_id === userId && p.client_ref === clientRef);
      const active = data.items.filter(i => i.user_id === userId && itemIds.includes(i.id) && !i.purchased_at);
      const base = { activeCount: active.length, availableBefore, monthlyBudget: monthly, purchase: null, duplicateOf: null };
      if (prev) return { ...base, duplicateOf: { id: prev.id, amount: prev.amount } };
      if (active.length !== itemIds.length || monthly <= 0 || availableBefore < amount) return base;
      const purchase = { id: data.purchases.length + 1, user_id: userId, client_ref: clientRef, amount, estimatedTotal, itemCount: itemIds.length };
      data.purchases.push(purchase);
      active.forEach(i => { i.purchased_at = new Date(); i.purchase_id = purchase.id; });
      data.log.push({ user_id: userId, amount, purchase_id: purchase.id });
      return { ...base, purchase: { id: purchase.id, amount, itemCount: itemIds.length } };
    },
  };
}

const ref = n => "checkout-" + String(n).padStart(4, "0");
const fakeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

test("basket totals use quantity x saved price and count unpriced items separately", () => {
  const store = fakeStore();
  const totals = basket.summariseItems(store.data.items.filter(i => i.user_id === 1));
  assert.deepEqual(totals, { itemCount: 3, quantity: 6, estimatedTotal: 135.48, unpricedCount: 1 });
});

test("bought items don't count towards the basket total", () => {
  const totals = basket.summariseItems([
    { price: "10", quantity: 2, purchased_at: null },
    { price: "99", quantity: 1, purchased_at: new Date() },
  ]);
  assert.equal(totals.estimatedTotal, 20);
  assert.equal(totals.itemCount, 1);
});

test("budget view: ok, close to the limit, over budget, and no budget set", () => {
  assert.equal(basket.budgetView({ monthlyBudget: 1000, totalSpent: 200 }, 100).status, "ok");
  const close = basket.budgetView({ monthlyBudget: 1000, totalSpent: 850 }, 100);
  assert.deepEqual([close.status, close.afterBasket], ["close", 50]);
  const over = basket.budgetView({ monthlyBudget: 1000, totalSpent: 950 }, 135.48);
  assert.deepEqual([over.status, over.available, over.overBy], ["over", 50, 85.48]);
  assert.equal(basket.budgetView({ monthlyBudget: 0, totalSpent: 0 }, 10).status, "no_budget");
});

test("checkout input: items, amount in rands and cents, and a client reference", () => {
  const ok = { itemIds: [1, 2, 2], amountPaid: "135.48", clientRef: ref(1) };
  assert.deepEqual(basket.cleanCheckout(ok), { itemIds: [1, 2], amount: 135.48, clientRef: ref(1) });
  const bad = [
    { ...ok, itemIds: [] },
    { ...ok, itemIds: ["x"] },
    { ...ok, amountPaid: "" },
    { ...ok, amountPaid: 0 },
    { ...ok, amountPaid: -5 },
    { ...ok, amountPaid: 1e6 },
    { ...ok, amountPaid: 10.123 },
    { ...ok, clientRef: "short" },
    { ...ok, clientRef: "has spaces in it!" },
  ];
  for (const b of bad) assert.throws(() => basket.cleanCheckout(b), { status: 400 }, JSON.stringify(b));
});

test("confirming a purchase deducts exactly the amount paid and moves the items to Bought", async () => {
  const store = fakeStore();
  const out = await basket.checkout(store, 1, { itemIds: [1, 2], amountPaid: 130, clientRef: ref(1) });
  assert.equal(out.duplicate, false);
  assert.equal(out.purchase.amount, 130);
  assert.equal(out.budget.available, 870);
  assert.ok(store.data.items.find(i => i.id === 1).purchased_at);
  assert.equal(store.data.items.find(i => i.id === 3).purchased_at, null, "items not selected stay in the basket");
  assert.equal(store.data.log.length, 1);
});

test("the same tap sent twice is only charged once", async () => {
  const store = fakeStore();
  await basket.checkout(store, 1, { itemIds: [1], amountPaid: 79.98, clientRef: ref(2) });
  const again = await basket.checkout(store, 1, { itemIds: [1], amountPaid: 79.98, clientRef: ref(2) });
  assert.equal(again.duplicate, true);
  assert.equal(store.data.log.length, 1);
  assert.equal(again.budget.available, 920.02);
});

test("items already bought can't be charged again (e.g. from another tab)", async () => {
  const store = fakeStore();
  await basket.checkout(store, 1, { itemIds: [1], amountPaid: 79.98, clientRef: ref(3) });
  await assert.rejects(basket.checkout(store, 1, { itemIds: [1, 2], amountPaid: 50, clientRef: ref(4) }), { status: 409, code: "stale_items" });
  assert.equal(store.data.log.length, 1);
});

test("a purchase that would take the balance below R0 is refused", async () => {
  const store = fakeStore({ monthlyBudget: 1000, spent: 950 });
  await assert.rejects(basket.checkout(store, 1, { itemIds: [1, 2], amountPaid: 135.48, clientRef: ref(5) }),
    err => err.status === 422 && err.code === "insufficient_funds" && /R85\.48 more than you have left \(R50\.00 available\)/.test(err.message));
  assert.equal(store.data.log.length, 1, "nothing new logged");
  // Exactly the remaining balance is fine (balance ends at R0.00, not below).
  const out = await basket.checkout(store, 1, { itemIds: [2], amountPaid: 50, clientRef: ref(6) });
  assert.equal(out.budget.available, 0);
});

test("a monthly budget must be set before confirming purchases", async () => {
  const store = fakeStore({ monthlyBudget: 0 });
  await assert.rejects(basket.checkout(store, 1, { itemIds: [1], amountPaid: 10, clientRef: ref(7) }), { status: 422, code: "no_budget" });
});

test("one student can't buy another student's basket items", async () => {
  const store = fakeStore();
  await assert.rejects(basket.checkout(store, 1, { itemIds: [4], amountPaid: 20, clientRef: ref(8) }), { status: 409 });
  assert.equal(store.data.items.find(i => i.id === 4).purchased_at, null);
});

test("GET /api/basket returns only this student's items with totals and budget", async () => {
  const routes = basket.createBasketRoutes({ store: fakeStore({ spent: 100 }) });
  const res = fakeRes();
  await routes.get({ userId: 1 }, res);
  assert.equal(res.body.items.length, 3);
  assert.equal(res.body.totals.estimatedTotal, 135.48);
  assert.deepEqual([res.body.budget.available, res.body.budget.afterBasket, res.body.budget.status], [900, 764.52, "ok"]);
});

test("checkout route: 201 on success, 200 for a repeat, clear errors otherwise", async () => {
  const routes = basket.createBasketRoutes({ store: fakeStore() });
  const a = fakeRes();
  await routes.checkout({ userId: 1, body: { itemIds: [1], amountPaid: 79.98, clientRef: ref(9) } }, a);
  const b = fakeRes();
  await routes.checkout({ userId: 1, body: { itemIds: [1], amountPaid: 79.98, clientRef: ref(9) } }, b);
  const c = fakeRes();
  await routes.checkout({ userId: 1, body: { itemIds: [2], amountPaid: "abc", clientRef: ref(10) } }, c);
  assert.deepEqual([a.statusCode, b.statusCode, c.statusCode], [201, 200, 400]);
  assert.match(c.body.error, /amount you paid/);
});
