// Shared across every authenticated page: auth guard + ZAR currency formatting
// + (EduChatBot feature) a floating chat shortcut and a notification bell that
// are added automatically to every page that calls requireAuthOrRedirect().

function formatZAR(amount) {
  const n = Number(amount) || 0;
  return "R " + n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Checks the session cookie via the server (cookie is httpOnly, so we can't
// read it directly - this is the correct way to check auth client-side).
// Redirects to /login.html if not authenticated. Returns the user object
// ({id, name, email, monthlyBudget}) if authenticated, or null.
// When offline, a student who was signed in on this browser keeps seeing
// their saved data instead of being sent to the login page.
async function requireAuthOrRedirect() {
  let user = null;
  try {
    const resp = await fetch("/api/auth/me");
    if (!resp.ok) {
      ebHandleSignedOut();
      return null;
    }
    user = await resp.json();
    ebCache.setOwner(user.id);
    ebCache.set("/api/auth/me", user);
  } catch (err) {
    ebCache.resumeLastOwner();
    const saved = ebCache.get("/api/auth/me");
    if (!saved) {
      window.location.href = "/login.html";
      return null;
    }
    user = saved.data;
  }
  // Add the chat shortcut + notification bell. Wrapped so that a problem in
  // this optional UI can never break the page itself.
  try {
    initGlobalUI();
  } catch (e) {
    console.error("Global UI failed to start:", e);
  }
  return user;
}

async function logout() {
  ebCache.clear(); // never leave one student's data behind for the next
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch (e) { /* still leave the signed-in pages */ }
  window.location.href = "/login.html";
}

function ebHandleSignedOut() {
  ebCache.clear();
  window.location.href = "/login.html";
}

// ---------------------------------------------------------------
// CACHE: per-student copies of API responses, so pages open instantly and
// still show something useful offline. Stored in localStorage under the
// signed-in user's id and wiped on logout or when someone else signs in.
// Only API data is stored - never passwords or the session token (which is
// an httpOnly cookie the page can't read anyway).
// ---------------------------------------------------------------
const EB_CACHE_PREFIX = "eb-cache:";
const EB_CACHE_OWNER_KEY = "eb-cache-owner";
const EB_CACHE_MAX_ENTRIES = 60;

// How long cached data counts as current before it is refreshed.
const EB_MAX_AGE = {
  default: 60 * 1000,
  prices: 10 * 60 * 1000, // anything showing a price: older copies are labelled, never shown as current
};

// A successful change to a URL on the left makes these cached URLs out of date.
const EB_INVALIDATION_RULES = [
  [/^\/api\/favourites/, ["/api/favourites"]],
  [/^\/api\/budget/, ["/api/budget", "/api/dashboard", "/api/analytics", "/api/smart-basket"]],
  [/^\/api\/grocery-list/, ["/api/grocery-list", "/api/smart-basket"]],
  [/^\/api\/smart-basket\//, ["/api/smart-basket"]],
  [/^\/api\/auth\/profile/, ["/api/auth/me", "/api/dashboard", "/api/analytics", "/api/smart-basket"]],
  [/^\/api\/search$/, ["/api/search/frequent", "/api/dashboard", "/api/smart-basket"]],
];

function createApiCache(storage, now = () => Date.now()) {
  let owner = null;
  const attempt = fn => { try { return fn(); } catch (e) { return null; } };
  const ownPrefix = () => EB_CACHE_PREFIX + owner + ":";
  const keys = () => attempt(() => {
    const list = [];
    for (let i = 0; i < storage.length; i++) list.push(storage.key(i));
    return list;
  }) || [];
  const removeWhere = test => keys().filter(k => k && test(k)).forEach(k => attempt(() => storage.removeItem(k)));

  const cache = {
    // Call after every successful login check. A different student than last
    // time means the old student's data is removed first.
    setOwner(userId) {
      const next = String(userId);
      const previous = attempt(() => storage.getItem(EB_CACHE_OWNER_KEY));
      if (previous !== next) cache.clear();
      owner = next;
      attempt(() => storage.setItem(EB_CACHE_OWNER_KEY, next));
    },
    // Offline: carry on as the student who last signed in on this browser.
    resumeLastOwner() {
      owner = attempt(() => storage.getItem(EB_CACHE_OWNER_KEY));
    },
    get(url) {
      if (!owner) return null;
      const raw = attempt(() => storage.getItem(ownPrefix() + url));
      if (!raw) return null;
      const entry = attempt(() => JSON.parse(raw));
      if (!entry || typeof entry.savedAt !== "number") return null;
      return { data: entry.data, savedAt: entry.savedAt, ageMs: now() - entry.savedAt };
    },
    set(url, data) {
      if (!owner) return;
      const value = JSON.stringify({ savedAt: now(), data });
      if (attempt(() => (storage.setItem(ownPrefix() + url, value), true)) === null) {
        // Storage full: drop the cache (keeping the same owner) and try once more.
        const current = owner;
        cache.clear();
        cache.setOwner(current);
        attempt(() => storage.setItem(ownPrefix() + url, value));
      }
      // Keep the cache small: drop the oldest entries beyond the limit.
      const mine = keys().filter(k => k && k.startsWith(ownPrefix()));
      if (mine.length > EB_CACHE_MAX_ENTRIES) {
        mine
          .map(k => ({ k, t: attempt(() => JSON.parse(storage.getItem(k)).savedAt) || 0 }))
          .sort((a, b) => a.t - b.t)
          .slice(0, mine.length - EB_CACHE_MAX_ENTRIES)
          .forEach(({ k }) => attempt(() => storage.removeItem(k)));
      }
    },
    // Removes cached URLs that start with any of the given prefixes.
    invalidate(prefixes) {
      if (!owner) return;
      removeWhere(k => prefixes.some(p => k.startsWith(ownPrefix() + p)));
    },
    invalidateFor(changedUrl) {
      const path = String(changedUrl).split("?")[0];
      const stale = EB_INVALIDATION_RULES.filter(([pattern]) => pattern.test(path)).flatMap(([, urls]) => urls);
      if (stale.length) cache.invalidate(stale);
    },
    clear() {
      removeWhere(k => k.startsWith(EB_CACHE_PREFIX) || k === EB_CACHE_OWNER_KEY);
      owner = null;
    },
  };
  return cache;
}

// Falls back to memory when localStorage is blocked (private mode, etc.).
function ebStorage() {
  try {
    const s = window.localStorage;
    s.setItem("eb-cache-test", "1");
    s.removeItem("eb-cache-test");
    return s;
  } catch (e) {
    const mem = new Map();
    return {
      get length() { return mem.size; },
      key: i => [...mem.keys()][i] ?? null,
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: k => mem.delete(k),
    };
  }
}

const ebCache = typeof window !== "undefined" ? createApiCache(ebStorage()) : null;

// Shows cached data straight away (if any), then fetches fresh data unless
// the cached copy is still current. `render(data, meta)` may run twice:
// meta = { fromCache, savedAt, stale }. Errors only reach onError when there
// is nothing cached to show.
async function loadWithCache(url, { maxAgeMs = EB_MAX_AGE.default, render, onError }) {
  const cached = ebCache.get(url);
  if (cached) render(cached.data, { fromCache: true, savedAt: cached.savedAt, stale: cached.ageMs > maxAgeMs });
  if (cached && cached.ageMs <= maxAgeMs) return cached.data;
  try {
    const resp = await fetch(url);
    if (resp.status === 401) { ebHandleSignedOut(); return null; }
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
    ebCache.set(url, data);
    render(data, { fromCache: false, savedAt: Date.now(), stale: false });
    return data;
  } catch (err) {
    const friendly = err instanceof TypeError ? new Error("Can't reach EduBudget right now. Check your connection.") : err;
    if (!cached && onError) onError(friendly);
    return cached ? cached.data : null;
  }
}

// Sends a change (POST/PUT/DELETE) and clears the cached data it affects.
// Throws an Error with a readable message on failure.
async function apiSend(method, url, body) {
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error("You're offline or the server can't be reached. Please try again.");
  }
  if (resp.status === 401) {
    ebHandleSignedOut();
    throw new Error("Please sign in again.");
  }
  const data = resp.status === 204 ? null : await resp.json().catch(() => null);
  if (!resp.ok) {
    const err = new Error((data && data.error) || "Something went wrong. Please try again.");
    err.status = resp.status;
    throw err;
  }
  ebCache.invalidateFor(url);
  return { status: resp.status, data };
}

function ebTimeSince(savedAt) {
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + " min ago";
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? hrs + " h ago" : Math.round(hrs / 24) + " d ago";
}

// ---------------------------------------------------------------
// TOAST: short confirmation ("Added to favourites"), announced to screen
// readers. Replaces alert() pop-ups.
// ---------------------------------------------------------------
let ebToastTimer = null;
function showToast(message, { error = false } = {}) {
  ebEnsureStyles();
  let t = document.getElementById("eb-toast");
  if (!t) {
    t = ebEl("div", "eb-toast");
    t.id = "eb-toast";
    t.setAttribute("role", "status");
    t.setAttribute("aria-live", "polite");
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.toggle("eb-toast-error", error);
  t.classList.add("eb-toast-show");
  clearTimeout(ebToastTimer);
  ebToastTimer = setTimeout(() => t.classList.remove("eb-toast-show"), 3500);
}

// ---------------------------------------------------------------
// MOST FREQUENTLY SEARCHED: a scrollable row of chips from the student's
// own search history (GET /api/search/frequent). Used on Shop and Bank.
// ---------------------------------------------------------------
const EB_STARTER_SEARCHES = ["Bread", "Milk", "Eggs", "Rice", "Toilet paper"];

function renderFrequentSearches(container, { onPick }) {
  const draw = (items, isStarter) => {
    container.textContent = "";
    const head = ebEl("div", "eb-freq-head");
    head.appendChild(ebEl("span", "eb-freq-title", isStarter ? "Try searching for" : "Most frequently searched"));
    if (isStarter) head.appendChild(ebEl("span", "eb-freq-note", "Your top searches will appear here"));
    container.appendChild(head);
    const row = ebEl("div", "eb-freq-row");
    row.setAttribute("role", "list");
    items.forEach(item => {
      const chip = ebEl("button", "eb-chip");
      chip.type = "button";
      chip.setAttribute("role", "listitem");
      chip.appendChild(ebEl("span", null, item.label));
      if (item.count > 1) chip.appendChild(ebEl("span", "eb-chip-count", "×" + item.count));
      chip.setAttribute("aria-label", item.count > 1 ? `Search for ${item.label}, searched ${item.count} times` : `Search for ${item.label}`);
      chip.addEventListener("click", () => onPick(item.query));
      row.appendChild(chip);
    });
    container.appendChild(row);
  };
  ebEnsureStyles();
  return loadWithCache("/api/search/frequent", {
    render: data => {
      const items = (data && data.items) || [];
      if (items.length) draw(items, false);
      else draw(EB_STARTER_SEARCHES.map(label => ({ label, query: label, count: 0 })), true);
    },
    onError: () => { container.textContent = ""; }, // optional extra: hide quietly
  });
}

// ---------------------------------------------------------------
// GLOBAL UI: EduChatBot shortcut + notification bell
// Uses its own small stylesheet (eb- prefix) with the app's exact colours,
// so it looks identical on every page regardless of that page's Tailwind setup.
// All notification text is inserted with textContent (never innerHTML).
// ---------------------------------------------------------------
const EB_CSS = `
.eb-fab{position:fixed;right:20px;bottom:calc(92px + env(safe-area-inset-bottom, 0px));z-index:60;width:56px;height:56px;border-radius:9999px;border:1px solid rgba(255,255,255,.15);background:#ffb77d;color:#4d2600;display:flex;align-items:center;justify-content:center;cursor:pointer;text-decoration:none;box-shadow:0 0 20px rgba(255,140,0,.35);transition:transform .15s ease}
.eb-fab:hover{transform:translateY(-2px)}
.eb-fab:active{transform:scale(.92)}
.eb-fab .material-symbols-outlined{font-size:28px;font-variation-settings:'FILL' 1}
@media (min-width:768px){.eb-fab{bottom:32px;right:32px}}
.eb-bell{position:relative;width:40px;height:40px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:#e2e2e2;cursor:pointer;transition:opacity .15s ease,transform .15s ease}
.eb-bell:hover{opacity:.8}
.eb-bell:active{transform:scale(.9)}
.eb-fixed-bell{position:fixed;top:12px;right:64px;z-index:60}
.eb-badge{position:absolute;top:2px;right:2px;min-width:18px;height:18px;padding:0 5px;border-radius:9999px;background:#ff8c00;color:#2f1500;font:700 11px/18px 'Plus Jakarta Sans',sans-serif;text-align:center;box-shadow:0 0 10px rgba(255,140,0,.5)}
.eb-panel{position:fixed;top:68px;right:16px;z-index:70;width:min(380px,calc(100vw - 32px));max-height:min(70vh,560px);display:flex;flex-direction:column;background:rgba(28,28,30,.96);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,.15);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:#e2e2e2;font-family:'Plus Jakarta Sans',sans-serif;overflow:hidden}
.eb-panel[hidden]{display:none}
.eb-panel-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px}
.eb-panel-title{font-size:16px;font-weight:700}
.eb-mark-all{background:none;border:0;color:#ffb77d;font:600 13px 'Plus Jakarta Sans',sans-serif;cursor:pointer;padding:4px 0}
.eb-mark-all:disabled{opacity:.4;cursor:default}
.eb-list{overflow-y:auto;flex:1;min-height:0}
.eb-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);font-size:13px;color:#ddc1ae;cursor:pointer}
.eb-foot[hidden]{display:none}
.eb-foot input{width:18px;height:18px;flex:none;accent-color:#ff8c00;cursor:pointer}
.eb-item{display:flex;gap:12px;padding:14px 16px;border-top:1px solid rgba(255,255,255,.08);cursor:pointer;text-align:left;width:100%;background:transparent;border-left:0;border-right:0;border-bottom:0;color:inherit;font-family:inherit}
.eb-item:hover{background:rgba(255,255,255,.05)}
.eb-item.eb-unread{background:rgba(255,140,0,.08)}
.eb-item-icon{flex:none;width:36px;height:36px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:rgba(255,140,0,.1);border:1px solid rgba(255,183,125,.2);color:#ffb77d}
.eb-item-icon .material-symbols-outlined{font-size:20px}
.eb-item-body{min-width:0;flex:1}
.eb-item-title{font-size:14px;font-weight:700;line-height:20px}
.eb-item-text{font-size:13px;line-height:18px;color:#ddc1ae;margin-top:2px}
.eb-item-time{font-size:11px;color:#a48c7a;margin-top:4px}
.eb-empty{padding:28px 16px;text-align:center;color:#ddc1ae;font-size:14px;border-top:1px solid rgba(255,255,255,.08)}
.eb-toast{position:fixed;left:50%;top:76px;transform:translate(-50%,-8px);z-index:90;max-width:min(90vw,480px);width:max-content;padding:12px 20px;border-radius:16px;background:#2a2a2a;border:1px solid rgba(255,255,255,.15);box-shadow:0 12px 32px rgba(0,0,0,.45);color:#e2e2e2;font:500 15px/22px 'Plus Jakarta Sans',sans-serif;text-align:center;opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease}
.eb-toast-show{opacity:1;transform:translate(-50%,0)}
.eb-toast-error{color:#ffb4ab;border-color:rgba(255,180,171,.4)}
.eb-offline{position:fixed;left:0;right:0;top:0;z-index:95;padding:6px 16px;background:#6e3900;color:#ffdcc3;font:600 13px/18px 'Plus Jakarta Sans',sans-serif;text-align:center}
.eb-offline[hidden]{display:none}
.eb-freq-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 4px 8px}
.eb-freq-title{font:700 12px/16px 'Plus Jakarta Sans',sans-serif;letter-spacing:.05em;text-transform:uppercase;color:#e2e2e2}
.eb-freq-note{font:400 12px/16px 'Plus Jakarta Sans',sans-serif;color:#ddc1ae}
.eb-freq-row{display:flex;gap:8px;overflow-x:auto;padding:2px 4px 8px;scroll-snap-type:x proximity;-webkit-overflow-scrolling:touch;scrollbar-width:thin}
.eb-chip{flex:none;scroll-snap-align:start;display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 16px;border-radius:9999px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#e2e2e2;font:600 14px/20px 'Plus Jakarta Sans',sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s ease,border-color .15s ease}
.eb-chip:hover{background:rgba(255,140,0,.12);border-color:rgba(255,183,125,.5)}
.eb-chip:focus-visible{outline:2px solid #ffb77d;outline-offset:2px}
.eb-chip-count{font-size:12px;color:#ffb77d}
@media (prefers-reduced-motion:reduce){.eb-toast{transition:none}}
`;

const EB_TYPE_ICONS = { budget: "account_balance_wallet", special: "local_offer", deal: "trending_up" };
const ebState = { items: [], unread: 0, badge: null, panel: null, list: null, markAll: null, foot: null, emailBox: null };

function ebEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function ebIcon(name) {
  return ebEl("span", "material-symbols-outlined", name);
}

function ebTimeAgo(value) {
  const then = new Date(value).getTime();
  if (!then) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return mins + " min ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + " h ago";
  return Math.round(hrs / 24) + " d ago";
}

function ebRender() {
  if (ebState.badge) {
    ebState.badge.hidden = ebState.unread <= 0;
    ebState.badge.textContent = ebState.unread > 9 ? "9+" : String(ebState.unread);
  }
  if (ebState.markAll) ebState.markAll.disabled = ebState.unread <= 0;
  const list = ebState.list;
  if (!list) return;
  list.textContent = "";
  if (ebState.items.length === 0) {
    list.appendChild(ebEl("div", "eb-empty", "You're all caught up. Deals and budget alerts will show up here."));
    return;
  }
  ebState.items.forEach((n) => {
    const item = ebEl("button", "eb-item" + (n.is_read ? "" : " eb-unread"));
    item.type = "button";
    const icon = ebEl("div", "eb-item-icon");
    icon.appendChild(ebIcon(EB_TYPE_ICONS[n.type] || "notifications"));
    const body = ebEl("div", "eb-item-body");
    body.appendChild(ebEl("div", "eb-item-title", n.title));
    if (n.body) body.appendChild(ebEl("div", "eb-item-text", n.body));
    body.appendChild(ebEl("div", "eb-item-time", ebTimeAgo(n.created_at)));
    item.appendChild(icon);
    item.appendChild(body);
    item.addEventListener("click", () => ebOpenNotification(n));
    list.appendChild(item);
  });
}

async function ebLoadNotifications() {
  try {
    const resp = await fetch("/api/notifications");
    if (!resp.ok) return;
    const data = await resp.json();
    ebState.items = data.notifications || [];
    ebState.unread = data.unread || 0;
    ebRender();
  } catch (e) {
    // The bell is optional - never break the page if this fails.
  }
}

async function ebOpenNotification(n) {
  if (!n.is_read) {
    n.is_read = true;
    ebState.unread = Math.max(0, ebState.unread - 1);
    ebRender();
    try {
      await fetch("/api/notifications/" + encodeURIComponent(n.id) + "/read", { method: "POST" });
    } catch (e) { /* ignore */ }
  }
  if (n.link) window.location.href = n.link;
}

async function ebMarkAllRead() {
  ebState.items.forEach((n) => { n.is_read = true; });
  ebState.unread = 0;
  ebRender();
  try {
    await fetch("/api/notifications/read-all", { method: "POST" });
  } catch (e) { /* ignore */ }
}

async function ebLoadEmailPref() {
  try {
    const resp = await fetch("/api/email-prefs");
    if (!resp.ok) return; // older server without email support: keep the switch hidden
    const data = await resp.json();
    ebState.emailBox.checked = data.enabled !== false;
    ebState.foot.hidden = false;
  } catch (e) { /* optional */ }
}

async function ebSaveEmailPref(enabled) {
  try {
    const resp = await fetch("/api/email-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!resp.ok) throw new Error("save failed");
  } catch (e) {
    ebState.emailBox.checked = !enabled; // put the switch back if saving failed
  }
}

let ebStarted = false;

let ebStylesAdded = false;
function ebEnsureStyles() {
  if (ebStylesAdded) return;
  ebStylesAdded = true;
  const style = document.createElement("style");
  style.textContent = EB_CSS;
  document.head.appendChild(style);
}

// Thin banner while the browser is offline; saved data keeps showing.
function ebInitOfflineBanner() {
  const banner = ebEl("div", "eb-offline", "You're offline. Showing your saved data - changes need a connection.");
  banner.setAttribute("role", "status");
  banner.hidden = navigator.onLine !== false;
  document.body.appendChild(banner);
  window.addEventListener("offline", () => { banner.hidden = false; });
  window.addEventListener("online", () => {
    banner.hidden = true;
    showToast("Back online");
  });
}

function initGlobalUI() {
  if (ebStarted) return;
  ebStarted = true;

  ebEnsureStyles();
  ebInitOfflineBanner();

  // --- Notification bell: goes in the top bar, next to the avatar ---
  const bell = ebEl("button", "eb-bell");
  bell.type = "button";
  bell.title = "Notifications";
  bell.setAttribute("aria-label", "Notifications");
  bell.appendChild(ebIcon("notifications"));
  const badge = ebEl("span", "eb-badge", "0");
  badge.hidden = true;
  bell.appendChild(badge);
  ebState.badge = badge;

  const slot = document.querySelector("header div.flex.items-center.gap-4");
  if (slot) {
    slot.insertBefore(bell, slot.firstChild);
  } else {
    bell.classList.add("eb-fixed-bell"); // fallback if a page has no standard top bar
    document.body.appendChild(bell);
  }

  // --- Notification panel ---
  const panel = ebEl("div", "eb-panel");
  panel.hidden = true;
  const head = ebEl("div", "eb-panel-head");
  head.appendChild(ebEl("span", "eb-panel-title", "Notifications"));
  const markAll = ebEl("button", "eb-mark-all", "Mark all read");
  markAll.type = "button";
  markAll.addEventListener("click", ebMarkAllRead);
  head.appendChild(markAll);
  const list = ebEl("div", "eb-list");
  panel.appendChild(head);
  panel.appendChild(list);

  // "Also email me these" switch (hidden until the server confirms email support)
  const foot = ebEl("label", "eb-foot");
  foot.hidden = true;
  foot.appendChild(ebEl("span", null, "Also email me these"));
  const emailBox = ebEl("input");
  emailBox.type = "checkbox";
  emailBox.checked = true;
  emailBox.addEventListener("change", () => ebSaveEmailPref(emailBox.checked));
  foot.appendChild(emailBox);
  panel.appendChild(foot);
  ebState.foot = foot;
  ebState.emailBox = emailBox;

  document.body.appendChild(panel);
  ebState.panel = panel;
  ebState.list = list;
  ebState.markAll = markAll;

  bell.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    if (!panel.hidden) ebLoadNotifications(); // refresh whenever it opens
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target)) panel.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") panel.hidden = true;
  });

  // --- EduChatBot shortcut: floating button on every page except the chat itself ---
  if (!/\/chat\.html$/.test(window.location.pathname)) {
    const fab = ebEl("a", "eb-fab");
    fab.href = "/chat.html";
    fab.title = "Chat with EduChatBot";
    fab.setAttribute("aria-label", "Chat with EduChatBot");
    fab.appendChild(ebIcon("smart_toy"));
    document.body.appendChild(fab);
  }

  ebRender();
  ebLoadNotifications();
  ebLoadEmailPref();

  // Live updates: re-check every 2 minutes while the tab is visible, and
  // straight away when the student comes back to the tab.
  setInterval(() => {
    if (!document.hidden) ebLoadNotifications();
  }, 120000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) ebLoadNotifications();
  });
}

// Lets the Node test runner load the cache logic (ignored in the browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { createApiCache, EB_INVALIDATION_RULES, EB_MAX_AGE };
}
