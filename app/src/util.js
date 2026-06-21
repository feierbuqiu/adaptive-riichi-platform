// Small pure helpers shared across domains (ENG-002 extraction from server.js).

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function nonempty(value) {
  const s = norm(value);
  return s ? s : null;
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function sqlPlaceholders(values) {
  return values.map(() => "?").join(", ");
}

function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

module.exports = { norm, nonempty, pairKey, sqlPlaceholders, parseJsonSafe };
