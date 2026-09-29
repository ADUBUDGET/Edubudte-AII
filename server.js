require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { sql, initSchema } = require("./db");
const authRoutes = require("./auth");
const smartBasket = require("./smart-basket");
const smartBasketStore = require("./smart-basket-store");
const searchCache = require("./search-cache");
const shoppingResults = require("./shopping-results");
const { selectCurrentDeals, DEALS_MAX_AGE_DAYS } = require("./deals");
const suppliers = require("./suppliers");
const locationApi = require("./location");
const locationStore = require("./location-store");
const basket = require("./basket");
const basketStore = require("./basket-store");
const { rankFrequentSearches } = require("./frequent-searches");
const favourites = require("./favourites");
const favouritesStore = require("./favourites-store");
const passwordReset = require("./password-reset");
const passwordResetStore = require("./password-reset-store");
const mailer = require("./mailer");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

// Limits brute-force login/register attempts: 10 tries per IP per 15 min.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts, please try again later." },
});

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------
app.post("/api/auth/register", authLimiter, (req, res, next) => emailSvc.welcomeEmailHook(req, res, next), authRoutes.register);
app.post("/api/auth/login", authLimiter, authRoutes.login);
app.post("/api/auth/logout", authRoutes.logout);
app.get("/api/auth/me", authRoutes.requireAuth, authRoutes.me);
app.put("/api/auth/profile", authRoutes.requireAuth, authRoutes.updateProfile);

// Forgot Password (see password-reset.js). Tighter limits than login: a
// few link requests per IP, and a handful of reset attempts.
passwordReset.registerPasswordResetRoutes(
  app,
  passwordReset.createPasswordResetRoutes({ store: passwordResetStore, mailer }),
  {
    requestLimiter: rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: "Too many reset requests. Please wait 15 minutes and try again." } }),
    resetLimiter: rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: "Too many attempts. Please wait 15 minutes and try again." } }),
  }
);

const requireAuth = authRoutes.requireAuth;

// ---------------------------------------------------------------
// SEARCH: real SerpAPI Google Shopping results + Groq recommendation.
// Prices are shown in ZAR (R) throughout.
// ---------------------------------------------------------------
// Branches of one approved supplier around a point (SerpAPI Google Maps).
// location.js caches the result per area for 30 days and keeps only
// branches whose name belongs to that supplier.
async function fetchSupplierBranches(supplier, origin) {
  const params = new URLSearchParams({
    engine: "google_maps",
    type: "search",
    q: supplier.name,
    ll: `@${origin.lat},${origin.lng},12z`,
    api_key: process.env.SERPAPI_KEY,
  });
  const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
  if (!resp.ok) throw new Error(`Maps lookup failed (${resp.status})`);
  const data = await resp.json();
  return (data.local_results || []).map(r => ({
    name: r.title,
    type: r.type || null,
    address: r.address || null,
    lat: r.gps_coordinates?.latitude,
    lng: r.gps_coordinates?.longitude,
  }));
}

const locationService = locationApi.createLocationService({
  store: locationStore,
  geocode: text => geocodeLocation(text),
  fetchBranches: fetchSupplierBranches,
});

// Google Shopping results are pinned to one region (the student's exact
// area is handled by nearby-shop distances instead - SerpAPI rejects
// place names it doesn't know). Fetching and mapping live in
// shopping-results.js so every cache holds the same real fields.
const { SHOPPING_LOCATION, fetchShoppingResults } = shoppingResults;

app.post("/api/search", requireAuth, async (req, res) => {
  try {
    const { item, minPrice, maxPrice, location, radiusKm, originLat, originLng } = req.body;
    if (!item) return res.status(400).json({ error: "item is required" });
    if (!process.env.SERPAPI_KEY) {
      return res.status(500).json({ error: "SERPAPI_KEY not configured on server" });
    }

    // Same search (term + typed location) within a few hours reuses the
    // cached real results instead of another paid SerpAPI call.
    let fetched;
    try {
      fetched = await searchCache.getOrFetchResults({
        store: smartBasketStore,
        key: searchCache.searchCacheKey(item, SHOPPING_LOCATION),
        fetcher: () => fetchShoppingResults(item),
      });
    } catch (err) {
      if (err.status === 502) return res.status(502).json({ error: err.message, detail: err.detail });
      throw err;
    }
    const pricesCheckedAt = fetched.fetchedAt;
    // Only products from approved suppliers (suppliers.js), with duplicate
    // listings from the same shop collapsed to the cheapest.
    const cleaned = suppliers.cleanShoppingResults(fetched.results);
    let rawResults = cleaned.results;
    const hiddenListings = Object.values(cleaned.rejected).reduce((a, b) => a + b, 0);

    // Respect Min/Max price - previously collected in the UI but never applied.
    if (minPrice) rawResults = rawResults.filter(r => r.extracted_price == null || r.extracted_price >= Number(minPrice));
    if (maxPrice) rawResults = rawResults.filter(r => r.extracted_price == null || r.extracted_price <= Number(maxPrice));

    // Nearby shops: measure from GPS (sent only after the student allowed
    // it), a typed area, or their saved area; nearby shops come first,
    // farther ones are labelled, and "cheapest" means cheapest nearby.
    const { origin, radiusKm: radius } = await locationService.resolveOrigin(req.userId, {
      originLat, originLng, locationText: location, radiusKm,
    });
    rawResults = await locationService.annotateResults(rawResults, origin, radius);
    const nearbyResults = rawResults.filter(r => r.proximity === "nearby");
    const locationInfo = {
      label: origin ? origin.label : null,
      source: origin ? origin.source : null,
      radiusKm: radius,
      nearbyCount: nearbyResults.length,
      farCount: rawResults.filter(r => r.proximity === "far").length,
      unknownCount: rawResults.filter(r => r.proximity === "unknown").length,
    };
    const radiusNote = origin
      ? `Within ${radius} km of ${origin.label}: ${nearbyResults.length} of ${rawResults.length} result(s).`
      : "Set your shopping area to see the closest shops first.";

    if (rawResults.length === 0) {
      await sql`
        INSERT INTO search_history (user_id, item_query, budget, location)
        VALUES (${req.userId}, ${item}, ${maxPrice || null}, ${location || null})
      `;
      return res.json({
        results: [],
        recommendation: "None of our approved South African stores had this item in your price range. Try a simpler search term or a wider price range.",
        radiusNote, pricesCheckedAt, hiddenListings, location: locationInfo,
      });
    }

    const priceLine = [
      minPrice ? `minimum R${minPrice}` : null,
      maxPrice ? `maximum R${maxPrice}` : null,
    ].filter(Boolean).join(", ") || "no specific budget";
    // The AI only weighs up nearby shops, unless none are nearby.
    const forAi = (nearbyResults.length ? nearbyResults : rawResults).slice(0, 12).map(r => ({
      title: r.title, price: r.price, store: r.supplierName, distanceKm: r.distanceKm,
    }));
    const prompt = `
You are a budget-conscious shopping assistant for a South African student. All prices are in South African Rand (ZAR, R).
The user's price range: ${priceLine}.
Here are real, live product search results (JSON) for the query "${item}" from approved South African stores${origin ? `, with the distance in km from the student's area (${radius} km search radius)` : ""}:

${JSON.stringify(forAi, null, 2)}
${origin && !nearbyResults.length ? `\nNone of these stores has a branch within ${radius} km, so say that the options are farther away.\n` : ""}
Recommend the ONE best option considering both price and distance (closer is better, all else equal). If nothing fits, say so and suggest the closest affordable option.
Strict formatting rules: no markdown tables, no pipe characters, no bullet points, no headers, no bold/asterisks - plain prose only, maximum 45 words. Mention the store name and price.
`.trim();

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const recommendation = completion.choices[0]?.message?.content || "No recommendation generated.";

    await sql`
      INSERT INTO search_history (user_id, item_query, budget, location)
      VALUES (${req.userId}, ${item}, ${maxPrice || null}, ${location || null})
    `;

    res.json({ results: rawResults, recommendation, radiusNote, pricesCheckedAt, hiddenListings, location: locationInfo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// ---------------------------------------------------------------
// MOST FREQUENTLY SEARCHED: the student's own top searches (last 90 days),
// ranked and cleaned up in frequent-searches.js.
// ---------------------------------------------------------------
app.get("/api/search/frequent", requireAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT (array_agg(item_query ORDER BY created_at DESC))[1] AS query,
             COUNT(*)::int AS count, MAX(created_at) AS "lastAt"
      FROM search_history
      WHERE user_id = ${req.userId} AND created_at > NOW() - INTERVAL '90 days'
      GROUP BY lower(trim(item_query))
      ORDER BY count DESC, "lastAt" DESC
      LIMIT 200
    `;
    res.json({ items: rankFrequentSearches(rows) });
  } catch (err) {
    res.status(500).json({ error: "Failed to load frequent searches", detail: err.message });
  }
});

// ---------------------------------------------------------------
// TRENDING / NEARBY DEALS: reads from the cached trending_deals table
// (populated by `npm run refresh-deals`, not on every page load).
// ---------------------------------------------------------------
app.get("/api/deals", requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM trending_deals ORDER BY fetched_at DESC LIMIT 100`;
    // Only recent deals from approved suppliers (deals.js); older prices
    // aren't shown as current.
    const deals = selectCurrentDeals(rows);
    res.json({
      deals,
      checkedAt: deals.length ? deals[0].fetched_at : null,
      maxAgeDays: DEALS_MAX_AGE_DAYS,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load deals", detail: err.message });
  }
});

// ---------------------------------------------------------------
// DASHBOARD: real budget summary + most frequently searched items
// ---------------------------------------------------------------
app.get("/api/dashboard", requireAuth, async (req, res) => {
  try {
    const [user] = await sql`SELECT monthly_budget FROM users WHERE id = ${req.userId}`;
    const [{ total_spent }] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total_spent FROM budget_log WHERE user_id = ${req.userId}
    `;
    const topSearches = await sql`
      SELECT item_query, COUNT(*) AS search_count, MAX(created_at) AS last_searched
      FROM search_history WHERE user_id = ${req.userId}
      GROUP BY item_query ORDER BY search_count DESC, last_searched DESC LIMIT 5
    `;
    res.json({
      monthlyBudget: Number(user.monthly_budget),
      totalSpent: Number(total_spent),
      remaining: Number(user.monthly_budget) - Number(total_spent),
      topSearches,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load dashboard", detail: err.message });
  }
});

// ---------------------------------------------------------------
// ANALYTICS: real spending by day (last 7 days) + by category
// ---------------------------------------------------------------
app.get("/api/analytics", requireAuth, async (req, res) => {
  try {
    const byDay = await sql`
      SELECT to_char(created_at, 'Dy') AS day, SUM(amount) AS total
      FROM budget_log
      WHERE user_id = ${req.userId} AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY day, date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at)
    `;
    const byCategory = await sql`
      SELECT category, SUM(amount) AS total
      FROM budget_log WHERE user_id = ${req.userId}
      GROUP BY category ORDER BY total DESC
    `;
    const [{ total_spent }] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total_spent FROM budget_log WHERE user_id = ${req.userId}
    `;
    const [user] = await sql`SELECT monthly_budget FROM users WHERE id = ${req.userId}`;

    const totalSpent = Number(total_spent);
    const monthlyBudget = Number(user.monthly_budget) || 1;
    const budgetHealth = Math.max(0, Math.min(100, Math.round(100 - (totalSpent / monthlyBudget) * 100)));

    let insight = "Log a few purchases to get personalised AI insights on your spending.";
    if (byCategory.length > 0) {
      const prompt = `
A student has spent R${totalSpent} of a R${monthlyBudget} monthly budget.
Spending by category: ${byCategory.map(c => `${c.category}: R${c.total}`).join(", ")}.
Give one short, specific insight or suggestion (max 40 words) to help them manage their budget better this month.
`.trim();
      try {
        const completion = await groq.chat.completions.create({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.4,
        });
        insight = completion.choices[0]?.message?.content || insight;
      } catch (e) {
        // fall back to default insight text if Groq call fails - analytics page still works
      }
    }

    res.json({ byDay, byCategory, totalSpent, monthlyBudget, budgetHealth, insight });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load analytics", detail: err.message });
  }
});

// ---------------------------------------------------------------
// FAVOURITES: add (no duplicates), purchased tick, edit, delete - see favourites.js
// ---------------------------------------------------------------
favourites.registerFavouritesRoutes(app, requireAuth, favourites.createFavouritesRoutes({ store: favouritesStore }));

// ---------------------------------------------------------------
// BUDGET LOG: full CRUD, scoped to the authenticated user
// ---------------------------------------------------------------
app.post("/api/budget", requireAuth, async (req, res) => {
  try {
    const { amount, category, description } = req.body;
    if (amount === undefined) return res.status(400).json({ error: "amount is required" });
    const [row] = await sql`
      INSERT INTO budget_log (user_id, amount, category, description)
      VALUES (${req.userId}, ${amount}, ${category || "Other"}, ${description || null})
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to log spend", detail: err.message });
  }
});

app.get("/api/budget", requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM budget_log WHERE user_id = ${req.userId} ORDER BY created_at DESC`;
    const [{ total }] = await sql`SELECT COALESCE(SUM(amount), 0) AS total FROM budget_log WHERE user_id = ${req.userId}`;
    res.json({ entries: rows, totalSpent: Number(total) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch budget log", detail: err.message });
  }
});

app.put("/api/budget/:id", requireAuth, async (req, res) => {
  try {
    const { amount, category, description } = req.body;
    const [row] = await sql`
      UPDATE budget_log
      SET amount = COALESCE(${amount}, amount),
          category = COALESCE(${category}, category),
          description = COALESCE(${description}, description)
      WHERE id = ${req.params.id} AND user_id = ${req.userId}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: "Budget entry not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update entry", detail: err.message });
  }
});

app.delete("/api/budget/:id", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM budget_log WHERE id = ${req.params.id} AND user_id = ${req.userId}`;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete entry", detail: err.message });
  }
});

// ---------------------------------------------------------------
// NEAREST STORE + TRAVEL OPTIONS (unchanged logic, now behind auth)
// ---------------------------------------------------------------
// Free geocoding (no API key) via OpenStreetMap Nominatim - turns a typed
// place name like "Johannesburg" into real coordinates, so store searches
// can be anchored to where the user actually means, not just their live GPS.
async function geocodeLocation(text) {
  try {
    const params = new URLSearchParams({ q: text, format: "json", limit: "1", countrycodes: "za" });
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
      headers: { "User-Agent": "EduBudgetAI-StudentProject/1.0" }, // required by Nominatim's usage policy
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data[0]) return null;
    return { lat: data[0].lat, lng: data[0].lon };
  } catch (e) {
    return null; // geocoder unreachable: treated as "not found", never a crash
  }
}

// Reverse geocoding (free, no key) - turns exact coordinates into a
// human-readable address. Used when we already know precisely which
// branch we're talking about, so we don't need to re-search for it.
async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({ lat, lon: lng, format: "json" });
  const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
    headers: { "User-Agent": "EduBudgetAI-StudentProject/1.0" },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.display_name || null;
}

app.get("/api/nearest-store", requireAuth, async (req, res) => {
  try {
    const { name, lat, lng, locationText, knownLat, knownLng } = req.query;
    if (!name || !lat || !lng) return res.status(400).json({ error: "name, lat and lng are required" });

    // Best case: the search step already resolved this exact branch's
    // coordinates (for radius filtering). Reuse them directly instead of
    // re-searching, which could otherwise land on a different branch of
    // the same chain and produce an inconsistent distance figure.
    if (knownLat && knownLng) {
      const address = await reverseGeocode(knownLat, knownLng);
      return res.json({
        found: true,
        title: name,
        address: address || null,
        lat: Number(knownLat),
        lng: Number(knownLng),
        usedTypedLocation: false,
        exactMatch: true,
      });
    }

    // If the user typed a specific location in the search (e.g. "Johannesburg"),
    // anchor the store search there instead of their live GPS - otherwise a
    // search for a far-away city always incorrectly searches near the user.
    let anchorLat = lat, anchorLng = lng, usedTypedLocation = false;
    if (locationText && locationText.trim()) {
      const geo = await geocodeLocation(locationText.trim());
      if (geo) {
        anchorLat = geo.lat;
        anchorLng = geo.lng;
        usedTypedLocation = true;
      }
    }

    const params = new URLSearchParams({
      engine: "google_maps",
      type: "search",
      q: name,
      ll: `@${anchorLat},${anchorLng},13z`,
      api_key: process.env.SERPAPI_KEY,
    });
    const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!resp.ok) return res.status(502).json({ error: "SerpAPI maps lookup failed", detail: await resp.text() });
    const data = await resp.json();
    const nearest = (data.local_results || [])[0];
    if (!nearest) return res.json({ found: false, usedTypedLocation });

    res.json({
      found: true,
      title: nearest.title,
      address: nearest.address,
      lat: nearest.gps_coordinates?.latitude,
      lng: nearest.gps_coordinates?.longitude,
      usedTypedLocation,
      exactMatch: false,
    });
  } catch (err) {
    res.status(500).json({ error: "Nearest store lookup failed", detail: err.message });
  }
});

const UBER_BASE_FARE = 15, UBER_PER_KM = 8, UBER_PER_MIN = 1.5;
const TAXI_BASE_FARE = 12, TAXI_PER_KM = 5;
const WALK_SPEED_KMH = 5;

async function getDistanceMatrix(originLat, originLng, destLat, destLng, mode) {
  // mode: "driving" or "walking" -> ORS profile
  const profile = mode === "walking" ? "foot-walking" : "driving-car";
  const resp = await fetch(`https://api.openrouteservice.org/v2/matrix/${profile}`, {
    method: "POST",
    headers: {
      "Authorization": process.env.ORS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locations: [[Number(originLng), Number(originLat)], [Number(destLng), Number(destLat)]],
      sources: [0],
      destinations: [1],
      metrics: ["distance", "duration"],
    }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const distanceMeters = data.distances?.[0]?.[0];
  const durationSeconds = data.durations?.[0]?.[0];
  if (distanceMeters == null || durationSeconds == null) return null;
  return { distanceMeters, durationSeconds };
}

app.post("/api/travel-options", requireAuth, async (req, res) => {
  try {
    const { originLat, originLng, destLat, destLng, itemPrice, budget } = req.body;
    if (!originLat || !originLng || !destLat || !destLng) {
      return res.status(400).json({ error: "originLat, originLng, destLat, destLng are required" });
    }
    if (!process.env.ORS_API_KEY) {
      return res.status(500).json({ error: "ORS_API_KEY not configured on server" });
    }

    const [driving, walking] = await Promise.all([
      getDistanceMatrix(originLat, originLng, destLat, destLng, "driving"),
      getDistanceMatrix(originLat, originLng, destLat, destLng, "walking"),
    ]);
    if (!driving && !walking) return res.status(502).json({ error: "Could not calculate a route between those points" });

    const distanceKm = (driving || walking).distanceMeters / 1000;
    const drivingMin = driving ? driving.durationSeconds / 60 : null;
    const walkingMin = walking ? walking.durationSeconds / 60 : (distanceKm / WALK_SPEED_KMH) * 60;

    const uberEstimate = drivingMin != null ? +(UBER_BASE_FARE + UBER_PER_KM * distanceKm + UBER_PER_MIN * drivingMin).toFixed(2) : null;
    const taxiEstimate = +(TAXI_BASE_FARE + TAXI_PER_KM * distanceKm).toFixed(2);
    const remainingBudget = (budget != null && itemPrice != null) ? +(budget - itemPrice).toFixed(2) : null;

    const prompt = `
A student is deciding how to travel to a store that is ${distanceKm.toFixed(1)} km away. All amounts are in South African Rand (R).
- Walking: ${walkingMin.toFixed(0)} minutes, R0
- Driving/Taxi (metered): ~${drivingMin ? drivingMin.toFixed(0) + " min" : "unknown time"}, estimated R${taxiEstimate}
- Uber: ~${drivingMin ? drivingMin.toFixed(0) + " min" : "unknown time"}, estimated R${uberEstimate ?? "N/A"}
Item price: R${itemPrice ?? "unknown"}.
${remainingBudget != null ? `Remaining budget after buying the item: R${remainingBudget}.` : "Budget not specified."}

Recommend the single best travel option and explain briefly (max 60 words). Weigh the transport cost against the remaining budget.
`.trim();

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });
    const recommendation = completion.choices[0]?.message?.content || "No recommendation generated.";

    res.json({
      distanceKm: +distanceKm.toFixed(2),
      walking: { durationMin: +walkingMin.toFixed(0), cost: 0 },
      driving: drivingMin != null ? { durationMin: +drivingMin.toFixed(0) } : null,
      taxiEstimate,
      uberEstimate,
      remainingBudget,
      recommendation,
      note: "Uber/taxi costs are formula-based estimates, not live fares.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Travel options failed", detail: err.message });
  }
});

// ---------------------------------------------------------------
// EDUCHATBOT: budget-aware chat assistant, history saved per user
// ---------------------------------------------------------------
// Created separately from initSchema() so it is never dropped/recreated.
// user_id is TEXT (no foreign key) so it works whatever type users.id is.
async function ensureChatSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS chat_messages_user_idx ON chat_messages (user_id, id)`;
}

// Protects your free Groq quota: 15 chat messages per IP per minute.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  message: { error: "You're sending messages too fast. Please wait a moment." },
});

function buildChatSystemPrompt({ monthlyBudget, totalSpent, categories }) {
  const remaining = monthlyBudget - totalSpent;
  const categoryLine = categories.length
    ? categories.map(c => `${c.category}: R${Number(c.total).toFixed(2)}`).join(", ")
    : "no purchases logged yet";

  return `
You are EduChatBot, the friendly money assistant inside EduBudget AI, an app for South African students.

Personality and style:
- Warm, casual, encouraging, like a smart friend who is good with money. Keep replies short (under 120 words) unless the user asks for a plan or a list.
- You can chat about normal things (studying, stress, daily life). Answer naturally, and only bring the conversation back to money when it is useful. Never lecture.
- Use South African Rand (R) for every amount.
- Formatting: plain text only. No markdown: no asterisks, no # headings, no tables. For lists, start each line with a hyphen.

Money help:
- Use the user's real numbers below for budget advice. Never invent facts about their finances. If you need more information (income, rent, number of people to feed), ask ONE short question.
- Budget planning: suggest simple splits that fit student life (rent, food, transport, data, study costs, savings) and adjust to what the user tells you.
- Grocery lists: keep the total under the amount the user gives you (or a sensible share of their remaining budget). Show each item with an approximate price in Rand and a total. Prefer cheap staples and stores like Shoprite, Checkers, Pick n Pay, Spar or Boxer. Say clearly that prices are estimates.
- You are not a licensed financial advisor. Do not recommend loans, credit, crypto or gambling. If the user seems to be in serious financial trouble, encourage them to talk to their university's financial aid or student support office.

The user's current numbers:
- Monthly budget: R${monthlyBudget.toFixed(2)}
- Spent so far: R${totalSpent.toFixed(2)}
- Remaining: R${remaining.toFixed(2)}
- Spending by category: ${categoryLine}
`.trim();
}

app.post("/api/chat", requireAuth, chatLimiter, async (req, res) => {
  try {
    const message = typeof req.body.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "message is required" });
    if (message.length > 1000) {
      return res.status(400).json({ error: "Message is too long (max 1000 characters)." });
    }
    const uid = String(req.userId);

    // Same numbers the Dashboard uses, so the bot and the app always agree.
    const [user] = await sql`SELECT monthly_budget FROM users WHERE id = ${req.userId}`;
    const [{ total_spent }] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total_spent FROM budget_log WHERE user_id = ${req.userId}
    `;
    const categories = await sql`
      SELECT category, SUM(amount) AS total
      FROM budget_log WHERE user_id = ${req.userId}
      GROUP BY category ORDER BY total DESC LIMIT 5
    `;

    // Last 10 messages give the bot conversation memory.
    const recent = await sql`
      SELECT role, content FROM chat_messages
      WHERE user_id = ${uid} ORDER BY id DESC LIMIT 10
    `;
    const history = recent.reverse();

    const systemPrompt = buildChatSystemPrompt({
      monthlyBudget: Number(user?.monthly_budget) || 0,
      totalSpent: Number(total_spent),
      categories,
    });

    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ],
      temperature: 0.6,
      max_tokens: 1500,
    });
    const reply =
      completion.choices[0]?.message?.content?.trim() ||
      "Sorry, I couldn't come up with a reply. Try asking again?";

    // Save both messages only after Groq succeeded.
    await sql`INSERT INTO chat_messages (user_id, role, content) VALUES (${uid}, 'user', ${message})`;
    await sql`INSERT INTO chat_messages (user_id, role, content) VALUES (${uid}, 'assistant', ${reply})`;

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "EduChatBot had a problem. Please try again.", detail: err.message });
  }
});

app.get("/api/chat/history", requireAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT role, content FROM (
        SELECT id, role, content FROM chat_messages
        WHERE user_id = ${String(req.userId)} ORDER BY id DESC LIMIT 50
      ) t ORDER BY id ASC
    `;
    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to load chat history", detail: err.message });
  }
});

app.delete("/api/chat/history", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM chat_messages WHERE user_id = ${String(req.userId)}`;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to clear chat history", detail: err.message });
  }
});

// ---------------------------------------------------------------
// NOTIFICATIONS: in-app bell (budget alerts, store specials, new deals)
// ---------------------------------------------------------------
async function ensureNotificationSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      link TEXT,
      dedupe_key TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx ON notifications (user_id, dedupe_key)`;
  await sql`CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS store_specials (
      id SERIAL PRIMARY KEY,
      store TEXT NOT NULL,
      item TEXT NOT NULL,
      price NUMERIC(10,2),
      was_price NUMERIC(10,2),
      starts_on DATE NOT NULL,
      ends_on DATE NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

// The dedupe_key makes sure the same notification is only ever created once
// per user (e.g. one "special on now" per special, one 80% alert per month).
async function createNotification(userId, { type, title, body, link, dedupeKey }) {
  await sql`
    INSERT INTO notifications (user_id, type, title, body, link, dedupe_key)
    VALUES (${String(userId)}, ${type}, ${title}, ${body || null}, ${link || null}, ${dedupeKey})
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
  `;
}

async function generateBudgetNotifications(userId) {
  const [user] = await sql`SELECT monthly_budget FROM users WHERE id = ${userId}`;
  const [{ total_spent }] = await sql`
    SELECT COALESCE(SUM(amount), 0) AS total_spent FROM budget_log WHERE user_id = ${userId}
  `;
  const budget = Number(user?.monthly_budget) || 0;
  if (budget <= 0) return;
  const spent = Number(total_spent);
  const pct = (spent / budget) * 100;
  const month = new Date().toISOString().slice(0, 7);

  if (pct >= 100) {
    await createNotification(userId, {
      type: "budget",
      title: "You've passed your monthly budget",
      body: `You've spent R${spent.toFixed(2)} of your R${budget.toFixed(2)} budget. Try to hold off on non-essentials.`,
      link: "/analytics.html",
      dedupeKey: `budget100-${month}`,
    });
  } else if (pct >= 80) {
    await createNotification(userId, {
      type: "budget",
      title: "You've used 80% of your budget",
      body: `You've spent R${spent.toFixed(2)} of your R${budget.toFixed(2)} budget.`,
      link: "/analytics.html",
      dedupeKey: `budget80-${month}`,
    });
  }
}

async function generateSpecialNotifications(userId) {
  // "today" is calculated in South African time so dates line up for students.
  const specials = await sql`
    SELECT id, store, item, price, was_price,
           starts_on::text AS starts_on, ends_on::text AS ends_on,
           (starts_on <= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date) AS is_active
    FROM store_specials
    WHERE ends_on >= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
      AND starts_on <= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date + 3
  `;
  for (const s of specials) {
    const priceText = s.price != null ? ` for R${Number(s.price).toFixed(2)}` : "";
    const wasText = s.was_price != null ? ` (was R${Number(s.was_price).toFixed(2)})` : "";
    if (s.is_active) {
      await createNotification(userId, {
        type: "special",
        title: `Special on now at ${s.store}`,
        body: `${s.item}${priceText}${wasText}. Ends ${s.ends_on}.`,
        link: "/search.html",
        dedupeKey: `special-on-${s.id}`,
      });
    } else {
      await createNotification(userId, {
        type: "special",
        title: `Coming up at ${s.store}`,
        body: `${s.item}${priceText}${wasText}. Starts ${s.starts_on}.`,
        link: "/search.html",
        dedupeKey: `special-soon-${s.id}`,
      });
    }
  }
}

async function generateDealNotifications(userId) {
  const [row] = await sql`
    SELECT to_char(MAX(fetched_at), 'YYYY-MM-DD') AS day
    FROM trending_deals WHERE fetched_at > NOW() - INTERVAL '7 days'
  `;
  if (!row?.day) return;
  await createNotification(userId, {
    type: "deal",
    title: "Fresh student deals are in",
    body: "New trending deals were added to your Dashboard.",
    link: "/dashboard.html",
    dedupeKey: `deals-${row.day}`,
  });
}

app.get("/api/notifications", requireAuth, async (req, res) => {
  try {
    // Create any new notifications for this user first. One failing generator
    // must never stop the others or break the bell.
    for (const generate of [generateBudgetNotifications, generateSpecialNotifications, generateDealNotifications]) {
      try {
        await generate(req.userId);
      } catch (e) {
        console.error("Notification generator failed:", e.message);
      }
    }
    const uid = String(req.userId);
    const rows = await sql`
      SELECT id, type, title, body, link, is_read, created_at
      FROM notifications WHERE user_id = ${uid} ORDER BY id DESC LIMIT 30
    `;
    const [{ unread }] = await sql`
      SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = ${uid} AND is_read = FALSE
    `;
    res.json({ unread, notifications: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load notifications", detail: err.message });
  }
});

app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
  try {
    await sql`UPDATE notifications SET is_read = TRUE WHERE user_id = ${String(req.userId)} AND is_read = FALSE`;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to mark notifications as read", detail: err.message });
  }
});

app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
  try {
    await sql`
      UPDATE notifications SET is_read = TRUE
      WHERE id = ${req.params.id} AND user_id = ${String(req.userId)}
    `;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to mark notification as read", detail: err.message });
  }
});

// Upcoming and current specials, for a "Specials" section later.
app.get("/api/specials", requireAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT id, store, item, price, was_price, note,
             starts_on::text AS starts_on, ends_on::text AS ends_on
      FROM store_specials
      WHERE ends_on >= (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
      ORDER BY starts_on, ends_on LIMIT 50
    `;
    res.json({ specials: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to load specials", detail: err.message });
  }
});

// ---------------------------------------------------------------
// BASKET + BUDGET BANK: GET /api/basket (items, totals, budget) and
// POST /api/basket/checkout ("Confirm purchase") - see basket.js.
// ---------------------------------------------------------------
// Refresh prices re-checks stale basket prices against the same cached real
// Google Shopping data the Shop uses (6-hour cache shared by all students).
const basketPriceLookup = async term => {
  const { results, fetchedAt } = await searchCache.getOrFetchResults({
    store: smartBasketStore,
    key: searchCache.searchCacheKey(term, SHOPPING_LOCATION),
    fetcher: () => fetchShoppingResults(term),
  });
  return { results, fetchedAt };
};
basket.registerBasketRoutes(app, requireAuth, basket.createBasketRoutes({ store: basketStore, lookup: basketPriceLookup }), {
  checkoutLimiter: rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: "Too many purchase attempts, please wait a moment." } }),
  refreshLimiter: rateLimit({ windowMs: 60 * 1000, max: 3, message: { error: "Prices were just refreshed - please wait a minute." } }),
});

// ---------------------------------------------------------------
// SHOPPING AREA: GET/PUT/DELETE /api/location (see location.js). Saving a
// typed area geocodes it, so it's rate limited like other lookups.
// ---------------------------------------------------------------
locationApi.registerLocationRoutes(
  app,
  requireAuth,
  locationApi.createLocationRoutes({ store: locationStore, geocode: text => geocodeLocation(text) }),
  { limiter: rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: "Too many changes, please wait a moment." } }) }
);

// ---------------------------------------------------------------
// SMART BASKET + GROCERY LIST (see smart-basket.js)
// ---------------------------------------------------------------
// One-off price checks can call SerpAPI, so they're rate limited per IP.
const smartBasketPriceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Too many price checks, please wait a moment." },
});
smartBasket.registerSmartBasketRoutes(
  app,
  requireAuth,
  smartBasket.createSmartBasketRoutes({
    store: smartBasketStore,
    // "Cheapest" only among approved shops with a branch in the student's
    // radius, once they've set a shopping area. Branch lookups are cached
    // per area for 30 days, so only the first visit in an area pays for them.
    nearbyFor: async userId => {
      const { origin, radiusKm } = await locationService.resolveOrigin(userId);
      if (!origin) return { nearbySupplierIds: null, area: null };
      const ids = suppliers.SUPPLIERS.filter(s => s.active).map(s => s.id);
      const nearbySupplierIds = await locationService.nearbySupplierIds(origin, radiusKm, ids, { maxLive: ids.length });
      return { nearbySupplierIds, area: { label: origin.label, radiusKm } };
    },
  }),
  { priceLimiter: smartBasketPriceLimiter }
);

// ---------------------------------------------------------------
// EMAIL: welcome email, notification emails, unsubscribe link
// ---------------------------------------------------------------
const { createEmailService } = require("./emailService");
const emailSvc = createEmailService({
  app,
  sql,
  requireAuth,
  generators: [generateBudgetNotifications, generateSpecialNotifications, generateDealNotifications],
});

const PORT = process.env.PORT || 3000;

initSchema()
  .then(ensureChatSchema)
  .then(ensureNotificationSchema)
  .then(emailSvc.ensureEmailSchema)
  .then(() => {
    console.log("Chat, notification and email tables ready.");
    app.listen(PORT, () => {
      console.log(`\nEduBudget AI running at http://localhost:${PORT}\n`);
      emailSvc.startEmailJob();
    });
  })
  .catch(err => {
    console.error("Failed to initialise database schema:", err.message);
    process.exit(1);
  });
