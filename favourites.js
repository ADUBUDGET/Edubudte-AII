// ---------------------------------------------------------------
// FAVOURITES: saved products with a "Purchased" tick, scoped to the
// signed-in user. Logic here is store-agnostic (favourites-store.js in the
// app, an in-memory fake in test/favourites.test.js).
//
// A favourite is one product name per student: saving the same name again
// (any case/punctuation) doesn't add a duplicate - it refreshes the saved
// store/price instead and says so.
// ---------------------------------------------------------------
const { normaliseKey } = require("./smart-basket");

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function cleanFavouriteInput(body = {}) {
  const itemName = typeof body.itemName === "string" ? body.itemName.trim().replace(/\s+/g, " ").slice(0, 200) : "";
  const price = body.price != null && body.price !== "" ? Number(body.price) : null;
  const httpLink = v => (typeof v === "string" && /^https?:\/\//i.test(v) ? v.slice(0, 2000) : null);
  return {
    itemName,
    itemKey: normaliseKey(itemName),
    storeName: typeof body.storeName === "string" && body.storeName.trim() ? body.storeName.trim().slice(0, 120) : null,
    price: Number.isFinite(price) && price >= 0 ? price : null,
    link: httpLink(body.link),
    thumbnail: httpLink(body.thumbnail),
  };
}

// Returns { favourite, alreadyExisted }.
async function addFavourite(store, userId, body) {
  const fav = cleanFavouriteInput(body);
  if (!fav.itemKey) throw badRequest("itemName is required");

  const refresh = async existing => ({
    favourite: await store.refreshFavourite(userId, existing.id, fav),
    alreadyExisted: true,
  });
  const existing = await store.findFavouriteByKey(userId, fav.itemKey);
  if (existing) return refresh(existing);
  try {
    return { favourite: await store.insertFavourite(userId, fav), alreadyExisted: false };
  } catch (err) {
    // Two saves at the same moment: the unique index caught the duplicate.
    if (err.code === "23505") {
      const raced = await store.findFavouriteByKey(userId, fav.itemKey);
      if (raced) return refresh(raced);
    }
    throw err;
  }
}

// PUT body may contain `purchased` (true/false) and/or edits to
// itemName/storeName/price. Returns the updated row or null if not found.
async function updateFavourite(store, userId, id, body = {}) {
  const edits = {};
  if (body.itemName !== undefined) {
    const { itemName, itemKey } = cleanFavouriteInput({ itemName: body.itemName });
    if (!itemKey) throw badRequest("itemName can't be empty");
    const clash = await store.findFavouriteByKey(userId, itemKey);
    if (clash && String(clash.id) !== String(id)) {
      throw Object.assign(new Error("You already have that item in your favourites."), { status: 409 });
    }
    Object.assign(edits, { itemName, itemKey });
  }
  if (body.storeName !== undefined) edits.storeName = cleanFavouriteInput({ storeName: body.storeName }).storeName;
  if (body.price !== undefined) edits.price = cleanFavouriteInput({ price: body.price }).price;
  if (body.purchased !== undefined) {
    if (typeof body.purchased !== "boolean") throw badRequest("purchased must be true or false");
    edits.purchased = body.purchased;
  }
  return store.updateFavourite(userId, id, edits);
}

function createFavouritesRoutes({ store }) {
  const fail = (res, err, message) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: message, detail: err.message });
  };
  const validId = id => /^\d+$/.test(String(id));

  return {
    async list(req, res) {
      try {
        res.json(await store.listFavourites(req.userId));
      } catch (err) {
        fail(res, err, "Failed to fetch favourites");
      }
    },
    // Responds with the favourite row (as before) plus `alreadyExisted`.
    async create(req, res) {
      try {
        const { favourite, alreadyExisted } = await addFavourite(store, req.userId, req.body);
        res.status(alreadyExisted ? 200 : 201).json({ ...favourite, alreadyExisted });
      } catch (err) {
        fail(res, err, "Failed to create favourite");
      }
    },
    async update(req, res) {
      try {
        if (!validId(req.params.id)) return res.status(404).json({ error: "Favourite not found" });
        const row = await updateFavourite(store, req.userId, req.params.id, req.body);
        if (!row) return res.status(404).json({ error: "Favourite not found" });
        res.json(row);
      } catch (err) {
        fail(res, err, "Failed to update favourite");
      }
    },
    async remove(req, res) {
      try {
        if (!validId(req.params.id)) return res.status(404).json({ error: "Favourite not found" });
        await store.deleteFavourite(req.userId, req.params.id);
        res.status(204).send();
      } catch (err) {
        fail(res, err, "Failed to delete favourite");
      }
    },
    // "Start a new shop": untick every purchased favourite at once.
    async clearPurchased(req, res) {
      try {
        const cleared = await store.clearPurchased(req.userId);
        res.json({ cleared });
      } catch (err) {
        fail(res, err, "Failed to clear purchased favourites");
      }
    },
  };
}

function registerFavouritesRoutes(app, requireAuth, routes) {
  app.get("/api/favourites", requireAuth, routes.list);
  app.post("/api/favourites", requireAuth, routes.create);
  app.post("/api/favourites/clear-purchased", requireAuth, routes.clearPurchased);
  app.put("/api/favourites/:id", requireAuth, routes.update);
  app.delete("/api/favourites/:id", requireAuth, routes.remove);
}

module.exports = { cleanFavouriteInput, addFavourite, updateFavourite, createFavouritesRoutes, registerFavouritesRoutes };
