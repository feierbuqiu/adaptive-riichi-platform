// OPS-005 / ENG-005: request identifiers and structured, redacted access logging.
//
// Each request gets a stable id surfaced as the X-Request-Id response header and included
// in error envelopes. Access logs are single JSON lines on stdout (captured by the
// container's json-file log driver). They never include cookies, tokens, request bodies,
// or full client IP addresses — only a coarse route shape and a country code.

const crypto = require("node:crypto");

function newRequestId() {
  return `req_${crypto.randomBytes(9).toString("hex")}`;
}

// Collapse high-cardinality path segments (ids, hashes, tile names, numbers) so logs
// aggregate by route shape rather than user-specific values.
function routeTemplate(pathname) {
  const path = String(pathname || "/").split("?")[0];
  const shaped = path
    .replace(/\/practice-tiles\/[^/]+/i, "/practice-tiles/:tile")
    .replace(/\/qimg\/[a-f0-9]{32}\.[a-z]+/i, "/qimg/:token")
    .replace(/\/[a-z]+_[a-f0-9]{6,}/gi, "/:id")
    .replace(/\/[0-9a-f]{16,}/gi, "/:id")
    .replace(/\/\d+/g, "/:n");
  return shaped.slice(0, 120) || "/";
}

const SENSITIVE = /cookie|authorization|csrf|token|password|totp|secret|session/i;

function accessLog(entry, write = (line) => process.stdout.write(line)) {
  const safe = {};
  for (const [key, value] of Object.entries(entry || {})) {
    if (SENSITIVE.test(key)) continue;
    safe[key] = value;
  }
  try {
    write(`${JSON.stringify({ t: "access", ...safe })}\n`);
  } catch {
    /* logging must never throw into the request path */
  }
}

module.exports = { newRequestId, routeTemplate, accessLog };
