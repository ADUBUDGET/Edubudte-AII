// Real-database checks for "Confirm purchase" (basket-store.checkoutAtomic):
// simultaneous checkouts, resent taps, the R0 floor and per-user access.
// Needs DATABASE_URL in .env. Creates temporary users and deletes them.
// Run: npm run test:integration
const path = require("path");
const root = process.cwd();
const { sql, initSchema } = require(path.join(root, "db"));
const basket = require(path.join(root, "basket"));
const store = require(path.join(root, "basket-store"));

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  (" + extra + ")" : ""}`); };
const ref = () => "it-" + Math.random().toString(36).slice(2, 12);

(async () => {
  const log = console.log; console.log = () => {}; await initSchema(); console.log = log;
  const [u] = await sql`INSERT INTO users (name, email, password_hash, monthly_budget) VALUES ('Checkout Test', ${"checkout-it-" + Date.now() + "@example.invalid"}, 'x', 200) RETURNING id`;
  const [other] = await sql`INSERT INTO users (name, email, password_hash, monthly_budget) VALUES ('Other', ${"checkout-it-o-" + Date.now() + "@example.invalid"}, 'x', 200) RETURNING id`;
  try {
    const add = async (name, price, qty, userId = u.id) => (await sql`INSERT INTO grocery_list (user_id, item_name, item_key, price, quantity) VALUES (${userId}, ${name}, ${name.toLowerCase()}, ${price}, ${qty}) RETURNING id`)[0].id;
    const rice = await add("Rice", 39.99, 2);
    const milk = await add("Milk", 18.5, 1);
    const eggs = await add("Eggs", 45, 1);
    const theirs = await add("Bread", 20, 1, other.id);

    // Two checkouts of the same items at the same moment (different taps).
    const both = await Promise.allSettled([
      basket.checkout(store, u.id, { itemIds: [rice, milk], amountPaid: 98.48, clientRef: ref() }),
      basket.checkout(store, u.id, { itemIds: [rice, milk], amountPaid: 98.48, clientRef: ref() }),
    ]);
    const ok = both.filter(r => r.status === "fulfilled");
    const refused = both.filter(r => r.status === "rejected");
    check("simultaneous checkouts of the same items: exactly one charged", ok.length === 1 && refused.length === 1 && refused[0].reason.status === 409,
      `${ok.length} ok, ${refused.map(r => r.reason.status).join(",")}`);
    const [{ spent }] = await sql`SELECT COALESCE(SUM(amount),0)::numeric AS spent FROM budget_log WHERE user_id = ${u.id}`;
    check("one budget_log deduction of R98.48", Number(spent) === 98.48, String(spent));
    const items = await sql`SELECT id, purchased_at, purchase_id FROM grocery_list WHERE user_id = ${u.id} ORDER BY id`;
    check("rice and milk moved to Bought with the purchase id; eggs still in basket",
      items[0].purchase_id && items[1].purchase_id === items[0].purchase_id && !items[2].purchased_at);

    // The same tap resent.
    const tap = ref();
    const first = await basket.checkout(store, u.id, { itemIds: [eggs], amountPaid: 45, clientRef: tap });
    const again = await basket.checkout(store, u.id, { itemIds: [eggs], amountPaid: 45, clientRef: tap });
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM budget_log WHERE user_id = ${u.id}`;
    check("resent tap is recognised as a duplicate and not charged again", !first.duplicate && again.duplicate && n === 2 && again.purchase.id === first.purchase.id);
    check("available balance is R56.52 after R143.48 of purchases", first.budget.available === 56.52, String(first.budget.available));

    // More than the balance.
    const bread = await add("Bread", 60, 1);
    try {
      await basket.checkout(store, u.id, { itemIds: [bread], amountPaid: 60, clientRef: ref() });
      check("purchase above the balance refused", false);
    } catch (e) {
      check("purchase above the balance refused, nothing written", e.status === 422 && e.code === "insufficient_funds");
    }
    const [{ n: n2 }] = await sql`SELECT COUNT(*)::int AS n FROM purchases WHERE user_id = ${u.id}`;
    check("no purchase row for the refused attempt", n2 === 2, String(n2));
    const out = await basket.checkout(store, u.id, { itemIds: [bread], amountPaid: 56.52, clientRef: ref() });
    check("paying exactly the balance leaves R0.00, never negative", out.budget.available === 0, String(out.budget.available));

    // Another student's item.
    try {
      await basket.checkout(store, u.id, { itemIds: [theirs], amountPaid: 1, clientRef: ref() });
      check("another student's item refused", false);
    } catch (e) {
      check("another student's item refused", e.status === 409 || e.status === 422, String(e.status));
    }
    const [t] = await sql`SELECT purchased_at FROM grocery_list WHERE id = ${theirs}`;
    check("their item untouched", !t.purchased_at);
  } finally {
    await sql`DELETE FROM users WHERE id IN (${u.id}, ${other.id})`;
    const [left] = await sql`SELECT COUNT(*)::int AS n FROM purchases WHERE user_id IN (${u.id}, ${other.id})`;
    console.log(`cleanup: test users deleted (purchases left: ${left.n})\n\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})().catch(e => { console.error(e); process.exit(1); });
