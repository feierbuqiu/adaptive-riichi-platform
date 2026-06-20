const net = require("node:net");

function csvCell(value) {
  let text = String(value == null ? "" : value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

class FixedWindowRateLimiter {
  constructor({ maxKeys = 50000, now = () => Date.now() } = {}) {
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  prune(now = this.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    return this.buckets.size;
  }

  consume(rules, windowSeconds) {
    const now = this.now();
    const windowMs = Math.max(1, Number(windowSeconds) || 1) * 1000;
    const uniqueRules = new Map();
    for (const rule of rules || []) {
      const key = String(rule?.key || "");
      const limit = Math.floor(Number(rule?.limit));
      if (key && Number.isFinite(limit) && limit > 0) uniqueRules.set(key, { key, limit, layer: rule.layer || key });
    }
    if (!uniqueRules.size) return { allowed: true, retryAfterSeconds: 0 };

    let newKeys = 0;
    let denied = null;
    for (const rule of uniqueRules.values()) {
      const bucket = this.buckets.get(rule.key);
      if (!bucket || bucket.resetAt <= now) {
        newKeys += 1;
        continue;
      }
      if (bucket.count >= rule.limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        if (!denied || retryAfterSeconds > denied.retryAfterSeconds) denied = { ...rule, retryAfterSeconds };
      }
    }
    if (denied) return { allowed: false, retryAfterSeconds: denied.retryAfterSeconds, limitedBy: denied.layer };

    if (this.buckets.size + newKeys > this.maxKeys) this.prune(now);
    if (this.buckets.size + newKeys > this.maxKeys) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)), limitedBy: "capacity" };
    }

    for (const rule of uniqueRules.values()) {
      const bucket = this.buckets.get(rule.key);
      if (!bucket || bucket.resetAt <= now) this.buckets.set(rule.key, { count: 1, resetAt: now + windowMs });
      else bucket.count += 1;
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  get size() {
    return this.buckets.size;
  }
}

function normalizeSignal(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return text || null;
}

function clusterCandidatePairs(signals, forceMergePairKeys = [], maxPairs = 100000) {
  const buckets = new Map();
  const add = (kind, value, identityId) => {
    const normalized = normalizeSignal(value);
    if (!normalized) return;
    const key = `${kind}:${normalized}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(String(identityId));
  };

  for (const signal of signals || []) {
    const identityId = signal?.id;
    if (!identityId) continue;
    add("webgl", signal.webglKey && signal.webglRenderer ? `${signal.webglKey}|${signal.webglRenderer}` : null, identityId);
    add("device", signal.deviceHash, identityId);
    const uaCore = signal.ipPrefixHash && signal.uaBrowser && signal.uaOs
      ? `${signal.ipPrefixHash}|${signal.uaBrowser}|${signal.uaOs}`
      : null;
    add("ip-ua", uaCore, identityId);
    add("ip-accept-language", signal.ipPrefixHash && signal.acceptLanguage ? `${signal.ipPrefixHash}|${signal.acceptLanguage}` : null, identityId);
    add("ip-languages", signal.ipPrefixHash && signal.languages ? `${signal.ipPrefixHash}|${signal.languages}` : null, identityId);
  }

  const pairKeys = new Set();
  const addPair = (left, right) => {
    if (!left || !right || left === right) return true;
    const key = [String(left), String(right)].sort().join("|");
    pairKeys.add(key);
    return pairKeys.size <= maxPairs;
  };

  for (const members of buckets.values()) {
    const ids = [...new Set(members)].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        if (!addPair(ids[i], ids[j])) return { pairs: [], count: pairKeys.size, truncated: true };
      }
    }
  }
  for (const rawKey of forceMergePairKeys || []) {
    const [left, right, ...rest] = String(rawKey).split("|");
    if (rest.length || !addPair(left, right)) return { pairs: [], count: pairKeys.size, truncated: true };
  }

  return {
    pairs: [...pairKeys].sort().map((key) => key.split("|")),
    count: pairKeys.size,
    truncated: false,
  };
}

function hostNameFromHeader(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  const firstColon = raw.indexOf(":");
  const lastColon = raw.lastIndexOf(":");
  return firstColon >= 0 && firstColon === lastColon ? raw.slice(0, firstColon) : raw;
}

function isLoopbackAddress(value) {
  const address = String(value || "").toLowerCase().replace(/^::ffff:/, "");
  if (address === "::1") return true;
  if (net.isIP(address) !== 4) return false;
  return Number(address.split(".")[0]) === 127;
}

function isLoopbackHealthRequest(req) {
  const host = hostNameFromHeader(req?.headers?.host);
  return isLoopbackAddress(req?.socket?.remoteAddress)
    && (host === "localhost" || host === "127.0.0.1" || host === "::1");
}

module.exports = {
  FixedWindowRateLimiter,
  clusterCandidatePairs,
  csvCell,
  hostNameFromHeader,
  isLoopbackAddress,
  isLoopbackHealthRequest,
};
