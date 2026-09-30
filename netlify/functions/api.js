// Runs the whole Express API (server.js) as one Netlify Function.
// netlify.toml sends /api/* and /unsubscribe here; the pages in public/ are
// served directly by Netlify's CDN.
const serverless = require("serverless-http");
const { app, ready } = require("../../server");

// Functions have no real socket, so give Express the client's IP from
// Netlify's header - the login/chat rate limits are keyed on it.
function clientIp(headers = {}) {
  return headers["x-nf-client-connection-ip"] ||
    String(headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown";
}

const handler = serverless(app, {
  request(req, event) {
    Object.defineProperty(req, "ip", { value: clientIp(event.headers), configurable: true });
  },
});

exports.handler = async (event, context) => {
  await ready();
  return handler(event, context);
};
