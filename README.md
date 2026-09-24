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

## Security notes (what "production-grade" means here)

- Passwords: bcrypt, cost factor 12.
- Sessions: JWT in an httpOnly, sameSite=lax cookie - not readable by JS, resistant to XSS token theft.
- All data endpoints require a valid session and only ever read/write the authenticated
  user's own rows (fixed a real hole from the earlier anonymous-ID version, where any
  client could claim to be any user).
- Rate limiting on login/register endpoints.

**Not included** (would need additional services/scope): email verification, password
reset via email (needs an email-sending API), 2FA, CSRF tokens beyond sameSite cookies,
HTTPS (add this yourself before deploying anywhere public - cookies are marked `secure`
automatically once `NODE_ENV=production` is set behind HTTPS).

## Known limitations (intentional, for a first real build)

- Uber/taxi costs are formula-based estimates (`server.js`, near `UBER_BASE_FARE` etc.),
  not live fares from either service - no public free API exists for that.
- Trending Deals are cached, not live per page load (quota protection).
- No password reset flow (needs an email provider).
- Distance filtering on the Search page's radius slider is visual only; actual radius
  filtering of results isn't implemented yet (SerpAPI's `location` param biases
  results regionally but doesn't hard-filter by exact km).
