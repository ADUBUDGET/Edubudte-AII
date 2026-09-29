// Tests for approved-supplier validation (suppliers.js) and the specials
// import check that uses it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { matchSupplier, offerProblem, cleanShoppingResults, SUPPLIERS } = require("../suppliers");
const { normaliseRow } = require("../import-specials");

test("maps the names Google uses to one approved supplier", () => {
  const cases = {
    "Makro - Makro Business": "makro",
    "makro.co.za": "makro",
    "Checkers Sixty60": "checkers",
    "Checkers Hyper": "checkers",
    "Pick n Pay Online": "pick-n-pay",
    "PnP": "pick-n-pay",
    "SUPERSPAR Musgrave": "spar",
    "KwikSpar": "spar",
    "Food Lover's Market": "food-lovers",
    "Dis-Chem": "dis-chem",
    "Game": "game",
    "OK Foods": "ok-foods",
  };
  for (const [name, id] of Object.entries(cases)) {
    assert.equal(matchSupplier(name)?.id, id, name);
  }
});

test("rejects foreign shops, marketplaces and look-alike names", () => {
  for (const name of ["Desertcart.ae", "amazon.co.za", "Takealot", "IndiaBazaar.co.za", "Sparkle Deals",
    "Game Zone Toys", "Le Pro", "World of Books", "Econo Foods", "", null]) {
    assert.equal(matchSupplier(name), null, String(name));
  }
});

test("inactive suppliers are treated as not approved", () => {
  const spar = SUPPLIERS.find(s => s.id === "spar");
  spar.active = false;
  try {
    assert.equal(matchSupplier("SPAR"), null);
    assert.equal(offerProblem({ title: "Bread", price: 20, store: "SPAR" }), "inactive_supplier");
  } finally {
    spar.active = true;
  }
});

test("explains why a product can't be shown", () => {
  assert.equal(offerProblem({ title: "Bread", price: 20, store: "Shoprite" }), null);
  assert.equal(offerProblem({ title: "", price: 20, store: "Shoprite" }), "no_title");
  assert.equal(offerProblem({ title: "Bread", price: null, store: "Shoprite" }), "no_price");
  assert.equal(offerProblem({ title: "Bread", price: -5, store: "Shoprite" }), "bad_price");
  assert.equal(offerProblem({ title: "Bread", price: 20, store: "" }), "no_store");
  assert.equal(offerProblem({ title: "Bread", price: 20, store: "Desertcart.ae" }), "unknown_supplier");
});

test("cleans Google results: approved only, tagged, duplicates collapsed to the cheapest", () => {
  const { results, rejected } = cleanShoppingResults([
    { title: "Sasko Brown Bread 700g", extracted_price: 21.99, source: "Checkers" },
    { title: "Sasko Brown Bread 700g", extracted_price: 19.99, source: "Checkers Sixty60" },
    { title: "Sasko Brown Bread 700g", extracted_price: 20.49, source: "Shoprite" },
    { title: "Brown Bread", extracted_price: 236.77, source: "Desertcart.ae" },
    { title: "Brown Bread", extracted_price: null, source: "Spar" },
  ]);
  assert.deepEqual(results.map(r => `${r.supplierName} ${r.extracted_price}`), ["Checkers 19.99", "Shoprite 20.49"]);
  assert.deepEqual(rejected, { duplicate: 1, unknown_supplier: 1, no_price: 1 });
});

test("specials import rejects unapproved stores and standardises approved names", () => {
  const idx = { store: 0, item: 1, price: 2, was_price: 3, starts_on: 4, ends_on: 5, note: 6 };
  const bad = normaliseRow(["Joe's Tuckshop", "Bread", "10", "", "2026-10-01", "2026-10-07", ""], idx);
  assert.ok(bad.errors.some(e => /not an approved store/.test(e)));
  const good = normaliseRow(["pnp", "Tastic Rice 2kg", "39.99", "49.99", "2026-10-01", "2026-10-07", ""], idx);
  assert.equal(good.row.store, "Pick n Pay");
});
