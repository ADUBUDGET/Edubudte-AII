// Postgres queries for favourites (see favourites.js). Every query is scoped
// to the signed-in user's id.
const { sql } = require("./db");

module.exports = {
  // Still-to-buy first, then purchased; newest first within each.
  async listFavourites(userId) {
    return sql`
      SELECT * FROM favourites WHERE user_id = ${userId}
      ORDER BY (purchased_at IS NOT NULL), created_at DESC
    `;
  },

  async findFavouriteByKey(userId, itemKey) {
    const [row] = await sql`SELECT * FROM favourites WHERE user_id = ${userId} AND item_key = ${itemKey} LIMIT 1`;
    return row || null;
  },

  async insertFavourite(userId, f) {
    const [row] = await sql`
      INSERT INTO favourites (user_id, item_name, item_key, store_name, price, link, thumbnail, supplier_id, product_id, price_checked_at)
      VALUES (${userId}, ${f.itemName}, ${f.itemKey}, ${f.storeName}, ${f.price}, ${f.link}, ${f.thumbnail},
              ${f.supplierId ?? null}, ${f.productId ?? null}, ${f.priceCheckedAt ?? null})
      RETURNING *
    `;
    return row;
  },

  // Saving an existing favourite again keeps its purchased state but takes
  // the newest store/price details when they were given.
  async refreshFavourite(userId, id, f) {
    const [row] = await sql`
      UPDATE favourites
      SET store_name = COALESCE(${f.storeName}, store_name),
          price = COALESCE(${f.price}, price),
          link = COALESCE(${f.link}, link),
          thumbnail = COALESCE(${f.thumbnail}, thumbnail),
          supplier_id = CASE WHEN ${f.price != null} THEN ${f.supplierId ?? null} ELSE supplier_id END,
          product_id = CASE WHEN ${f.price != null} THEN ${f.productId ?? null} ELSE product_id END,
          price_checked_at = CASE WHEN ${f.price != null} THEN ${f.priceCheckedAt ?? null}::timestamptz ELSE price_checked_at END,
          updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `;
    return row;
  },

  async updateFavourite(userId, id, e) {
    const hasPurchased = e.purchased !== undefined;
    const [row] = await sql`
      UPDATE favourites
      SET item_name = COALESCE(${e.itemName ?? null}, item_name),
          item_key = COALESCE(${e.itemKey ?? null}, item_key),
          store_name = CASE WHEN ${e.storeName !== undefined} THEN ${e.storeName ?? null} ELSE store_name END,
          price = CASE WHEN ${e.price !== undefined} THEN ${e.price ?? null}::numeric ELSE price END,
          purchased_at = CASE WHEN ${hasPurchased} THEN
                           (CASE WHEN ${e.purchased === true} THEN COALESCE(purchased_at, NOW()) ELSE NULL END)
                         ELSE purchased_at END,
          updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `;
    return row || null;
  },

  async deleteFavourite(userId, id) {
    await sql`DELETE FROM favourites WHERE id = ${id} AND user_id = ${userId}`;
  },

  async clearPurchased(userId) {
    const rows = await sql`
      UPDATE favourites SET purchased_at = NULL, updated_at = NOW()
      WHERE user_id = ${userId} AND purchased_at IS NOT NULL
      RETURNING id
    `;
    return rows.length;
  },
};
