// Postgres queries for the shopping area and cached branch locations
// (see location.js). The student's area is stored on their own users row.
const { sql } = require("./db");

module.exports = {
  async getUserLocation(userId) {
    const [u] = await sql`
      SELECT location_label, location_lat, location_lng, location_source, search_radius_km, location_updated_at
      FROM users WHERE id = ${userId}
    `;
    if (!u) return null;
    return {
      label: u.location_label,
      lat: u.location_lat != null ? Number(u.location_lat) : null,
      lng: u.location_lng != null ? Number(u.location_lng) : null,
      source: u.location_source,
      radiusKm: u.search_radius_km != null ? Number(u.search_radius_km) : null,
      updatedAt: u.location_updated_at,
    };
  },

  async saveUserLocation(userId, { label, lat, lng, source }) {
    await sql`
      UPDATE users SET location_label = ${label}, location_lat = ${lat}, location_lng = ${lng},
             location_source = ${source}, location_updated_at = NOW()
      WHERE id = ${userId}
    `;
  },

  async clearUserLocation(userId) {
    await sql`
      UPDATE users SET location_label = NULL, location_lat = NULL, location_lng = NULL,
             location_source = NULL, location_updated_at = NOW()
      WHERE id = ${userId}
    `;
  },

  async saveRadius(userId, km) {
    await sql`UPDATE users SET search_radius_km = ${km} WHERE id = ${userId}`;
  },

  async getBranches(supplierId, areaKey) {
    const [row] = await sql`
      SELECT branches, fetched_at FROM store_locations WHERE supplier_id = ${supplierId} AND area_key = ${areaKey}
    `;
    return row ? { branches: row.branches, fetchedAt: row.fetched_at } : null;
  },

  async saveBranches(supplierId, areaKey, branches) {
    await sql`
      INSERT INTO store_locations (supplier_id, area_key, branches, fetched_at)
      VALUES (${supplierId}, ${areaKey}, ${JSON.stringify(branches)}::jsonb, NOW())
      ON CONFLICT (supplier_id, area_key) DO UPDATE SET branches = EXCLUDED.branches, fetched_at = NOW()
    `;
  },
};
