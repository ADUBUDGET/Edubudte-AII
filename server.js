require("dotenv").config();
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const Groq = require("groq-sdk");
const { sql, initSchema } = require("./db");
const authRoutes = require("./auth");

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
app.post("/api/auth/register", authLimiter, authRoutes.register);
app.post("/api/auth/login", authLimiter, authRoutes.login);
app.post("/api/auth/logout", authRoutes.logout);
app.get("/api/auth/me", authRoutes.requireAuth, authRoutes.me);
app.put("/api/auth/profile", authRoutes.requireAuth, authRoutes.updateProfile);

const requireAuth = authRoutes.requireAuth;

// ---------------------------------------------------------------
// SEARCH: real SerpAPI Google Shopping results + Groq recommendation.
// Prices are shown in ZAR (R) throughout.
// ---------------------------------------------------------------
// Straight-line distance (km) between two points - fast, free, no API call.
// Used for radius filtering. The "Directions" feature still gets real
// road-routing distance/time from OpenRouteService separately.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Resolves one store name to an approximate branch location near the anchor
// point. Used to filter search results by real radius. Deduped by caller so
// each unique store name is only resolved once per search, not once per item.
async function resolveStoreLocation(storeName, anchorLat, anchorLng) {
  try {
    const params = new URLSearchParams({
      engine: "google_maps",
      type: "search",
      q: storeName,
      ll: `@${anchorLat},${anchorLng},13z`,
      api_key: process.env.SERPAPI_KEY,
    });
    const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const nearest = (data.local_results || [])[0];
    const coords = nearest?.gps_coordinates;
    if (!coords) return null;
    return { lat: coords.latitude, lng: coords.longitude };
  } catch (e) {
    return null;
  }
}

// Max number of distinct stores we'll resolve-and-measure per search, to
// keep SerpAPI usage bounded even when results span many different stores.
const MAX_STORE_RESOLUTIONS_PER_SEARCH = 10;

app.post("/api/search", requireAuth, async (req, res) => {
  try {
    const { item, minPrice, maxPrice, location, radiusKm, originLat, originLng } = req.body;
    if (!item) return res.status(400).json({ error: "item is required" });
    if (!process.env.SERPAPI_KEY) {
      return res.status(500).json({ error: "SERPAPI_KEY not configured on server" });
    }

    const params = new URLSearchParams({
      engine: "google_shopping",
      q: item,
      api_key: process.env.SERPAPI_KEY,
      gl: "za",
      hl: "en",
    });
    if (location) params.set("location", location);

    const serpResp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
    if (!serpResp.ok) {
      return res.status(502).json({ error: "SerpAPI request failed", detail: await serpResp.text() });
    }
    const serpData = await serpResp.json();
    let rawResults = (serpData.shopping_results || []).slice(0, 20).map(r => ({
      title: r.title,
      price: r.price,
      extracted_price: r.extracted_price,
      source: r.source,
      link: r.link,
      thumbnail: r.thumbnail,
    }));

    // Respect Min/Max price - previously collected in the UI but never applied.
    if (minPrice) rawResults = rawResults.filter(r => r.extracted_price == null || r.extracted_price >= Number(minPrice));
    if (maxPrice) rawResults = rawResults.filter(r => r.extracted_price == null || r.extracted_price <= Number(maxPrice));

    // Determine an anchor point for radius filtering: prefer the typed
    // location text (geocoded for free via Nominatim), fall back to the
    // browser's live GPS if no location was typed.
    let anchor = null;
    if (location && location.trim()) {
      anchor = await geocodeLocation(location.trim());
    }
    if (!anchor && originLat && originLng) {
      anchor = { lat: originLat, lng: originLng };
    }

    let radiusNote = null;
    if (radiusKm && anchor) {
      const uniqueStores = [...new Set(rawResults.map(r => r.source).filter(Boolean))];
      const storesToResolve = uniqueStores.slice(0, MAX_STORE_RESOLUTIONS_PER_SEARCH);
      const storeCoords = {};
      await Promise.all(storesToResolve.map(async (storeName) => {
        storeCoords[storeName] = await resolveStoreLocation(storeName, anchor.lat, anchor.lng);
      }));

      rawResults = rawResults.map(r => {
        const coords = storeCoords[r.source];
        if (!coords) return { ...r, distanceKm: null };
        const d = haversineKm(Number(anchor.lat), Number(anchor.lng), coords.lat, coords.lng);
        return { ...r, distanceKm: +d.toFixed(1), storeLat: coords.lat, storeLng: coords.lng };
      });

      const before = rawResults.length;
      // Only exclude items where distance is known AND over radius - never
      // silently drop items we couldn't verify, per the "don't ignore parts"
      // requirement. Those are kept and marked as unverified instead.
      rawResults = rawResults.filter(r => r.distanceKm == null || r.distanceKm <= Number(radiusKm));
      const excluded = before - rawResults.length;
      const unresolvedCount = rawResults.filter(r => r.distanceKm == null).length;
      radiusNote = `Applied ${radiusKm}km radius from ${location || "your location"}: ${excluded} result(s) outside range removed.` +
        (unresolvedCount > 0 ? ` ${unresolvedCount} result(s) had unverifiable store locations and were kept regardless.` : "");
    } else if (radiusKm && !anchor) {
      radiusNote = "Distance radius could not be applied - no location available (type a location or allow browser location access).";
    }

    if (rawResults.length === 0) {
      await sql`
        INSERT INTO search_history (user_id, item_query, budget, location)
        VALUES (${req.userId}, ${item}, ${maxPrice || null}, ${location || null})
      `;
      return res.json({ results: [], recommendation: "No live results matched your filters. Try widening the price range or radius.", radiusNote });
    }

    const priceLine = [
      minPrice ? `minimum R${minPrice}` : null,
      maxPrice ? `maximum R${maxPrice}` : null,
    ].filter(Boolean).join(", ") || "no specific budget";
    const prompt = `
You are a budget-conscious shopping assistant for a South African student. All prices are in South African Rand (ZAR, R).
The user's price range: ${priceLine}.
Here are real, live product search results (JSON) for the query "${item}", each optionally including a real distanceKm from the user's search location:

${JSON.stringify(rawResults, null, 2)}

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

    res.json({ results: rawResults, recommendation, radiusNote });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// ---------------------------------------------------------------
// TRENDING / NEARBY DEALS: reads from the cached trending_deals table
// (populated by `npm run refresh-deals`, not on every page load).
// ---------------------------------------------------------------
app.get("/api/deals", requireAuth, async (req, res) => {
  try {
    const rows = await sql`
      SELECT * FROM trending_deals ORDER BY fetched_at DESC LIMIT 20
    `;
    res.json({ deals: rows, cacheNote: "These are cached real search results, refreshed periodically (not live per page load) to protect API quota." });
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
// FAVOURITES: full CRUD, scoped to the authenticated user
// ---------------------------------------------------------------
app.post("/api/favourites", requireAuth, async (req, res) => {
  try {
    const { itemName, storeName, price, link } = req.body;
    if (!itemName) return res.status(400).json({ error: "itemName is required" });
    const [row] = await sql`
      INSERT INTO favourites (user_id, item_name, store_name, price, link)
      VALUES (${req.userId}, ${itemName}, ${storeName || null}, ${price || null}, ${link || null})
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to create favourite", detail: err.message });
  }
});

app.get("/api/favourites", requireAuth, async (req, res) => {
  try {
    const rows = await sql`SELECT * FROM favourites WHERE user_id = ${req.userId} ORDER BY created_at DESC`;
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch favourites", detail: err.message });
  }
});

app.put("/api/favourites/:id", requireAuth, async (req, res) => {
  try {
    const { itemName, storeName, price } = req.body;
    const [row] = await sql`
      UPDATE favourites
      SET item_name = COALESCE(${itemName}, item_name),
          store_name = COALESCE(${storeName}, store_name),
          price = COALESCE(${price}, price)
      WHERE id = ${req.params.id} AND user_id = ${req.userId}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: "Favourite not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: "Failed to update favourite", detail: err.message });
  }
});

app.delete("/api/favourites/:id", requireAuth, async (req, res) => {
  try {
    await sql`DELETE FROM favourites WHERE id = ${req.params.id} AND user_id = ${req.userId}`;
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete favourite", detail: err.message });
  }
});

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
  const params = new URLSearchParams({ q: text, format: "json", limit: "1", countrycodes: "za" });
  const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { "User-Agent": "EduBudgetAI-StudentProject/1.0" }, // required by Nominatim's usage policy
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data[0]) return null;
  return { lat: data[0].lat, lng: data[0].lon };
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

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\nEduBudget AI running at http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error("Failed to initialise database schema:", err.message);
    process.exit(1);
  });
