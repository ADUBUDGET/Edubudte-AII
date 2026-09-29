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
async function requireAuthOrRedirect() {
  try {
    const resp = await fetch("/api/auth/me");
    if (!resp.ok) {
      window.location.href = "/login.html";
      return null;
    }
    const user = await resp.json();
    // Add the chat shortcut + notification bell. Wrapped so that a problem in
    // this optional UI can never break the page itself.
    try {
      initGlobalUI();
    } catch (e) {
      console.error("Global UI failed to start:", e);
    }
    return user;
  } catch (err) {
    window.location.href = "/login.html";
    return null;
  }
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
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

function initGlobalUI() {
  if (ebStarted) return;
  ebStarted = true;

  const style = document.createElement("style");
  style.textContent = EB_CSS;
  document.head.appendChild(style);

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
