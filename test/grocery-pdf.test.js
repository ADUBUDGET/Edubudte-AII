// Tests for the grocery-list PDF: document content and the drawing calls
// (with a recording stand-in for jsPDF, so no PDF library is needed here).
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGroceryDocument, renderGroceryPdf, fileName } = require("../public/grocery-pdf");

const NOW = new Date("2026-09-30T10:00:00Z");
const items = [
  { item_name: "Tastic Rice", product_title: "Tastic Long Grain Rice 2kg", unit: "2kg", quantity: 2, price: "39.99", store_name: "Shoprite", category: "Pantry", purchased_at: null },
  { item_name: "Clover Milk", unit: "1L", quantity: 3, price: "18.50", store_name: "Checkers", category: "Dairy & eggs", purchased_at: null },
  { item_name: "Hand-typed onions", quantity: 1, price: null, store_name: null, category: null, purchased_at: null },
  { item_name: "Brown bread", quantity: 1, price: "17.99", store_name: "SPAR", category: "Bakery", purchased_at: "2026-09-29T08:00:00Z" },
  { item_name: "Old purchase", quantity: 1, price: "5", category: "Pantry", purchased_at: "2026-08-01T08:00:00Z" },
];

test("document has title, date, grouped items, statuses and totals", () => {
  const doc = buildGroceryDocument(items, { generatedAt: NOW });
  assert.equal(doc.title, "Grocery list");
  assert.match(doc.generatedLabel, /^Generated 30 September 2026/);
  assert.deepEqual(doc.sections.map(s => s.category), ["Bakery", "Dairy & eggs", "Pantry", "Other"], "alphabetical, Other last");
  const rice = doc.sections.find(s => s.category === "Pantry").rows[0];
  assert.deepEqual(
    { q: rice.quantity, unit: rice.unit, store: rice.store, price: rice.price, total: rice.lineTotal, bought: rice.bought },
    { q: 2, unit: "2kg", store: "Shoprite", price: 39.99, total: 79.98, bought: false });
  assert.equal(doc.sections.find(s => s.category === "Bakery").rows[0].bought, true);
  assert.deepEqual(doc.totals, { itemCount: 4, toBuyCount: 3, boughtCount: 1, estimatedToBuy: 135.48, unpricedToBuy: 1 });
});

test("items bought more than a week ago are left out", () => {
  const doc = buildGroceryDocument(items, { generatedAt: NOW });
  const names = doc.sections.flatMap(s => s.rows.map(r => r.name));
  assert.ok(!names.includes("Old purchase"));
});

test("an empty list is handled gracefully", () => {
  const doc = buildGroceryDocument([], { generatedAt: NOW });
  assert.equal(doc.empty, true);
  assert.equal(doc.totals.estimatedToBuy, 0);
  const pdf = renderGroceryPdf(doc, RecordingPdf);
  assert.ok(pdf.allText().includes("Your grocery list is empty."));
});

test("text is made safe for the PDF font", () => {
  const doc = buildGroceryDocument([{ item_name: "Nando’s “Peri-Peri” sauce – hot 🌶️", quantity: 1, price: "30" }], { generatedAt: NOW });
  assert.equal(doc.sections[0].rows[0].name, `Nando's "Peri-Peri" sauce - hot`);
});

test("file name includes the date", () => {
  assert.equal(fileName(new Date(2026, 8, 30)), "grocery-list-2026-09-30.pdf");
});

// Minimal stand-in for jsPDF that records what would be drawn.
class RecordingPdf {
  constructor() { this.pages = [[]]; this.current = 0; }
  allText() { return this.pages.flat().join("\n"); }
  text(t) { this.pages[this.current].push([].concat(t).join(" ")); }
  splitTextToSize(t) { return [t]; }
  addPage() { this.pages.push([]); this.current = this.pages.length - 1; }
  getNumberOfPages() { return this.pages.length; }
  setPage(n) { this.current = n - 1; }
  setFont() {} setFontSize() {} setTextColor() {} setDrawColor() {} line() {} rect() {}
}

test("the rendered PDF contains every row, prices, totals and a page footer", () => {
  const pdf = renderGroceryPdf(buildGroceryDocument(items, { generatedAt: NOW }), RecordingPdf);
  const text = pdf.allText();
  for (const expected of ["Grocery list", "Tastic Rice", "(2kg)", "Shoprite", "R 39.99", "R 79.98", "Clover Milk", "R 55.50",
    "Hand-typed onions", "BOUGHT", "Estimated total to buy", "R 135.48", "1 item(s) without a price", "Page 1 of 1"]) {
    assert.ok(text.includes(expected), `missing: ${expected}`);
  }
});

test("long lists continue on further pages with the header repeated", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ item_name: "Item " + i, quantity: 1, price: "10", category: "Pantry" }));
  const pdf = renderGroceryPdf(buildGroceryDocument(many, { generatedAt: NOW }), RecordingPdf);
  assert.ok(pdf.getNumberOfPages() >= 2);
  assert.ok(pdf.pages[1].some(t => t === "ITEM"), "table header repeated on page 2");
  assert.ok(pdf.allText().includes(`Page ${pdf.getNumberOfPages()} of ${pdf.getNumberOfPages()}`));
  assert.ok(pdf.allText().includes("R 800.00"));
});
