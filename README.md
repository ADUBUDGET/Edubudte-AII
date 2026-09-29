# EduBudget AI

A real, working student budgeting + AI shopping assistant. Real accounts (bcrypt +
JWT session cookies), real product search (SerpAPI), real AI recommendations (Groq),
real routing/travel cost estimates (Google Distance Matrix), and a real Postgres
database (Neon) - all in South African Rand (ZAR).

The UI was designed in Google Stitch and wired to this real backend; the visual
design is untouched except for a small number of necessary functional additions
(clearly marked in the code with comments), such as:
- A Name field on the registration form
- A Monthly Budget setting (didn't exist in any of the 5 screens)
- A "Log a Purchase" form on the Profile page (nothing logs actual spend without it)

## 1. Install

```bash
npm install
```

## 2. Configure

`.env` is already filled in with the keys you provided earlier. If you need to
regenerate it from scratch:

```bash
cp .env.example .env
```

Then fill in:
- `DATABASE_URL` - Neon connection string
- `GROQ_API_KEY` - console.groq.com
- `GROQ_MODEL` - defaults to `openai/gpt-oss-120b`; check console.groq.com/docs/models if it's deprecated later
- `SERPAPI_KEY` - serpapi.com
- `ORS_API_KEY` - openrouteservice.org, free Standard token, no credit card required
- `JWT_SECRET` - already auto-generated for you; regenerate anytime with:
  `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

## 3. Run

```bash
npm start
```

Open **http://localhost:3000** - it lands on the Login/Register screen.

Tables are created automatically on first run. Existing tables and their data are
left untouched on later starts, so accounts, favourites, purchases and search
history all survive server restarts.

## 4. (Optional) Seed the Dashboard's "Trending Deals"

The Dashboard's "Trending Student Deals" section reads from a small cache table,
refreshed manually (not on every page load) to protect your SerpAPI free-tier quota:

```bash
npm run refresh-deals
```

Run this whenever you want fresh cached deals. It searches ~5 fixed student-relevant
categories and stores the real results.

## Pages

| Page | What it does |
|---|---|
| `/login.html` (also `/`) | Real registration and login. Passwords hashed with bcrypt, session stored in an httpOnly JWT cookie. Rate-limited (10 attempts/15min) against brute force. |
| `/dashboard.html` ("Bank") | Real remaining balance vs monthly budget, real top-2 spending categories, real cached trending deals, quick search bar. |
| `/search.html` ("Shop") | Real SerpAPI product search, Groq AI recommendation, price sort, save-to-favourites, and per-result Directions + real travel cost (walking/taxi/Uber estimates, weighed against your remaining budget by Groq). |
| `/analytics.html` ("Budget") | Real budget health score, real 7-day spending chart, real category breakdown, one real AI-generated insight from your actual spending. |
| `/favorites.html` ("Profile") | Real profile info, editable monthly budget, real favourites (full CRUD), real "Log a Purchase" budget entry form (full CRUD), sign out. |
| `/smart-basket.html` ("Basket") | Personalised, swipeable product suggestions with the cheapest current price, plus the student's grocery list. See **Smart Basket** below. |
| `/favourites.html` ("Favourites") | Saved products with a Purchased tick, filters and "Start a new shop". See **Favourites** below. |
| `/reset-password.html` | Where the emailed reset link lands: choose a new password. See **Forgot password** below. |

## Smart Basket

Suggests products each student is likely to need again, one swipeable card at a time.

- **Swipe right / Add** puts the item on the grocery list. If it's already there, nothing is
  duplicated; the saved price is refreshed and the student is told.
- **Swipe left / Skip** hides it for 3 days (`SKIP_COOLDOWN_DAYS`), then it can come back.
- **Swipe up / Hide** stops suggesting it until the student restores it from the Hidden panel.
- Keyboard: focus the card stack and use ← / ↑ / →. The buttons work for mouse and screen readers.

**Where suggestions come from** (`smart-basket.js`): the student's own purchases logged under
Food/Other (by description), their searches, and items they've ticked off past grocery lists.
Purchases count most, then list items, then searches; recent activity counts more (30-day
half-life). One purchase, one ticked-off item, or two searches are enough to qualify. Each
card says why it was suggested. Students with too little history get terms that at least 3
different students have searched for (never who searched), then common staples.

**Where prices come from**: South African retailers only. That means store specials running
today (`store_specials`) plus real SerpAPI Google Shopping results pinned to Durban
(`SHOPPING_LOCATION` in `smart-basket.js`), from known chains (Shoprite, Checkers, Pick n
Pay, Spar, Woolworths, Boxer, Makro, Game, Usave, OK Foods, Food Lover's Market, Clicks,
Dis-Chem) or any `.co.za` shop. Foreign shops and marketplaces are ignored.
- A listing counts only if its title contains every word of the item, and accessories like
  "milk frother" are ignored.
- If the cheapest listing costs under a third of the next one (a listing error, like R5
  bread next to R28.99), it is dropped. Team-entered specials are exempt.
- The cheapest remaining listing is shown and compared with the cheapest at a different
  SA retailer. If no SA retailer lists the item, the card says so. No price is ever guessed.

**Quota protection**: SerpAPI results are cached per search term for 24 hours in `price_cache`
(shared, no personal data). One Smart Basket load makes at most 3 live lookups; other cards are priced when they
reach the top of the stack (`/api/smart-basket/price`, rate limited to 10/min).

**Tables**: `grocery_list`, `smart_basket_state` (skipped/hidden per user) and `price_cache`,
all created automatically on startup.

## Favourites

`/favourites.html` (the "Favourites" tab) lists saved products. Each has a **Purchased**
checkbox: ticked items stay in the list, struck through, and can be unticked. Filters (All /
To buy / Purchased) are remembered, and **Start a new shop** unticks everything at once.
Saving the same product again (any spelling/case) doesn't add a duplicate - it updates the
saved store and price. API: `GET/POST /api/favourites`, `PUT /api/favourites/:id`
(`{ purchased: true|false }` or edits), `DELETE /api/favourites/:id`,
`POST /api/favourites/clear-purchased`. Logic in `favourites.js`.

(`/favorites.html` is still the Profile page; the name predates this tab.)

## Most frequently searched

A row of chips on Shop and Bank built from the student's own searches in the last 90 days
(`GET /api/search/frequent`, ranking in `frequent-searches.js`). "Eggs", "egg" and
" EGGS " count as one; blank, number-only, sentence-long and old searches are left out.
Tapping a chip runs that search. New students see a few starter searches instead.

## Caching

- **In the browser** (`shared.js`): API responses are kept in `localStorage` under the
  signed-in student's id, so pages open instantly and still show saved data offline (with
  a banner). The cache is wiped on sign-out or when a different student signs in, and
  never contains passwords or the session token (an httpOnly cookie). Saved data is
  refreshed after 1 minute; anything with prices after 10 minutes, and older prices are
  labelled with their age rather than shown as current. Every change made through
  `apiSend()` clears the cached data it affects (e.g. logging a purchase refreshes Bank,
  Budget and Smart Basket).
- **On the server**: Shop searches reuse the same SerpAPI results for 6 hours
  (`search-cache.js`, shared `price_cache` table, no personal data) and report when the
  prices were checked. Smart Basket prices are cached for 24 hours.

## Forgot password

"Forgot password?" on the sign-in card asks for an email and sends a single-use link to
`/reset-password.html` that expires after 30 minutes (`password-reset.js`). The reply is the
same whether or not an account exists, only a hash of the token is stored, asking again
cancels older links, and emails/tokens/passwords are never logged.

**Needs email set up** (the same settings the welcome/notification emails use). Add to `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-app-email@gmail.com
SMTP_PASS=your 16-character Gmail app password
MAIL_FROM=EduBudget AI <your-app-email@gmail.com>
APP_URL=http://localhost:3000
```

`APP_URL` must be the address students open the app on, because the reset link uses it.
Without SMTP settings the form says reset emails aren't available instead of pretending to
send one.

## Tests

```bash
npm test
```

Runs every test in `test/` with Node's built-in test runner - no database, API keys or
network needed (in-memory stores and fakes):

- `smart-basket.test.js` - recommendations, skip/hide/add, duplicates, cheapest SA price
- `favourites.test.js` - duplicates, purchased tick and undo, per-user access
- `frequent-searches.test.js` - frequent-search ranking and the Shop search cache
- `password-reset.test.js` - request, expiry, single use, validation, sign-in afterwards
- `cache.test.js` - the browser cache: per-user, clearing on changes/sign-out, limits
- `layout.test.js` - every page can scroll, content clears the mobile nav, dialogs scroll

There is no linter or build step in this project; `node --check` catches syntax errors.

## Security notes (what "production-grade" means here)

- Passwords: bcrypt, cost factor 12.
- Sessions: JWT in an httpOnly, sameSite=lax cookie - not readable by JS, resistant to XSS token theft.
- All data endpoints require a valid session and only ever read/write the authenticated
  user's own rows (fixed a real hole from the earlier anonymous-ID version, where any
  client could claim to be any user).
- Rate limiting on login/register and password-reset endpoints.
- Password resets: single-use, 30-minute links; only token hashes stored.

**Not included** (would need additional services/scope): email verification, signing out
other devices after a password reset (JWT sessions can't be revoked yet), 2FA, CSRF tokens beyond sameSite cookies,
HTTPS (add this yourself before deploying anywhere public - cookies are marked `secure`
automatically once `NODE_ENV=production` is set behind HTTPS).

## Known limitations (intentional, for a first real build)

- Uber/taxi costs are formula-based estimates (`server.js`, near `UBER_BASE_FARE` etc.),
  not live fares from either service - no public free API exists for that.
- Trending Deals are cached, not live per page load (quota protection).
- Distance filtering on the Search page's radius slider is visual only; actual radius
  filtering of results isn't implemented yet (SerpAPI's `location` param biases
  results regionally but doesn't hard-filter by exact km).
- Smart Basket prices come from Google Shopping listings around Durban, not from each
  branch's shelf, so "cheapest" doesn't account for travel distance or branch stock.
  Google's results also vary from search to search, so an item can occasionally show no
  SA retailer price until the cache refreshes the next day.
- Pack sizes are read from listing titles, so a card shows no size if the title has none.
