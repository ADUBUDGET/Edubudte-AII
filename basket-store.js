// Postgres queries for the basket and checkout (see basket.js). Every query
// is scoped to the signed-in user's id.
const { sql } = require("./db");
const smartBasketStore = require("./smart-basket-store");

// Postgres advisory-lock namespace for "one checkout per student at a time".
const CHECKOUT_LOCK = 4217;

module.exports = {
  getList: userId => smartBasketStore.getList(userId),

  // Same formula as the Dashboard's available balance.
  async getBudgetNumbers(userId) {
    const [row] = await sql`
      SELECT COALESCE(u.monthly_budget, 0) AS monthly_budget,
             (SELECT COALESCE(SUM(amount), 0) FROM budget_log WHERE user_id = ${userId}) AS total_spent
      FROM users u WHERE u.id = ${userId}
    `;
    return { monthlyBudget: Number(row?.monthly_budget || 0), totalSpent: Number(row?.total_spent || 0) };
  },

  async getActiveItemsByIds(userId, ids) {
    return sql`
      SELECT * FROM grocery_list
      WHERE user_id = ${userId} AND id = ANY(${ids}::int[]) AND purchased_at IS NULL
    `;
  },

  // Confirms a purchase in ONE transaction. A per-student advisory lock makes
  // two checkouts from the same student run one after the other, so the
  // second always sees the first's deduction and bought items. The single
  // statement then only inserts anything if: this client_ref is new, every
  // item is still in the basket, a budget is set, and the balance covers
  // the amount. Otherwise nothing is written and the numbers explain why.
  async checkoutAtomic(userId, { itemIds, amount, clientRef, estimatedTotal, description }) {
    const n = itemIds.length;
    const results = await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(${CHECKOUT_LOCK}, ${userId})`,
      sql`
        WITH bal AS (
          SELECT COALESCE(u.monthly_budget, 0)::numeric AS monthly,
                 COALESCE(u.monthly_budget, 0)::numeric
                   - (SELECT COALESCE(SUM(amount), 0) FROM budget_log WHERE user_id = ${userId}) AS available
          FROM users u WHERE u.id = ${userId}
        ),
        prev AS (
          SELECT id, amount, item_count, created_at FROM purchases WHERE user_id = ${userId} AND client_ref = ${clientRef}
        ),
        target AS (
          SELECT id FROM grocery_list
          WHERE user_id = ${userId} AND id = ANY(${itemIds}::int[]) AND purchased_at IS NULL
        ),
        ok AS (
          SELECT 1 FROM bal
          WHERE NOT EXISTS (SELECT 1 FROM prev)
            AND (SELECT COUNT(*) FROM target) = ${n}
            AND bal.monthly > 0
            AND bal.available >= ${amount}::numeric
        ),
        ins AS (
          INSERT INTO purchases (user_id, client_ref, amount, estimated_total, item_count)
          SELECT ${userId}, ${clientRef}, ${amount}::numeric, ${estimatedTotal}::numeric, ${n} FROM ok
          RETURNING id, amount, item_count, created_at
        ),
        marked AS (
          UPDATE grocery_list g SET purchased_at = NOW(), purchase_id = ins.id, updated_at = NOW()
          FROM ins
          WHERE g.user_id = ${userId} AND g.id = ANY(${itemIds}::int[]) AND g.purchased_at IS NULL
          RETURNING g.id
        ),
        logged AS (
          INSERT INTO budget_log (user_id, amount, category, description, purchase_id)
          SELECT ${userId}, ${amount}::numeric, 'Groceries', ${description}, ins.id FROM ins
          RETURNING id
        )
        SELECT (SELECT row_to_json(ins) FROM ins) AS purchase,
               (SELECT row_to_json(prev) FROM prev) AS previous,
               (SELECT COUNT(*) FROM marked)::int AS marked,
               (SELECT COUNT(*) FROM logged)::int AS logged,
               (SELECT COUNT(*) FROM target)::int AS active_count,
               (SELECT available FROM bal) AS available_before,
               (SELECT monthly FROM bal) AS monthly
      `,
    ]);
    const row = results[1][0];
    const shape = p => (p ? { id: p.id, amount: Number(p.amount), itemCount: p.item_count, createdAt: p.created_at } : null);
    return {
      purchase: shape(row.purchase),
      duplicateOf: shape(row.previous),
      activeCount: row.active_count,
      availableBefore: Number(row.available_before),
      monthlyBudget: Number(row.monthly),
    };
  },
};
