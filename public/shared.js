// Shared across every authenticated page: auth guard + ZAR currency formatting.

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
    return await resp.json();
  } catch (err) {
    window.location.href = "/login.html";
    return null;
  }
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
}
