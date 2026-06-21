// HTTP response, cookie, and body helpers (ENG-002 extraction from server.js).
//
// errorBody is the unified ENG-005 error envelope: { error, code, requestId }. Fields are
// additive, so endpoints that adopt it stay backward compatible with clients that only
// read `error`.

const { IS_PROD } = require("./config");

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (IS_PROD || options.secure) parts.push("Secure");
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function adminCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (IS_PROD || options.secure) parts.push("Secure");
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  return parts.join("; ");
}

function clearCookie(name, strict = false) {
  return `${name}=; Path=/; HttpOnly; SameSite=${strict ? "Strict" : "Lax"}; Max-Age=0${IS_PROD ? "; Secure" : ""}`;
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json;charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function text(res, status, body, contentType = "text/plain;charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function errorBody(req, code, message, extra = {}) {
  return { error: message, code, requestId: req?.id, ...extra };
}

module.exports = { cookie, adminCookie, clearCookie, json, text, readJson, errorBody };
