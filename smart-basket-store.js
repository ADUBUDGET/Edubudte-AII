// Postgres queries for the Smart Basket (see smart-basket.js). Every query
// that touches personal data is scoped to the signed-in user's id.
const { sql } = require("./db");

module.exports = {
  // How often, and how recently, the user searched for each term.
  async getSearchSignals(userId) {
    return sql`
      SELECT MAX(item_query) AS name, COUNT(*)::int AS count, MAX(created_at) AS "lastAt"
      FROM search_history WHERE user_id = ${userId}
      GROUP BY lower(trim(item_query))
    `;
  },

  // Logged purchases grouped by description (category decides later whether
  // the description is a product - see filterPurchaseSignals).
  async getPurchaseSignals(userId) {
    return sql`
      SELECT MAX(description) AS name, category, COUNT(*)::int AS count, MAX(created_at) AS "lastAt"
      FROM budget_log
      WHERE user_id = ${userId} AND description IS NOT NULL AND trim(description) <> ''
      GROUP BY lower(trim(description)), category
    `;
  },

  // Items the user has ticked off past grocery lists.
  async getListHistorySignals(userId) {
    return sql`
      SELECT MAX(item_name) AS name, COUNT(*)::int AS count, MAX(purchased_at) AS "lastAt"
      FROM grocery_list
      WHERE user_id = ${userId} AND purchased_at IS NOT NULL
      GROUP BY item_key
    `;
  },

  async getActiveListKeys(userId) {
    const rows = await sql`SELECT item_key FROM grocery_list WHERE user_id = ${userId} AND purchased_at IS NULL`;
    return rows.map(r => r.item_key);
  },

  async getStates(userId) {
    return sql`SELECT item_key, status, skipped_until FROM smart_basket_state WHERE user_id = ${userId}`;
  },

  // Anonymous and aggregated: only terms searched by at least `minUsers`
  // different students, and only the term itself is returned.
  async getPopularSearches(minUsers, limit) {
    return sql`
      SELECT MAX(item_query) AS name
      FROM search_history
      GROUP BY lower(trim(item_query))
      HAVING COUNT(DISTINCT user_id) >= ${minUsers}
      ORDER BY COUNT(DISTINCT user_id) DESC, MAX(created_at) DESC
      LIMIT ${limit}
    `;
  },

  // Store specials running today (South African time), from the
  // store_specials table created in server.js. Empty if none are loaded.
  async getActiveSpecials() {
    return sql`
      SELECT store, item, price, was_price, ends_on::text AS ends_on
      FROM store_specials
      WHERE starts_on <= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
        AND ends_on >= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
      LIMIT 500
    `;
  },

  async getCachedPrices(queryKey) {
    const [row] = await sql`SELECT results, fetched_at FROM price_cache WHERE query_key = ${queryKey}`;
    return row ? { results: row.results, fetchedAt: row.fetched_at } : null;
  },

  // fetchedAt lets callers record the same time they report to the student.
  async saveCachedPrices(queryKey, results, fetchedAt = null) {
    await sql`
      INSERT INTO price_cache (query_key, results, fetched_at)
      VALUES (${queryKey}, ${JSON.stringify(results)}::jsonb, COALESCE(${fetchedAt}::timestamptz, NOW()))
      ON CONFLICT (query_key) DO UPDATE SET results = EXCLUDED.results, fetched_at = EXCLUDED.fetched_at
    `;
  },

  async upsertState(userId, { itemKey, itemName, status, skippedUntil }) {
    await sql`
      INSERT INTO smart_basket_state (user_id, item_key, item_name, status, skipped_until, updated_at)
      VALUES (${userId}, ${itemKey}, ${itemName}, ${status}, ${skippedUntil}, NOW())
      ON CONFLICT (user_id, item_key) DO UPDATE
      SET item_name = EXCLUDED.item_name, status = EXCLUDED.status,
          skipped_until = EXCLUDED.skipped_until, updated_at = NOW()
    `;
  },

  async deleteState(userId, itemKey) {
    await sql`DELETE FROM smart_basket_state WHERE user_id = ${userId} AND item_key = ${itemKey}`;
  },

  async getHidden(userId) {
    return sql`
      SELECT item_key, item_name, updated_at FROM smart_basket_state
      WHERE user_id = ${userId} AND status = 'hidden' ORDER BY updated_at DESC
    `;
  },

  async getRemainingBudget(userId) {
    const [user] = await sql`SELECT monthly_budget FROM users WHERE id = ${userId}`;
    const [{ total_spent }] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total_spent FROM budget_log WHERE user_id = ${userId}
    `;
    const budget = Number(user?.monthly_budget) || 0;
    return budget > 0 ? budget - Number(total_spent) : null;
  },

  async findActiveListItem(userId, itemKey) {
    const [row] = await sql`
      SELECT * FROM grocery_list
      WHERE user_id = ${userId} AND item_key = ${itemKey} AND purchased_at IS NULL
    `;
    return row || null;
  },

  async insertListItem(userId, item) {
    const [row] = await sql`
      INSERT INTO grocery_list (user_id, item_name, item_key, product_title, supplier_id, store_name, price,
                                quantity, unit, category, link, thumbnail, added_from,
                                product_id, price_checked_at, availability)
      VALUES (${userId}, ${item.itemName}, ${item.itemKey}, ${item.productTitle}, ${item.supplierId ?? null}, ${item.storeName},
              ${item.price}, ${item.quantity ?? 1}, ${item.unit ?? null}, ${item.category ?? null}, ${item.link}, ${item.thumbnail}, ${item.addedFrom},
              ${item.productId ?? null}, ${item.priceCheckedAt ?? null}, ${item.price != null ? "listed" : null})
      RETURNING *
    `;
    return row;
  },

  // Adding a product that's already in the basket: new quantity, and the
  // new shop/price details when they were given (fields left out are kept).
  async mergeListItem(userId, id, m) {
    const has = k => Object.prototype.hasOwnProperty.call(m, k);
    const [row] = await sql`
      UPDATE grocery_list
      SET quantity = ${m.quantity},
          supplier_id = CASE WHEN ${has("supplierId")} THEN ${m.supplierId ?? null} ELSE supplier_id END,
          store_name = CASE WHEN ${has("storeName")} THEN ${m.storeName ?? null} ELSE store_name END,
          price = CASE WHEN ${has("price")} THEN ${m.price ?? null}::numeric ELSE price END,
          product_title = CASE WHEN ${has("productTitle")} THEN ${m.productTitle ?? null} ELSE product_title END,
          link = CASE WHEN ${has("link")} THEN ${m.link ?? null} ELSE link END,
          thumbnail = CASE WHEN ${has("thumbnail")} THEN ${m.thumbnail ?? null} ELSE thumbnail END,
          unit = CASE WHEN ${has("unit")} THEN ${m.unit ?? null} ELSE unit END,
          product_id = CASE WHEN ${has("productId")} THEN ${m.productId ?? null} ELSE product_id END,
          price_checked_at = CASE WHEN ${has("priceCheckedAt")} THEN ${m.priceCheckedAt ?? null}::timestamptz ELSE price_checked_at END,
          availability = CASE WHEN ${has("price")} AND ${m.price != null} THEN 'listed' ELSE availability END,
          updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `;
    return row;
  },

  async setQuantity(userId, id, quantity) {
    const [row] = await sql`
      UPDATE grocery_list SET quantity = ${quantity}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId} AND purchased_at IS NULL
      RETURNING *
    `;
    return row || null;
  },

  async updateListItemPrice(userId, id, item) {
    const [row] = await sql`
      UPDATE grocery_list
      SET product_title = ${item.productTitle}, store_name = ${item.storeName}, price = ${item.price},
          link = ${item.link}, thumbnail = COALESCE(${item.thumbnail}, thumbnail), updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `;
    return row;
  },

  // Active items first, then the most recently ticked-off ones.
  async getList(userId) {
    return sql`
      SELECT * FROM grocery_list WHERE user_id = ${userId}
      ORDER BY (purchased_at IS NULL) DESC, COALESCE(purchased_at, created_at) DESC
      LIMIT 100
    `;
  },

  // Putting a bought item back in the basket also unlinks it from the
  // purchase it was paid in (the payment itself stays in the budget log).
  async setPurchased(userId, id, purchased) {
    const [row] = await sql`
      UPDATE grocery_list
      SET purchased_at = ${purchased ? new Date() : null},
          purchase_id = CASE WHEN ${purchased} THEN purchase_id ELSE NULL END,
          updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `;
    return row || null;
  },

  async deleteListItem(userId, id) {
    await sql`DELETE FROM grocery_list WHERE id = ${id} AND user_id = ${userId}`;
  },
};
