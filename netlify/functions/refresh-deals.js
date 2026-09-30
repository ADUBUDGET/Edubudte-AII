// Refreshes "Trending Student Deals" once a day (same as `npm run refresh-deals`).
const { schedule } = require("@netlify/functions");
const { refreshDeals } = require("../../scripts/refresh-deals");

exports.handler = schedule("0 4 * * *", async () => {
  try {
    const out = await refreshDeals();
    console.log(`Deals refreshed: ${out.saved} deal(s) from ${out.terms} term(s)`);
  } catch (err) {
    console.error("Deals refresh failed:", err.message);
  }
  return { statusCode: 200 };
});
