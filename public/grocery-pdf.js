// Grocery list -> PDF. Two parts:
//   buildGroceryDocument(items, options): plain data (sections, rows, totals)
//     from the signed-in student's /api/basket items - tested in Node.
//   renderGroceryPdf(doc, jsPDF): draws it on A4 with jsPDF (loaded from a
//     CDN on the basket page), paging as needed; printable and readable on
//     a phone.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GroceryPdf = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const BOUGHT_WINDOW_DAYS = 7; // bought items older than this are left out
  const round2 = n => Math.round(Number(n) * 100) / 100;
  const money = n => "R " + round2(n).toFixed(2);
  // The PDF's built-in font only covers Latin characters; keep text safe.
  const clean = t => String(t == null ? "" : t).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "").trim();

  function formatDate(d) {
    return new Date(d).toLocaleDateString("en-ZA", { day: "numeric", month: "long", year: "numeric" }) + ", " +
      new Date(d).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
  }

  function buildGroceryDocument(items, { generatedAt = new Date(), title = "Grocery list" } = {}) {
    const cutoff = new Date(generatedAt).getTime() - BOUGHT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const rows = (items || [])
      .filter(i => !i.purchased_at || new Date(i.purchased_at).getTime() >= cutoff)
      .map(i => {
        const qty = Number(i.quantity) || 1;
        const price = i.price != null && Number.isFinite(Number(i.price)) ? round2(i.price) : null;
        return {
          name: clean(i.item_name) || "Item",
          detail: clean(i.product_title && i.product_title !== i.item_name ? i.product_title : ""),
          quantity: qty,
          unit: clean(i.unit),
          category: clean(i.category) || "Other",
          store: clean(i.store_name),
          price,
          lineTotal: price != null ? round2(price * qty) : null,
          bought: !!i.purchased_at,
        };
      });

    // Group by category (aisle), still-to-buy before bought inside each.
    const byCategory = new Map();
    for (const r of rows) {
      if (!byCategory.has(r.category)) byCategory.set(r.category, []);
      byCategory.get(r.category).push(r);
    }
    const sections = [...byCategory.entries()]
      .sort(([a], [b]) => (a === "Other") - (b === "Other") || a.localeCompare(b))
      .map(([category, list]) => ({ category, rows: list.sort((a, b) => a.bought - b.bought || a.name.localeCompare(b.name)) }));

    const toBuy = rows.filter(r => !r.bought);
    return {
      title: clean(title),
      generatedLabel: "Generated " + formatDate(generatedAt),
      sections,
      empty: rows.length === 0,
      totals: {
        itemCount: rows.length,
        toBuyCount: toBuy.length,
        boughtCount: rows.length - toBuy.length,
        estimatedToBuy: round2(toBuy.reduce((a, r) => a + (r.lineTotal || 0), 0)),
        unpricedToBuy: toBuy.filter(r => r.lineTotal == null).length,
      },
    };
  }

  function fileName(date = new Date()) {
    const d = new Date(date);
    const pad = n => String(n).padStart(2, "0");
    return `grocery-list-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.pdf`;
  }

  // Draws the document with jsPDF (A4 portrait, mm). Returns the jsPDF doc.
  function renderGroceryPdf(model, JsPDF) {
    const pdf = new JsPDF({ unit: "mm", format: "a4" });
    const W = 210, H = 297, M = 16, bottom = H - 18;
    const col = { box: M, name: M + 7, qty: 122, store: 136, price: 168, total: W - M };
    let y = M;

    const header = () => {
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(18); pdf.setTextColor(30, 30, 30);
      pdf.text(model.title, M, y + 6);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(110, 110, 110);
      pdf.text("EduBudget AI - " + model.generatedLabel, M, y + 12);
      y += 20;
    };
    const tableHead = () => {
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5); pdf.setTextColor(110, 110, 110);
      pdf.text("ITEM", col.name, y); pdf.text("QTY", col.qty, y); pdf.text("SHOP", col.store, y);
      pdf.text("PRICE", col.price, y, { align: "right" }); pdf.text("TOTAL", col.total, y, { align: "right" });
      pdf.setDrawColor(200, 200, 200); pdf.line(M, y + 2, W - M, y + 2);
      y += 7;
    };
    const newPage = () => { pdf.addPage(); y = M; header(); tableHead(); };
    const ensure = h => { if (y + h > bottom) newPage(); };

    header();
    if (model.empty) {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(11); pdf.setTextColor(60, 60, 60);
      pdf.text("Your grocery list is empty. Add items from the Shop, Favourites or Smart Basket.", M, y + 4);
      return pdf;
    }
    tableHead();

    for (const section of model.sections) {
      ensure(14);
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(10.5); pdf.setTextColor(180, 90, 0);
      pdf.text(section.category, M, y + 1);
      y += 6;
      for (const r of section.rows) {
        const nameLines = pdf.splitTextToSize(r.name + (r.unit && !r.name.toLowerCase().includes(r.unit.toLowerCase()) ? ` (${r.unit})` : ""), col.qty - col.name - 3);
        const storeLines = pdf.splitTextToSize(r.store || "-", col.price - col.store - 16);
        const lines = Math.max(nameLines.length, storeLines.length);
        const h = lines * 4.6 + 2.4;
        ensure(h);
        // Checkbox: ticked if bought.
        pdf.setDrawColor(120, 120, 120); pdf.rect(col.box, y - 3.2, 3.6, 3.6);
        if (r.bought) { pdf.setDrawColor(40, 140, 60); pdf.line(col.box + 0.6, y - 1.4, col.box + 1.5, y - 0.2); pdf.line(col.box + 1.5, y - 0.2, col.box + 3.1, y - 2.7); }
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(r.bought ? 140 : 30, r.bought ? 140 : 30, r.bought ? 140 : 30);
        pdf.text(nameLines, col.name, y);
        pdf.text(String(r.quantity), col.qty, y);
        pdf.text(storeLines, col.store, y);
        pdf.text(r.price != null ? money(r.price) : "-", col.price, y, { align: "right" });
        pdf.text(r.lineTotal != null ? money(r.lineTotal) : "-", col.total, y, { align: "right" });
        if (r.bought) { pdf.setFontSize(7.5); pdf.setTextColor(40, 140, 60); pdf.text("BOUGHT", col.name, y + nameLines.length * 4.6 - 0.8); }
        y += h + (r.bought ? 2.5 : 0);
      }
      y += 2;
    }

    ensure(24);
    pdf.setDrawColor(200, 200, 200); pdf.line(M, y, W - M, y);
    y += 7;
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(12); pdf.setTextColor(30, 30, 30);
    pdf.text("Estimated total to buy", M, y);
    pdf.text(money(model.totals.estimatedToBuy), col.total, y, { align: "right" });
    y += 6;
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(110, 110, 110);
    const notes = [`${model.totals.toBuyCount} to buy, ${model.totals.boughtCount} bought.`];
    if (model.totals.unpricedToBuy) notes.push(`${model.totals.unpricedToBuy} item(s) without a price are not included in the total.`);
    notes.push("Prices are estimates from online listings and may differ in store.");
    pdf.text(notes.join(" "), M, y, { maxWidth: W - 2 * M });

    const pages = pdf.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8); pdf.setTextColor(150, 150, 150);
      pdf.text(`Page ${p} of ${pages}`, W - M, H - 10, { align: "right" });
    }
    return pdf;
  }

  return { buildGroceryDocument, renderGroceryPdf, fileName, BOUGHT_WINDOW_DAYS };
});
