// Static layout checks for every page, so scrolling bugs like a body with
// `overflow-hidden` (content below the screen unreachable) can't come back.
// Visual checks at phone sizes are still done in a browser; see README.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const pages = fs.readdirSync(PUBLIC).filter(f => f.endsWith(".html"));
const read = f => fs.readFileSync(path.join(PUBLIC, f), "utf8");
const bodyClass = html => (html.match(/<body[^>]*class="([^"]*)"/) || [])[1] || "";

// True when the body clips vertical overflow but still grows with its
// content, which makes everything below the first screen unreachable.
function bodyBlocksScroll(html) {
  const body = bodyClass(html).split(/\s+/);
  return body.includes("overflow-hidden") && !body.includes("h-screen");
}

test("the scroll check catches the old login/analytics bug", () => {
  assert.ok(bodyBlocksScroll('<body class="min-h-screen flex overflow-hidden">'));
  assert.ok(!bodyBlocksScroll('<body class="min-h-screen flex overflow-x-hidden">'));
  assert.ok(!bodyBlocksScroll('<body class="h-screen flex overflow-hidden">'));
});

for (const page of pages) {
  const html = read(page);
  const body = bodyClass(html).split(/\s+/);

  test(`${page}: has a mobile viewport tag`, () => {
    const meta = html.match(/<meta[^>]*name="viewport"[^>]*>/)?.[0] || "";
    assert.match(meta, /width=device-width/);
  });

  test(`${page}: page content can scroll vertically`, () => {
    if (!body.includes("overflow-hidden")) return;
    // Only allowed for fixed-height app layouts (like chat) that give an inner
    // region its own scroll: h-screen on the body plus a min-h-0 overflow-y-auto area.
    assert.ok(!bodyBlocksScroll(html), "body clips overflow but grows with content, so lower content is unreachable");
    assert.match(html, /class="[^"]*\bmin-h-0\b[^"]*\boverflow-y-auto\b|class="[^"]*\boverflow-y-auto\b[^"]*\bmin-h-0\b/,
      "fixed-height layout needs an inner min-h-0 overflow-y-auto region");
  });

  test(`${page}: fixed mobile bottom nav doesn't cover the last content`, () => {
    if (!/<nav[^>]*class="[^"]*md:hidden[^"]*fixed[^"]*bottom-0|<nav[^>]*class="[^"]*fixed[^"]*bottom-0[^"]*md:hidden/.test(html)) return;
    if (body.includes("h-screen")) return; // fixed-height layouts reserve space themselves
    const padded = /\bpb-(2[4-9]|3\d|40)\b/.test(bodyClass(html)) || /<main[^>]*class="[^"]*\bpb-(2[4-9]|3\d|40)\b/.test(html);
    assert.ok(padded, "body or main needs bottom padding (pb-24 or more) to clear the fixed nav");
  });

  test(`${page}: pop-up dialogs scroll inside when taller than the screen`, () => {
    const modals = html.match(/<div[^>]*class="[^"]*fixed inset-0[^"]*"[^>]*>\s*<div[^>]*class="([^"]*)"/g) || [];
    for (const m of modals) {
      const inner = m.match(/<div[^>]*class="([^"]*)"\s*[^>]*>\s*$/)?.[1] || m;
      assert.match(inner, /max-h-/, "dialog panel needs a max height");
      assert.match(inner, /overflow-y-auto/, "dialog panel needs overflow-y-auto");
    }
  });
}
