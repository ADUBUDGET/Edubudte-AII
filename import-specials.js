// Imports store specials from a CSV file into the store_specials table.
//
// Usage (in the VS Code terminal, inside the project folder):
//   node import-specials.js specials.csv
//
// Columns (first row must be the header):
//   store, item, price, was_price, starts_on, ends_on, note
// Required: store, item, starts_on, ends_on. Dates: 2026-10-01 or 01/10/2026 (day/month/year).
// Works with comma- or semicolon-separated files (South African Excel often saves with semicolons).
// Rows that already exist (same store, item and dates) are skipped, so re-importing is safe.
require("dotenv").config();
const fs = require("fs");
const { matchSupplier, SUPPLIERS } = require("./suppliers");

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  let best = ",";
  let bestCount = -1;
  for (const d of [",", ";", "\t"]) {
    let count = 0;
    let inQuotes = false;
    for (const ch of firstLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

// Small CSV reader: handles quotes, doubled quotes, CRLF and a BOM at the start.
function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, "");
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const ALIASES = {
  store: ["store", "shop", "retailer"],
  item: ["item", "product", "special", "description"],
  price: ["price", "special_price", "now"],
  was_price: ["was_price", "was", "old_price", "normal_price"],
  starts_on: ["starts_on", "start", "start_date", "from"],
  ends_on: ["ends_on", "end", "end_date", "until", "valid_until", "to"],
  note: ["note", "notes", "comment"],
};

function mapHeader(cells) {
  const idx = {};
  cells.forEach((cell, i) => {
    const key = String(cell).trim().toLowerCase().replace(/[\s-]+/g, "_");
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(key) && !(field in idx)) idx[field] = i;
    }
  });
  return idx;
}

function parsePrice(value) {
  let v = String(value == null ? "" : value).trim().replace(/^R\s*/i, "").replace(/[\s\u00a0]/g, "");
  if (v === "") return { value: null };
  v = v.replace(",", "."); // South African decimal comma
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return { error: `"${value}" is not a valid price (use a number like 29.99)` };
  return { value: Number(v) };
}

function parseDate(value) {
  const v = String(value == null ? "" : value).trim();
  let y, m, d, match;
  if ((match = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) {
    y = +match[1]; m = +match[2]; d = +match[3];
  } else if ((match = v.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) {
    d = +match[1]; m = +match[2]; y = +match[3]; // day/month/year
  } else {
    return { error: `"${v}" is not a valid date (use 2026-10-01 or 01/10/2026)` };
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { error: `"${v}" is not a real date` };
  }
  return { value: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

// Turns one CSV row into a clean object, or a list of problems.
function normaliseRow(cells, idx) {
  const get = (field) => (field in idx ? String(cells[idx[field]] == null ? "" : cells[idx[field]]).trim() : "");
  const errors = [];
  const store = get("store");
  const item = get("item");
  if (!store) errors.push("store is empty");
  if (!item) errors.push("item is empty");
  if (store.length > 100) errors.push("store is longer than 100 characters");
  if (item.length > 200) errors.push("item is longer than 200 characters");
  // Only approved suppliers (suppliers.js); the store is saved under its
  // standard name so "PnP" and "Pick n Pay" don't become two shops.
  const supplier = store ? matchSupplier(store) : null;
  if (store && !supplier) {
    errors.push(`"${store}" is not an approved store (see suppliers.js: ${SUPPLIERS.filter(s => s.active).map(s => s.name).join(", ")})`);
  }

  const price = parsePrice(get("price"));
  const wasPrice = parsePrice(get("was_price"));
  const start = parseDate(get("starts_on"));
  const end = parseDate(get("ends_on"));
  if (price.error) errors.push("price: " + price.error);
  if (wasPrice.error) errors.push("was_price: " + wasPrice.error);
  if (start.error) errors.push("starts_on: " + start.error);
  if (end.error) errors.push("ends_on: " + end.error);
  if (start.value && end.value && end.value < start.value) errors.push("ends_on is before starts_on");

  const note = get("note").slice(0, 300);
  if (errors.length) return { errors };
  return {
    row: {
      store: supplier.name,
      item,
      price: price.value,
      was_price: wasPrice.value,
      starts_on: start.value,
      ends_on: end.value,
      note: note || null,
    },
  };
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log("Usage: node import-specials.js specials.csv");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(`I can't find the file "${file}". Check the name and that you are in the project folder.`);
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const headerIndex = rows.findIndex((r) => r.some((c) => String(c).trim() !== ""));
  if (headerIndex === -1) {
    console.log("The file is empty.");
    process.exit(1);
  }
  const idx = mapHeader(rows[headerIndex]);
  const missing = ["store", "item", "starts_on", "ends_on"].filter((f) => !(f in idx));
  if (missing.length) {
    console.log("The first row must be a header containing these columns: " + missing.join(", "));
    console.log("Expected header: store,item,price,was_price,starts_on,ends_on,note");
    process.exit(1);
  }

  const { sql } = require("./db");
  let inserted = 0;
  let skipped = 0;
  const problems = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.some((c) => String(c).trim() !== "")) continue; // blank line
    const lineNumber = i + 1;
    const result = normaliseRow(cells, idx);
    if (result.errors) {
      problems.push(`Line ${lineNumber}: ${result.errors.join("; ")}`);
      continue;
    }
    const r = result.row;
    try {
      const added = await sql`
        INSERT INTO store_specials (store, item, price, was_price, starts_on, ends_on, note)
        SELECT ${r.store}::text, ${r.item}::text, ${r.price}::numeric, ${r.was_price}::numeric,
               ${r.starts_on}::date, ${r.ends_on}::date, ${r.note}::text
        WHERE NOT EXISTS (
          SELECT 1 FROM store_specials
          WHERE store = ${r.store}::text AND item = ${r.item}::text
            AND starts_on = ${r.starts_on}::date AND ends_on = ${r.ends_on}::date
        )
        RETURNING id
      `;
      if (added.length > 0) inserted++;
      else skipped++;
    } catch (err) {
      if (err.code === "42P01") {
        console.log("The store_specials table doesn't exist yet. Start the app once with npm start (it creates the table), then run this again.");
        process.exit(1);
      }
      problems.push(`Line ${lineNumber}: database error: ${err.message}`);
    }
  }

  console.log(`\nDone. Added ${inserted} special(s), skipped ${skipped} that already existed, ${problems.length} row(s) with problems.`);
  if (problems.length) {
    console.log("\nRows that were NOT imported:");
    problems.forEach((p) => console.log("  " + p));
  }
  process.exit(problems.length ? 2 : 0);
}

module.exports = { parseCsv, mapHeader, normaliseRow, parsePrice, parseDate };

if (require.main === module) {
  main().catch((err) => {
    console.error("Import failed:", err.message);
    process.exit(1);
  });
}
