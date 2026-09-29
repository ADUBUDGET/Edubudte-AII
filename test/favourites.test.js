// Tests for favourites: no duplicates, purchased tick (and undo), per-user data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fav = require("../favourites");

// In-memory version of favourites-store.js, including the unique index.
function fakeStore() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async listFavourites(userId) {
      return rows.filter(r => r.user_id === userId)
        .sort((a, b) => (a.purchased_at ? 1 : 0) - (b.purchased_at ? 1 : 0) || b.id - a.id);
    },
    async findFavouriteByKey(userId, key) { return rows.find(r => r.user_id === userId && r.item_key === key) || null; },
    async insertFavourite(userId, f) {
      if (rows.some(r => r.user_id === userId && r.item_key === f.itemKey)) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      const row = { id: nextId++, user_id: userId, item_name: f.itemName, item_key: f.itemKey, store_name: f.storeName, price: f.price, purchased_at: null };
      rows.push(row);
      return row;
    },
    async refreshFavourite(userId, id, f) {
      const row = rows.find(r => r.id === id && r.user_id === userId);
      if (f.storeName != null) row.store_name = f.storeName;
      if (f.price != null) row.price = f.price;
      return row;
    },
    async updateFavourite(userId, id, e) {
      const row = rows.find(r => r.id === Number(id) && r.user_id === userId);
      if (!row) return null;
      if (e.itemName) Object.assign(row, { item_name: e.itemName, item_key: e.itemKey });
      if (e.purchased !== undefined) row.purchased_at = e.purchased ? (row.purchased_at || new Date()) : null;
      return row;
    },
    async deleteFavourite(userId, id) {
      const i = rows.findIndex(r => r.id === Number(id) && r.user_id === userId);
      if (i >= 0) rows.splice(i, 1);
    },
    async clearPurchased(userId) {
      let n = 0;
      rows.filter(r => r.user_id === userId && r.purchased_at).forEach(r => { r.purchased_at = null; n++; });
      return n;
    },
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send() { return this; },
  };
}

test("adds a favourite", async () => {
  const store = fakeStore();
  const { favourite, alreadyExisted } = await fav.addFavourite(store, 1, { itemName: "Clover Milk 2L", storeName: "Shoprite", price: 32.99 });
  assert.equal(alreadyExisted, false);
  assert.equal(favourite.item_key, "clover milk 2l");
});

test("saving the same product again doesn't duplicate it, but refreshes store and price", async () => {
  const store = fakeStore();
  await fav.addFavourite(store, 1, { itemName: "Clover Milk 2L", storeName: "Checkers", price: 34.99 });
  const again = await fav.addFavourite(store, 1, { itemName: "  clover milk 2L!! ", storeName: "Shoprite", price: 32.99 });
  assert.equal(again.alreadyExisted, true);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].store_name, "Shoprite");
  assert.equal(store.rows[0].price, 32.99);
});

test("re-saving keeps the purchased tick", async () => {
  const store = fakeStore();
  const { favourite } = await fav.addFavourite(store, 1, { itemName: "Rice" });
  await fav.updateFavourite(store, 1, favourite.id, { purchased: true });
  await fav.addFavourite(store, 1, { itemName: "rice" });
  assert.ok(store.rows[0].purchased_at);
});

test("duplicate prevention holds when two saves race", async () => {
  const store = fakeStore();
  await fav.addFavourite(store, 1, { itemName: "Eggs" });
  const realFind = store.findFavouriteByKey;
  let first = true;
  store.findFavouriteByKey = async (...a) => (first ? ((first = false), null) : realFind(...a));
  const out = await fav.addFavourite(store, 1, { itemName: "eggs" });
  assert.equal(out.alreadyExisted, true);
  assert.equal(store.rows.length, 1);
});

test("favourites are per user", async () => {
  const store = fakeStore();
  await fav.addFavourite(store, 1, { itemName: "Eggs" });
  const other = await fav.addFavourite(store, 2, { itemName: "Eggs" });
  assert.equal(other.alreadyExisted, false);
});

test("rejects empty names and unsafe links", async () => {
  await assert.rejects(fav.addFavourite(fakeStore(), 1, { itemName: "   " }), { status: 400 });
  assert.equal(fav.cleanFavouriteInput({ itemName: "x", link: "javascript:alert(1)" }).link, null);
});

test("marking purchased keeps the favourite, and it can be undone", async () => {
  const store = fakeStore();
  const { favourite } = await fav.addFavourite(store, 1, { itemName: "Bread" });
  const bought = await fav.updateFavourite(store, 1, favourite.id, { purchased: true });
  assert.ok(bought.purchased_at);
  assert.equal((await store.listFavourites(1)).length, 1);
  const undone = await fav.updateFavourite(store, 1, favourite.id, { purchased: false });
  assert.equal(undone.purchased_at, null);
});

test("ticking twice keeps the original purchase time", async () => {
  const store = fakeStore();
  const { favourite } = await fav.addFavourite(store, 1, { itemName: "Bread" });
  const first = (await fav.updateFavourite(store, 1, favourite.id, { purchased: true })).purchased_at;
  const second = (await fav.updateFavourite(store, 1, favourite.id, { purchased: true })).purchased_at;
  assert.equal(first, second);
});

test("purchased must be a real true/false", async () => {
  const store = fakeStore();
  const { favourite } = await fav.addFavourite(store, 1, { itemName: "Bread" });
  await assert.rejects(fav.updateFavourite(store, 1, favourite.id, { purchased: "yes" }), { status: 400 });
});

test("renaming onto another favourite's name is refused", async () => {
  const store = fakeStore();
  await fav.addFavourite(store, 1, { itemName: "Bread" });
  const { favourite } = await fav.addFavourite(store, 1, { itemName: "Rolls" });
  await assert.rejects(fav.updateFavourite(store, 1, favourite.id, { itemName: "bread" }), { status: 409 });
});

test("one student can't tick another student's favourite", async () => {
  const store = fakeStore();
  const { favourite } = await fav.addFavourite(store, 1, { itemName: "Bread" });
  const routes = fav.createFavouritesRoutes({ store });
  const res = fakeRes();
  await routes.update({ userId: 2, params: { id: String(favourite.id) }, body: { purchased: true } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(store.rows[0].purchased_at, null);
});

test("purchased favourites are listed after the ones still to buy", async () => {
  const store = fakeStore();
  const a = (await fav.addFavourite(store, 1, { itemName: "Apples" })).favourite;
  await fav.addFavourite(store, 1, { itemName: "Bread" });
  await fav.updateFavourite(store, 1, a.id, { purchased: true });
  const list = await store.listFavourites(1);
  assert.deepEqual(list.map(r => r.item_name), ["Bread", "Apples"]);
});

test("routes: 201 for new, 200 with alreadyExisted for duplicates", async () => {
  const routes = fav.createFavouritesRoutes({ store: fakeStore() });
  const a = fakeRes();
  await routes.create({ userId: 1, body: { itemName: "Eggs" } }, a);
  const b = fakeRes();
  await routes.create({ userId: 1, body: { itemName: "EGGS" } }, b);
  assert.equal(a.statusCode, 201);
  assert.equal(a.body.alreadyExisted, false);
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.alreadyExisted, true);
});

test("routes: clear-purchased unticks everything for that user only", async () => {
  const store = fakeStore();
  const mine = (await fav.addFavourite(store, 1, { itemName: "Eggs" })).favourite;
  const theirs = (await fav.addFavourite(store, 2, { itemName: "Eggs" })).favourite;
  await fav.updateFavourite(store, 1, mine.id, { purchased: true });
  await fav.updateFavourite(store, 2, theirs.id, { purchased: true });
  const res = fakeRes();
  await fav.createFavouritesRoutes({ store }).clearPurchased({ userId: 1 }, res);
  assert.deepEqual(res.body, { cleared: 1 });
  assert.ok(store.rows.find(r => r.user_id === 2).purchased_at);
});

test("routes: bad ids are 404, not server errors", async () => {
  const routes = fav.createFavouritesRoutes({ store: fakeStore() });
  const res = fakeRes();
  await routes.remove({ userId: 1, params: { id: "abc" } }, res);
  assert.equal(res.statusCode, 404);
});
