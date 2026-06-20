const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");
const { createPracticeService } = require("./practice");
const {
  FixedWindowRateLimiter,
  clusterCandidatePairs,
  csvCell,
  isLoopbackHealthRequest,
} = require("./maintenance");

const APP_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = process.env.SOURCE_ROOT
  ? path.resolve(process.env.SOURCE_ROOT)
  : path.resolve(APP_ROOT, "..");
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const DATA_DIR = path.join(APP_ROOT, "data");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.sqlite");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PROD = process.env.NODE_ENV === "production";
const ADMIN_SESSION_COOKIE = IS_PROD ? "__Host-admin_session" : "admin_session";

function envList(name, fallback) {
  return String(process.env[name] || fallback || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

const CONFIG = {
  minItems: 10,
  targetItems: 18,
  maxItems: 25,
  stopSe: 0.45,
  questionSeconds: 70,
  totalBudgetSeconds: 1750,
  readyTimeoutSeconds: 30,
  minimumReportableCorrect: 3,
  scoreCenter: 50,
  scoreMultiplier: 20,
  maxAttempts: 2,
  identityTtlDays: 365,
  leaderboardCacheMs: 20000,
  defaultTopN: 50,
  sweepIntervalSeconds: Number(process.env.SWEEP_INTERVAL_SECONDS) || 45,
  clusterReviewThreshold: Number(process.env.CLUSTER_REVIEW_THRESHOLD) || 55,
  clusterAutoThreshold: Number(process.env.CLUSTER_AUTO_THRESHOLD) || 80,
  defaultNickname: process.env.DEFAULT_NICKNAME || "逍遥雀士",
  nicknameReviewMaxFailures: Number(process.env.NICKNAME_REVIEW_MAX_FAILURES) || 2,
  nicknameRateLimitPerMinute: Number(process.env.NICKNAME_RATE_LIMIT_PER_MINUTE) || 5,
  userMeRateLimitPerMinute: Number(process.env.USER_ME_RATE_LIMIT_PER_MINUTE) || 120,
  leaderboardRateLimitPerMinute: Number(process.env.LEADERBOARD_RATE_LIMIT_PER_MINUTE) || 120,
  attemptStartRateLimitPerMinute: Number(process.env.ATTEMPT_START_RATE_LIMIT_PER_MINUTE) || 20,
  attemptWriteRateLimitPerMinute: Number(process.env.ATTEMPT_WRITE_RATE_LIMIT_PER_MINUTE) || 180,
  assetRateLimitPerMinute: Number(process.env.ASSET_RATE_LIMIT_PER_MINUTE) || 240,
  identityCreateRateLimitPerHour: Number(process.env.IDENTITY_CREATE_RATE_LIMIT_PER_HOUR) || 120,
  globalRateLimitPerMinute: Number(process.env.GLOBAL_RATE_LIMIT_PER_MINUTE) || 5000,
  rateLimitScopeMultiplier: Number(process.env.RATE_LIMIT_SCOPE_MULTIPLIER) || 20,
  clusterRebuildMaxPairs: Number(process.env.CLUSTER_REBUILD_MAX_PAIRS) || 100000,
  clusterRebuildMaxMs: Number(process.env.CLUSTER_REBUILD_MAX_MS) || 5000,
  clusterRebuildMaxRetries: Number(process.env.CLUSTER_REBUILD_MAX_RETRIES) || 3,
  adminLoginAccountFailureLimit: Number(process.env.ADMIN_LOGIN_ACCOUNT_FAILURE_LIMIT) || 30,
  adminLoginAccountWindowMinutes: Number(process.env.ADMIN_LOGIN_ACCOUNT_WINDOW_MINUTES) || 15,
  examEnabled: String(process.env.EXAM_ENABLED || "false").toLowerCase() === "true",
  publicHostnames: envList("PUBLIC_HOSTNAMES", "localhost,127.0.0.1"),
  adminHostnames: envList("ADMIN_HOSTNAMES", "admin.localhost"),
  tencentTmsSecretId: process.env.TENCENTCLOUD_SECRET_ID || "",
  tencentTmsSecretKey: process.env.TENCENTCLOUD_SECRET_KEY || "",
  tencentTmsRegion: process.env.TENCENT_TMS_REGION || "ap-guangzhou",
  tencentTmsBizType: process.env.TENCENT_TMS_BIZ_TYPE || "nickname_input",
  tencentTmsEndpoint: process.env.TENCENT_TMS_ENDPOINT || "tms.tencentcloudapi.com",
  tencentTmsTimeoutMs: Number(process.env.TENCENT_TMS_TIMEOUT_MS) || 3000,
};

const SECRET = process.env.SESSION_SECRET || (IS_PROD ? "" : "dev-session-secret-change-me");

if (IS_PROD && !SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

// The production database lives on an explicit writable mount. Avoid touching
// /app/data when the container root filesystem is read-only.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA foreign_keys=ON");
let practiceService = null;

const MIME = {
  ".html": "text/html;charset=utf-8",
  ".js": "application/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function hmac(value, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const derived = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), derived);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

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

function deviceHash(req) {
  const ua = req.headers["user-agent"] || "";
  const lang = req.headers["accept-language"] || "";
  const ch = req.headers["sec-ch-ua"] || "";
  const ip = clientIp(req);
  const ipPrefix = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
  return sha(`${ua}|${lang}|${ch}|${ipPrefix}|${SECRET}`);
}

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

function ipPrefixOf(ip) {
  if (!ip) return "";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
}

function parseUserAgent(ua) {
  const s = String(ua || "");
  const low = s.toLowerCase();
  const mobile = /android|iphone|ipad|ipod|mobile|micromessenger/.test(low);
  let os = "Unknown";
  if (/windows nt/.test(low)) os = "Windows";
  else if (/iphone|ipad|ipod/.test(low)) os = "iOS";
  else if (/mac os x/.test(low)) os = "macOS";
  else if (/android/.test(low)) os = "Android";
  else if (/linux/.test(low)) os = "Linux";
  let browser = "Unknown";
  if (low.includes("micromessenger")) browser = "WeChat";
  else if (low.includes("mqqbrowser") || low.includes("qqbrowser")) browser = "QQBrowser";
  else if (low.includes("ucbrowser")) browser = "UC";
  else if (low.includes("quark")) browser = "Quark";
  else if (low.includes("edg/") || low.includes("edgios/")) browser = "Edge";
  else if (low.includes("crios/")) browser = "Chrome";
  else if (low.includes("fxios/") || low.includes("firefox/")) browser = "Firefox";
  else if (low.includes("chrome/")) browser = "Chrome";
  else if (low.includes("safari/")) browser = "Safari";
  const device = mobile ? (/ipad|tablet/.test(low) ? "tablet" : "phone") : "desktop";
  return { browser, os, device, mobile };
}

function captureServerFingerprint(req, identityId, attemptId) {
  const ip = clientIp(req);
  const ipPrefix = ipPrefixOf(ip);
  const ua = String(req.headers["user-agent"] || "");
  const parsed = parseUserAgent(ua);
  const lang = String(req.headers["accept-language"] || "");
  const chPlat = String(req.headers["sec-ch-ua-platform"] || "").replace(/"/g, "");
  const chMobile = String(req.headers["sec-ch-ua-mobile"] || "");
  const chModel = String(req.headers["sec-ch-ua-model"] || "").replace(/"/g, "");
  const fingerprintId = id("fp");
  db.prepare(`
    INSERT INTO fingerprints
    (id, identity_id, attempt_id, captured_at, source, ip_hash, ip_prefix_hash, ip_prefix,
     ua_raw, ua_browser, ua_os, ua_device, ua_mobile, accept_language, uach_platform, uach_mobile, uach_model, created_at)
    VALUES (?, ?, ?, ?, 'server', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fingerprintId, identityId, attemptId, nowIso(),
    ip ? hmac(ip) : null, ipPrefix ? hmac(ipPrefix) : null, ipPrefix || null,
    ua.slice(0, 400), parsed.browser, parsed.os, parsed.device, parsed.mobile ? 1 : 0,
    lang.slice(0, 200), chPlat.slice(0, 40) || null, chMobile.slice(0, 8) || null, chModel.slice(0, 80) || null,
    nowIso(),
  );
  db.prepare("UPDATE identities SET last_fingerprint_id = ? WHERE id = ?").run(fingerprintId, identityId);
  markClusterRebuildDirty();
  return fingerprintId;
}

function fpToApi(fp) {
  if (!fp) return null;
  return {
    capturedAt: fp.captured_at,
    source: fp.source,
    ipPrefix: fp.ip_prefix,
    uaBrowser: fp.ua_browser,
    uaOs: fp.ua_os,
    uaDevice: fp.ua_device,
    uaMobile: !!fp.ua_mobile,
    acceptLanguage: fp.accept_language,
    uachPlatform: fp.uach_platform,
    uachModel: fp.uach_model,
    timezone: fp.timezone,
    languages: fp.languages,
    screen: (fp.screen_w && fp.screen_h) ? `${fp.screen_w}x${fp.screen_h}` : null,
    dpr: fp.dpr,
    viewport: (fp.viewport_w && fp.viewport_h) ? `${fp.viewport_w}x${fp.viewport_h}` : null,
    platform: fp.platform,
    hardwareConcurrency: fp.hardware_concurrency,
    deviceMemory: fp.device_memory,
    touch: fp.touch == null ? null : !!fp.touch,
    colorDepth: fp.color_depth,
    colorScheme: fp.color_scheme,
    webglVendor: fp.webgl_vendor,
    webglRenderer: fp.webgl_renderer,
    uaRaw: fp.ua_raw,
  };
}

function isTencentMobileBrowser(req) {
  const ua = String(req.headers["user-agent"] || "");
  const lower = ua.toLowerCase();
  const mobile = /android|iphone|ipad|ipod|mobile/.test(lower);
  const wechat = lower.includes("micromessenger");
  const qqBrowser = lower.includes("mqqbrowser") || lower.includes("qqbrowser");
  const qqInApp = /(?:^|\s)qq\/[\d.]+/i.test(ua) || lower.includes(" qzone/");
  return mobile && (wechat || qqBrowser || qqInApp);
}

const RATE_LIMIT_MAX_KEYS = 50000; // SEC-003：硬容量上限，防止内存无界增长
const rateLimiter = new FixedWindowRateLimiter({ maxKeys: RATE_LIMIT_MAX_KEYS });

function pruneRateLimitBuckets() {
  return rateLimiter.prune();
}

function checkRateLimit(req, scope, limit, windowSeconds) {
  const ip = clientIp(req) || "noip";
  const identityId = (() => {
    try { return getIdentity(req)?.id || null; } catch { return null; }
  })();
  const globalResult = rateLimiter.consume([
    { key: "global:all", limit: CONFIG.globalRateLimitPerMinute, layer: "global" },
  ], 60);
  if (!globalResult.allowed) return globalResult;
  const rules = [
    { key: `scope:${scope}`, limit: Math.max(limit, Math.ceil(limit * CONFIG.rateLimitScopeMultiplier)), layer: "endpoint" },
    { key: `ip:${scope}:${ip}`, limit, layer: "ip" },
  ];
  if (identityId) rules.push({ key: `identity:${scope}:${identityId}`, limit, layer: "identity" });
  return rateLimiter.consume(rules, windowSeconds);
}

function adminLoginAccountRule(username) {
  return {
    key: `subject:admin_login:${hmac(String(username || "").trim().toLowerCase())}`,
    limit: CONFIG.adminLoginAccountFailureLimit,
    layer: "account",
  };
}

// PERF-001：聚类重建移出请求链——指纹/申诉只标记“需要重算”，由单实例后台任务合并执行
let clusterRebuildDirty = false;
let clusterRebuildRunning = false;
let clusterRebuildFailures = 0;
const clusterRebuildStatus = {
  state: "idle",
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: null,
  lastCandidatePairs: 0,
};
function markClusterRebuildDirty() {
  clusterRebuildDirty = true;
  if (clusterRebuildFailures >= CONFIG.clusterRebuildMaxRetries) clusterRebuildFailures = 0;
}
function processClusterRebuildJob() {
  if (clusterRebuildRunning || !clusterRebuildDirty) return;
  clusterRebuildRunning = true;
  clusterRebuildDirty = false;
  clusterRebuildStatus.state = "running";
  clusterRebuildStatus.lastStartedAt = nowIso();
  try {
    const result = rebuildIdentityClusters(true) || {};
    clusterRebuildFailures = 0;
    clusterRebuildStatus.state = "idle";
    clusterRebuildStatus.lastFinishedAt = nowIso();
    clusterRebuildStatus.lastError = null;
    clusterRebuildStatus.lastCandidatePairs = result.candidatePairs || 0;
  } catch (err) {
    clusterRebuildFailures += 1;
    clusterRebuildStatus.state = clusterRebuildFailures < CONFIG.clusterRebuildMaxRetries ? "retrying" : "failed";
    clusterRebuildStatus.lastError = String(err.message || err).slice(0, 500);
    clusterRebuildDirty = clusterRebuildFailures < CONFIG.clusterRebuildMaxRetries;
    console.error("[cluster] background rebuild failed", err.message);
  } finally {
    clusterRebuildRunning = false;
  }
}

function tableInfo(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function tableColumns(table) {
  return new Set(tableInfo(table).map((row) => row.name));
}

function ensureColumn(table, column, definition) {
  const cols = tableColumns(table);
  if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function rebuildAttemptsTableIfNeeded() {
  const info = tableInfo("attempts");
  if (!info.length) return;
  const sourceCols = new Set(info.map((row) => row.name));
  if (!sourceCols.has("access_code_id")) return;

  const now = nowIso();
  const target = [
    ["id", sourceCols.has("id") ? "id" : "lower(hex(randomblob(16)))"],
    ["identity_id", sourceCols.has("identity_id") ? "identity_id" : "''"],
    ["status", sourceCols.has("status") ? "status" : "'finished'"],
    ["theta", sourceCols.has("theta") ? "COALESCE(theta, 0)" : "0"],
    ["se", sourceCols.has("se") ? "COALESCE(se, 1)" : "1"],
    ["raw_ability_index", sourceCols.has("raw_ability_index") ? "raw_ability_index" : "NULL"],
    ["reported_ability_index", sourceCols.has("reported_ability_index") ? "reported_ability_index" : "NULL"],
    ["raw_ability_ci_low", sourceCols.has("raw_ability_ci_low") ? "raw_ability_ci_low" : "NULL"],
    ["raw_ability_ci_high", sourceCols.has("raw_ability_ci_high") ? "raw_ability_ci_high" : "NULL"],
    ["reported_ability_ci_low", sourceCols.has("reported_ability_ci_low") ? "reported_ability_ci_low" : "NULL"],
    ["reported_ability_ci_high", sourceCols.has("reported_ability_ci_high") ? "reported_ability_ci_high" : "NULL"],
    ["correct_count", sourceCols.has("correct_count") ? "COALESCE(correct_count, 0)" : "0"],
    ["answer_count", sourceCols.has("answer_count") ? "COALESCE(answer_count, 0)" : "0"],
    ["timeout_count", sourceCols.has("timeout_count") ? "COALESCE(timeout_count, 0)" : "0"],
    ["below_reportable_threshold", sourceCols.has("below_reportable_threshold") ? "COALESCE(below_reportable_threshold, 0)" : "0"],
    ["total_budget_seconds", sourceCols.has("total_budget_seconds") ? "COALESCE(total_budget_seconds, 1750)" : "1750"],
    ["active_elapsed_seconds", sourceCols.has("active_elapsed_seconds") ? "COALESCE(active_elapsed_seconds, 0)" : "0"],
    ["current_timed_item_id", sourceCols.has("current_timed_item_id") ? "current_timed_item_id" : "NULL"],
    ["formal_started_at", sourceCols.has("formal_started_at") ? "formal_started_at" : "NULL"],
    ["last_active_tick_at", sourceCols.has("last_active_tick_at") ? "last_active_tick_at" : "NULL"],
    ["last_resumed_at", sourceCols.has("last_resumed_at") ? "last_resumed_at" : "NULL"],
    ["abandoned_at", sourceCols.has("abandoned_at") ? "abandoned_at" : "NULL"],
    ["stop_reason", sourceCols.has("stop_reason") ? "stop_reason" : "NULL"],
    ["finalized_by", sourceCols.has("finalized_by") ? "finalized_by" : "NULL"],
    ["started_at", sourceCols.has("started_at") ? `COALESCE(started_at, '${now}')` : `'${now}'`],
    ["finished_at", sourceCols.has("finished_at") ? "finished_at" : "NULL"],
  ];

  const cols = target.map(([name]) => name).join(", ");
  const select = target.map(([, expr]) => expr).join(", ");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE attempts_rebuild (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        status TEXT NOT NULL,
        theta REAL NOT NULL DEFAULT 0,
        se REAL NOT NULL DEFAULT 1,
        raw_ability_index INTEGER,
        reported_ability_index INTEGER,
        raw_ability_ci_low INTEGER,
        raw_ability_ci_high INTEGER,
        reported_ability_ci_low INTEGER,
        reported_ability_ci_high INTEGER,
        correct_count INTEGER NOT NULL DEFAULT 0,
        answer_count INTEGER NOT NULL DEFAULT 0,
        timeout_count INTEGER NOT NULL DEFAULT 0,
        below_reportable_threshold INTEGER NOT NULL DEFAULT 0,
        total_budget_seconds INTEGER NOT NULL DEFAULT 1750,
        active_elapsed_seconds INTEGER NOT NULL DEFAULT 0,
        current_timed_item_id TEXT,
        formal_started_at TEXT,
        last_active_tick_at TEXT,
        last_resumed_at TEXT,
        abandoned_at TEXT,
        stop_reason TEXT,
        finalized_by TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      INSERT INTO attempts_rebuild (${cols})
      SELECT ${select} FROM attempts;
      DROP TABLE attempts;
      ALTER TABLE attempts_rebuild RENAME TO attempts;
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function migrateLegacySchema() {
  ensureColumn("attempts", "identity_id", "TEXT");

  const legacy = db.prepare(`
    SELECT id, status, started_at, finished_at, identity_id
    FROM attempts
    WHERE identity_id IS NULL OR identity_id = ''
    ORDER BY started_at
  `).all();

  const insertIdentity = db.prepare(`
    INSERT INTO identities
    (id, secret_hash, csrf_token, max_attempts, used_attempts, first_attempt_id,
     sample_status, device_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'confirmed', NULL, ?, ?, ?)
  `);
  const updateAttempt = db.prepare("UPDATE attempts SET identity_id = ? WHERE id = ?");
  const ttlMs = 1000 * 60 * 60 * 24 * CONFIG.identityTtlDays;
  if (legacy.length) {
    db.exec("BEGIN");
    try {
      for (const attempt of legacy) {
        const identityId = id("legacy");
        const created = attempt.started_at || nowIso();
        const expires = new Date(nowMs() + ttlMs).toISOString();
        const firstAttemptId = attempt.status === "finished" ? attempt.id : null;
        insertIdentity.run(
          identityId,
          sha(`legacy:${attempt.id}:${identityId}`),
          crypto.randomBytes(24).toString("hex"),
          CONFIG.maxAttempts,
          1,
          firstAttemptId,
          created,
          expires,
          attempt.finished_at || attempt.started_at || nowIso(),
        );
        updateAttempt.run(identityId, attempt.id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  rebuildAttemptsTableIfNeeded();
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      source TEXT,
      image_path TEXT NOT NULL,
      answer_index INTEGER NOT NULL,
      a REAL NOT NULL,
      b REAL NOT NULL,
      p REAL,
      rit REAL,
      stage TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      excluded INTEGER NOT NULL DEFAULT 0,
      n INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS question_options (
      question_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY (question_id, option_index)
    );
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      used_attempts INTEGER NOT NULL DEFAULT 0,
      active_attempt_id TEXT,
      first_attempt_id TEXT,
      sample_status TEXT NOT NULL DEFAULT 'not_started',
      sample_selected_index INTEGER,
      nickname TEXT,
      nickname_review_failures INTEGER NOT NULL DEFAULT 0,
      nickname_review_locked INTEGER NOT NULL DEFAULT 0,
      nickname_review_status TEXT,
      nickname_reviewed_at TEXT,
      nickname_review_request_id TEXT,
      nickname_review_label TEXT,
      nickname_review_suggestion TEXT,
      device_hash TEXT,
      link_cluster_id TEXT,
      last_fingerprint_id TEXT,
      flagged INTEGER NOT NULL DEFAULT 0,
      excluded_from_board INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      status TEXT NOT NULL,
      theta REAL NOT NULL DEFAULT 0,
      se REAL NOT NULL DEFAULT 1,
      raw_ability_index INTEGER,
      reported_ability_index INTEGER,
      raw_ability_ci_low INTEGER,
      raw_ability_ci_high INTEGER,
      reported_ability_ci_low INTEGER,
      reported_ability_ci_high INTEGER,
      correct_count INTEGER NOT NULL DEFAULT 0,
      answer_count INTEGER NOT NULL DEFAULT 0,
      timeout_count INTEGER NOT NULL DEFAULT 0,
      below_reportable_threshold INTEGER NOT NULL DEFAULT 0,
      total_budget_seconds INTEGER NOT NULL DEFAULT 1750,
      active_elapsed_seconds INTEGER NOT NULL DEFAULT 0,
      current_timed_item_id TEXT,
      formal_started_at TEXT,
      last_active_tick_at TEXT,
      last_resumed_at TEXT,
      abandoned_at TEXT,
      stop_reason TEXT,
      finalized_by TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS attempt_items (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      selected_index INTEGER,
      response_type TEXT NOT NULL,
      correct INTEGER NOT NULL,
      theta_before REAL NOT NULL,
      theta_after REAL,
      se_before REAL NOT NULL,
      se_after REAL,
      assigned_at TEXT NOT NULL,
      ready_at TEXT,
      shown_at TEXT,
      expires_at TEXT,
      answered_at TEXT,
      response_time_ms INTEGER,
      load_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      role TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL,
      session_hash TEXT NOT NULL,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_exposure_daily (
      day TEXT NOT NULL,
      question_id TEXT NOT NULL,
      shown_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, question_id)
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fingerprints (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      attempt_id TEXT,
      captured_at TEXT NOT NULL,
      source TEXT NOT NULL,
      ip_hash TEXT,
      ip_prefix_hash TEXT,
      ip_prefix TEXT,
      ua_raw TEXT,
      ua_browser TEXT,
      ua_os TEXT,
      ua_device TEXT,
      ua_mobile INTEGER,
      accept_language TEXT,
      uach_platform TEXT,
      uach_mobile TEXT,
      uach_model TEXT,
      timezone TEXT,
      languages TEXT,
      screen_w INTEGER,
      screen_h INTEGER,
      dpr REAL,
      viewport_w INTEGER,
      viewport_h INTEGER,
      platform TEXT,
      hardware_concurrency INTEGER,
      device_memory REAL,
      touch INTEGER,
      color_depth INTEGER,
      color_scheme TEXT,
      webgl_vendor TEXT,
      webgl_renderer TEXT,
      webgl_hash TEXT,
      signal_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_clusters (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      auto_enforced INTEGER NOT NULL DEFAULT 0,
      member_count INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_cluster_members (
      cluster_id TEXT NOT NULL,
      identity_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      evidence_json TEXT,
      auto_enforced INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (cluster_id, identity_id)
    );
    CREATE TABLE IF NOT EXISTS identity_cluster_edges (
      id TEXT PRIMARY KEY,
      cluster_id TEXT,
      identity_a TEXT NOT NULL,
      identity_b TEXT NOT NULL,
      score REAL NOT NULL,
      confidence_level TEXT NOT NULL,
      auto_enforced INTEGER NOT NULL DEFAULT 0,
      evidence_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cluster_overrides (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      identity_a TEXT NOT NULL,
      identity_b TEXT NOT NULL,
      admin_user_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appeals (
      id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL,
      cluster_id TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
  `);
  migrateLegacySchema();
  ensureColumn("identities", "link_cluster_id", "TEXT");
  ensureColumn("identities", "last_fingerprint_id", "TEXT");
  ensureColumn("identities", "nickname_review_failures", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("identities", "nickname_review_locked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("identities", "nickname_review_status", "TEXT");
  ensureColumn("identities", "nickname_reviewed_at", "TEXT");
  ensureColumn("identities", "nickname_review_request_id", "TEXT");
  ensureColumn("identities", "nickname_review_label", "TEXT");
  ensureColumn("identities", "nickname_review_suggestion", "TEXT");
  ensureColumn("attempts", "finalized_by", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attempts_identity ON attempts(identity_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attempt_items_attempt ON attempt_items(attempt_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_identities_device ON identities(device_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_identities_cluster ON identities(link_cluster_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fingerprints_identity ON fingerprints(identity_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fingerprints_attempt ON fingerprints(attempt_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fingerprints_ipprefix ON fingerprints(ip_prefix_hash)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cluster_members_identity ON identity_cluster_members(identity_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON identity_cluster_members(cluster_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_cluster_edges_cluster ON identity_cluster_edges(cluster_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status)");
}

function importQuestionBank() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM questions").get().n;
  if (count > 0) return;
  const file = path.join(SOURCE_ROOT, "sample-test", "question-bank.js");
  if (!fs.existsSync(file)) {
    if (CONFIG.examEnabled) throw new Error(`exam question bank missing: ${file}`);
    console.warn("[exam] no private question bank mounted; exam mode remains unavailable");
    return;
  }
  const code = fs.readFileSync(file, "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const bank = sandbox.window.QUESTION_BANK;
  const insertQ = db.prepare(`
    INSERT INTO questions (id, source, image_path, answer_index, a, b, p, rit, stage, difficulty, active, excluded, n, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertO = db.prepare("INSERT INTO question_options (question_id, option_index, label) VALUES (?, ?, ?)");
  const ts = nowIso();
  db.exec("BEGIN");
  try {
    for (const q of bank.questions) {
      insertQ.run(
        q.id,
        q.source || "",
        q.image,
        q.answer,
        q.a || 0.8,
        q.b || 0,
        q.p ?? null,
        q.rit ?? null,
        q.stage || "B",
        q.difficulty || "medium",
        q.excluded ? 0 : 1,
        q.excluded ? 1 : 0,
        q.n ?? null,
        ts,
        ts,
      );
      q.options.forEach((opt, idx) => insertO.run(q.id, idx, opt.label));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function seedAdmin() {
  const adminCount = db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n;
  if (adminCount > 0) return;
  const username = process.env.ADMIN_USERNAME || (IS_PROD ? null : "admin");
  const password = process.env.ADMIN_PASSWORD || (IS_PROD ? null : "DevOnly-ChangeMe!");
  if (!username || !password) throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required before first production start");
  db.prepare("INSERT INTO admin_users (id, username, password_hash, totp_secret, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id("adm"), username, hashPassword(password), process.env.ADMIN_TOTP_SECRET || null, "superadmin", nowIso());
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input || "").replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = "";
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function verifyTotp(secret, token) {
  if (!secret) return !IS_PROD;
  if (!/^\d{6}$/.test(String(token || ""))) return false;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30000);
  for (const offset of [-1, 0, 1]) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(step + offset));
    const h = crypto.createHmac("sha1", key).update(buf).digest();
    const pos = h[h.length - 1] & 0xf;
    const code = ((h.readUInt32BE(pos) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(String(token)))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Identity (codeless soft identity)
// ---------------------------------------------------------------------------

function getIdentity(req) {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies["identity"];
  if (!value || !value.includes(".")) return null;
  const [identityId, raw] = value.split(".");
  const row = db.prepare("SELECT * FROM identities WHERE id = ?").get(identityId);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < nowMs()) return null;
  if (!safeEqualHex(sha(raw), row.secret_hash)) return null;
  return row;
}

function mintIdentity(req, res) {
  const raw = crypto.randomBytes(32).toString("hex");
  const identityId = id("idn");
  const csrf = crypto.randomBytes(24).toString("hex");
  const ttlSeconds = 60 * 60 * 24 * CONFIG.identityTtlDays;
  const expires = new Date(nowMs() + ttlSeconds * 1000).toISOString();
  db.prepare(`
    INSERT INTO identities (id, secret_hash, csrf_token, max_attempts, device_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(identityId, sha(raw), csrf, CONFIG.maxAttempts, deviceHash(req), nowIso(), expires, nowIso());
  res.__identityCookie = cookie("identity", `${identityId}.${raw}`, { maxAge: ttlSeconds });
  return db.prepare("SELECT * FROM identities WHERE id = ?").get(identityId);
}

function requireIdentity(req, res) {
  const idn = getIdentity(req);
  if (!idn) {
    json(res, 401, { error: "会话已失效，请刷新页面后重试。" });
    return null;
  }
  if (req.method !== "GET" && req.headers["x-csrf-token"] !== idn.csrf_token) {
    json(res, 403, { error: "请求校验失败，请刷新页面重试。" });
    return null;
  }
  db.prepare("UPDATE identities SET last_seen_at = ? WHERE id = ?").run(nowIso(), idn.id);
  return idn;
}

function requireAdmin(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[ADMIN_SESSION_COOKIE];
  if (!value || !value.includes(".")) {
    json(res, 401, { error: "请先登录管理员账号。" });
    return null;
  }
  const [sid, raw] = value.split(".");
  const session = db.prepare("SELECT * FROM admin_sessions WHERE id = ?").get(sid);
  if (!session || new Date(session.expires_at).getTime() < nowMs() || !safeEqualHex(sha(raw), session.session_hash)) {
    json(res, 401, { error: "请先登录管理员账号。" });
    return null;
  }
  if (req.method !== "GET" && req.headers["x-csrf-token"] !== session.csrf_token) {
    json(res, 403, { error: "请求校验失败，请刷新页面重试。" });
    return null;
  }
  const admin = db.prepare("SELECT * FROM admin_users WHERE id = ? AND disabled = 0").get(session.admin_user_id);
  if (!admin) {
    json(res, 401, { error: "管理员账号不可用。" });
    return null;
  }
  db.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), session.id);
  admin.__session = session;
  return admin;
}

function getAdminSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies[ADMIN_SESSION_COOKIE];
  if (!value || !value.includes(".")) return null;
  const [sid, raw] = value.split(".");
  const session = db.prepare("SELECT * FROM admin_sessions WHERE id = ?").get(sid);
  if (!session || new Date(session.expires_at).getTime() < nowMs() || !safeEqualHex(sha(raw), session.session_hash)) return null;
  return session;
}

// ---------------------------------------------------------------------------
// Sample
// ---------------------------------------------------------------------------

function sampleOptions() {
  const file = path.join(SOURCE_ROOT, "ChoicesForTheSample.txt");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return lines.filter((x) => x.toLowerCase() !== "choices:");
}

function publicSample(identity) {
  const status = identity.sample_status || "not_started";
  const selectedIndex = identity.sample_selected_index;
  const options = sampleOptions();
  const correctIndex = options.indexOf("3s");
  const answered = selectedIndex != null;
  return {
    csrf: identity.csrf_token,
    sampleStatus: status,
    selected: answered ? options[selectedIndex] : null,
    correctAnswer: answered ? "3s" : null,
    isCorrect: answered ? selectedIndex === correctIndex : null,
    question: {
      imageUrl: "/assets/sample-question?v=j1",
      options,
      ready: true,
      submitRequiredBeforeSolution: true,
    },
    solution: {
      available: answered,
      imageUrl: answered ? "/assets/sample-solution?v=j1" : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Psychometric engine (preserved)
// ---------------------------------------------------------------------------

function logistic(x) {
  return 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, x))));
}

function scoreFromTheta(theta) {
  return Math.max(0, Math.min(100, Math.round(CONFIG.scoreCenter + CONFIG.scoreMultiplier * theta)));
}

const TIERS = ["初心", "雀士", "雀杰", "雀豪", "雀圣", "魂天"];

function tierFromScore(score, belowThreshold) {
  if (belowThreshold) return "见习";
  if (score < 30) return "初心";
  if (score < 45) return "雀士";
  if (score < 60) return "雀杰";
  if (score < 75) return "雀豪";
  if (score < 90) return "雀圣";
  return "魂天";
}

function messageFromScore(score, belowThreshold) {
  if (belowThreshold) return "本次有效作答不足，暂时无法给出稳定评估，建议再认真挑战一次。";
  if (score < 30) return "当前处于基础区间，多练牌效会很快进步。";
  if (score < 45) return "已经入门，继续巩固基础牌型判断。";
  if (score < 60) return "接近题库平均水平，状态稳定。";
  if (score < 75) return "高于题库平均水平，牌效判断不错。";
  if (score < 90) return "表现优秀，已进入高水平区间。";
  return "接近本题库的上限区间，牌效判断非常出色。";
}

function estimateAbility(attemptId, startTheta = 0) {
  const rows = db.prepare(`
    SELECT ai.correct, q.a, q.b
    FROM attempt_items ai
    JOIN questions q ON q.id = ai.question_id
    WHERE ai.attempt_id = ? AND ai.answered_at IS NOT NULL
    ORDER BY ai.sequence
  `).all(attemptId);
  if (!rows.length) return { theta: 0, se: 1 };
  let theta = startTheta;
  for (let iter = 0; iter < 30; iter += 1) {
    let grad = -theta;
    let info = 1;
    for (const row of rows) {
      const a = Math.max(0.25, row.a || 0.8);
      const p = logistic(a * (theta - row.b));
      grad += a * ((row.correct ? 1 : 0) - p);
      info += a * a * p * (1 - p);
    }
    const delta = Math.max(-0.8, Math.min(0.8, grad / info));
    theta += delta;
    if (Math.abs(delta) < 0.0001) break;
  }
  let info = 1;
  for (const row of rows) {
    const a = Math.max(0.25, row.a || 0.8);
    const p = logistic(a * (theta - row.b));
    info += a * a * p * (1 - p);
  }
  return { theta, se: 1 / Math.sqrt(info) };
}

function currentStage(answerCount, se) {
  if (answerCount < 5) return "A";
  if (
    answerCount >= CONFIG.targetItems - 5 ||
    answerCount >= CONFIG.maxItems - 5 ||
    (answerCount >= CONFIG.minItems && se <= CONFIG.stopSe + 0.12)
  ) return "C";
  return "B";
}

function difficultyNeed(attemptId, answerCount) {
  const rows = db.prepare(`
    SELECT DISTINCT q.difficulty
    FROM attempt_items ai JOIN questions q ON q.id = ai.question_id
    WHERE ai.attempt_id = ?
  `).all(attemptId);
  const used = new Set(rows.map((x) => x.difficulty));
  if (!used.has("medium")) return "medium";
  if (answerCount >= 6 && !used.has("hard")) return "hard";
  if (answerCount >= 6 && !used.has("easy")) return "easy";
  return null;
}

function questionImagePath(imagePath) {
  const base = path.basename(imagePath);
  return path.join(SOURCE_ROOT, "questionbank", base);
}

function questionAssetToken(questionId) {
  return crypto.createHmac("sha256", SECRET).update(`question-asset:${questionId}`).digest("hex").slice(0, 32);
}

function questionByAssetToken(token) {
  if (!/^[a-f0-9]{32}$/i.test(String(token || ""))) return null;
  const rows = db.prepare("SELECT id, image_path FROM questions WHERE active = 1").all();
  const target = String(token).toLowerCase();
  for (const row of rows) {
    if (safeEqualHex(questionAssetToken(row.id), target)) return row;
  }
  return null;
}

function selectNextQuestion(attempt) {
  const answered = db.prepare("SELECT question_id FROM attempt_items WHERE attempt_id = ?").all(attempt.id).map((x) => x.question_id);
  const answeredSet = new Set(answered);
  const all = db.prepare("SELECT * FROM questions WHERE active = 1 AND excluded = 0").all()
    .filter((q) => !answeredSet.has(q.id));
  if (!all.length) return null;
  let pool = all;
  const need = difficultyNeed(attempt.id, attempt.answer_count);
  if (need) {
    const narrowed = pool.filter((q) => q.difficulty === need);
    if (narrowed.length >= 2) pool = narrowed;
  }
  const stage = currentStage(attempt.answer_count, attempt.se);
  if (stage === "A") {
    const p = pool.filter((q) => q.stage === "A");
    if (p.length >= 2) pool = p;
  } else if (stage === "C") {
    const p = pool.filter((q) => q.stage === "C" || q.stage === "A");
    if (p.length >= 2) pool = p;
  } else {
    const p = pool.filter((q) => q.stage === "B" || q.stage === "A" || q.stage === "C");
    if (p.length >= 2) pool = p;
  }
  const today = new Date().toISOString().slice(0, 10);
  const exposure = db.prepare("SELECT shown_count FROM item_exposure_daily WHERE day = ? AND question_id = ?");
  const scored = pool.map((q) => {
    const a = Math.max(0.25, q.a || 0.8);
    const p = logistic(a * (attempt.theta - q.b));
    const info = a * a * p * (1 - p);
    const stageBonus = q.stage === stage ? 0.08 : 0;
    const exp = exposure.get(today, q.id)?.shown_count || 0;
    const expPenalty = Math.min(0.4, exp * 0.015);
    const pilotPenalty = q.stage === "pilot" ? 0.15 : 0;
    return { q, score: info + stageBonus - expPenalty - pilotPenalty };
  }).sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.min(5, scored.length));
  return top[crypto.randomInt(0, top.length)].q;
}

function publicQuestion(attemptItemId, readyOverride = null) {
  const row = db.prepare(`
    SELECT ai.*, q.image_path
    FROM attempt_items ai JOIN questions q ON q.id = ai.question_id
    WHERE ai.id = ?
  `).get(attemptItemId);
  if (!row) return null;
  const options = db.prepare("SELECT label FROM question_options WHERE question_id = ? ORDER BY option_index").all(row.question_id).map((x) => x.label);
  return {
    sequence: row.sequence,
    attemptItemId: row.id,
    imageUrl: `/qimg/${questionAssetToken(row.question_id)}${path.extname(row.image_path).toLowerCase() || ".jpg"}`,
    options,
    ready: readyOverride != null ? readyOverride : row.load_status === "ready",
    expiresAt: row.expires_at,
    timeLimitSeconds: CONFIG.questionSeconds,
  };
}

function assignNextItem(attempt) {
  const q = selectNextQuestion(attempt);
  if (!q) {
    finishAttempt(attempt.id, "available_pool_exhausted");
    return null;
  }
  const itemId = id("aitem");
  db.prepare(`
    INSERT INTO attempt_items
    (id, attempt_id, question_id, sequence, selected_index, response_type, correct, theta_before, se_before, assigned_at, load_status)
    VALUES (?, ?, ?, ?, NULL, 'pending', 0, ?, ?, ?, 'pending')
  `).run(itemId, attempt.id, q.id, attempt.answer_count + 1, attempt.theta, attempt.se, nowIso());
  return publicQuestion(itemId, false);
}

function recordExposure(questionId) {
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO item_exposure_daily (day, question_id, shown_count)
    VALUES (?, ?, 1)
    ON CONFLICT(day, question_id) DO UPDATE SET shown_count = shown_count + 1
  `).run(day, questionId);
}

function updateAttemptStats(attemptId) {
  const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  const ability = estimateAbility(attemptId, attempt.theta);
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS answer_count,
      SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct_count,
      SUM(CASE WHEN response_type = 'timeout' THEN 1 ELSE 0 END) AS timeout_count
    FROM attempt_items WHERE attempt_id = ? AND answered_at IS NOT NULL
  `).get(attemptId);
  const correctCount = counts.correct_count || 0;
  const raw = scoreFromTheta(ability.theta);
  const rawLow = scoreFromTheta(ability.theta - 1.96 * ability.se);
  const rawHigh = scoreFromTheta(ability.theta + 1.96 * ability.se);
  const below = correctCount < CONFIG.minimumReportableCorrect;
  const reported = below ? 0 : raw;
  db.prepare(`
    UPDATE attempts
    SET theta = ?, se = ?, raw_ability_index = ?, reported_ability_index = ?,
        raw_ability_ci_low = ?, raw_ability_ci_high = ?,
        reported_ability_ci_low = ?, reported_ability_ci_high = ?,
        correct_count = ?, answer_count = ?, timeout_count = ?, below_reportable_threshold = ?
    WHERE id = ?
  `).run(
    ability.theta,
    ability.se,
    raw,
    reported,
    rawLow,
    rawHigh,
    below ? 0 : rawLow,
    below ? 0 : rawHigh,
    correctCount,
    counts.answer_count || 0,
    counts.timeout_count || 0,
    below ? 1 : 0,
    attemptId,
  );
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
}

function shouldStop(attempt) {
  if (attempt.answer_count >= CONFIG.maxItems) return "max_items";
  if (attempt.answer_count >= CONFIG.minItems && attempt.se <= CONFIG.stopSe) return "standard_error_threshold";
  if (attempt.active_elapsed_seconds >= CONFIG.totalBudgetSeconds) return "total_time_budget";
  return null;
}

function finishAttempt(attemptId, reason, finalizedBy = "client") {
  let attempt = updateAttemptStats(attemptId);
  if (attempt.status === "finished" || attempt.status === "technical_aborted") return attempt;
  db.prepare("UPDATE attempts SET status = 'finished', stop_reason = ?, finalized_by = ?, finished_at = ?, current_timed_item_id = NULL WHERE id = ?")
    .run(reason, finalizedBy, nowIso(), attemptId);
  db.prepare("UPDATE identities SET active_attempt_id = NULL, first_attempt_id = COALESCE(first_attempt_id, ?) WHERE id = ?")
    .run(attemptId, attempt.identity_id);
  invalidateLeaderboard();
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
}

function technicalAbort(attemptId, reason) {
  const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  if (!attempt) return null;
  db.prepare("UPDATE attempts SET status = 'technical_aborted', stop_reason = ?, finalized_by = 'client', finished_at = ?, current_timed_item_id = NULL WHERE id = ?")
    .run(reason, nowIso(), attemptId);
  db.prepare(`
    UPDATE identities
    SET used_attempts = CASE WHEN used_attempts > 0 THEN used_attempts - 1 ELSE 0 END,
        active_attempt_id = NULL
    WHERE id = ?
  `).run(attempt.identity_id);
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
}

function resolveExpiredCurrentItem(attemptId) {
  const row = db.prepare(`
    SELECT * FROM attempt_items
    WHERE attempt_id = ? AND load_status = 'ready' AND answered_at IS NULL
    ORDER BY sequence DESC LIMIT 1
  `).get(attemptId);
  if (!row || !row.expires_at) return;
  if (new Date(row.expires_at).getTime() > nowMs()) return;
  answerItem(attemptId, row.id, null, "timeout");
}

function answerItem(attemptId, attemptItemId, selectedIndex, responseType = "normal") {
  const item = db.prepare(`
    SELECT ai.*, q.answer_index
    FROM attempt_items ai JOIN questions q ON q.id = ai.question_id
    WHERE ai.id = ? AND ai.attempt_id = ?
  `).get(attemptItemId, attemptId);
  if (!item) throw new Error("题目不存在。");
  if (item.answered_at) return updateAttemptStats(attemptId);
  if (!item.shown_at || !item.expires_at) throw new Error("题目尚未进入可作答状态。");
  const now = nowMs();
  const expires = new Date(item.expires_at).getTime();
  const shown = new Date(item.shown_at).getTime();
  const timedOut = now > expires || responseType === "timeout";
  const finalType = timedOut ? "timeout" : responseType;
  const finalSelected = timedOut ? null : selectedIndex;
  const correct = finalSelected != null && Number(finalSelected) === Number(item.answer_index);
  const responseMs = Math.max(0, Math.min(CONFIG.questionSeconds * 1000, (timedOut ? expires : now) - shown));
  db.prepare(`
    UPDATE attempt_items
    SET selected_index = ?, response_type = ?, correct = ?, answered_at = ?, response_time_ms = ?
    WHERE id = ?
  `).run(finalSelected, finalType, correct ? 1 : 0, nowIso(), responseMs, item.id);
  db.prepare(`
    UPDATE attempts
    SET active_elapsed_seconds = active_elapsed_seconds + ?,
        current_timed_item_id = NULL,
        last_active_tick_at = NULL
    WHERE id = ?
  `).run(Math.round(responseMs / 1000), attemptId);
  const attempt = updateAttemptStats(attemptId);
  db.prepare("UPDATE attempt_items SET theta_after = ?, se_after = ? WHERE id = ?").run(attempt.theta, attempt.se, item.id);
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
}

function nextOrFinish(attemptId) {
  resolveExpiredCurrentItem(attemptId);
  let attempt = updateAttemptStats(attemptId);
  if (attempt.status === "technical_aborted") return { status: "technical_aborted" };
  const reason = shouldStop(attempt);
  if (reason) {
    attempt = finishAttempt(attemptId, reason);
    return { status: "finished", attemptId, result: publicResult(attempt) };
  }
  const pending = db.prepare(`
    SELECT id FROM attempt_items
    WHERE attempt_id = ? AND answered_at IS NULL
    ORDER BY sequence DESC LIMIT 1
  `).get(attemptId);
  const question = pending ? publicQuestion(pending.id) : assignNextItem(attempt);
  if (!question) {
    attempt = finishAttempt(attemptId, "available_pool_exhausted");
    return { status: "finished", attemptId, result: publicResult(attempt) };
  }
  return { status: "continue", attemptId, question };
}

// ---------------------------------------------------------------------------
// Same-person clustering
// ---------------------------------------------------------------------------

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

function latestFingerprintSignals() {
  const identities = db.prepare("SELECT * FROM identities ORDER BY created_at").all();
  const byIdentity = new Map(identities.map((identity) => [identity.id, { identity, server: null, client: null, latest: null }]));
  const fps = db.prepare("SELECT * FROM fingerprints ORDER BY captured_at ASC, created_at ASC").all();
  for (const fp of fps) {
    const entry = byIdentity.get(fp.identity_id);
    if (!entry) continue;
    entry.latest = fp;
    if (fp.source === "client") entry.client = fp;
    else if (fp.source === "server") entry.server = fp;
  }

  return [...byIdentity.values()].map(({ identity, server, client, latest }) => {
    const source = client || latest || {};
    const net = server || latest || {};
    const webglVendor = source.webgl_vendor || "";
    const webglRenderer = source.webgl_renderer || "";
    const webglKey = source.webgl_hash || (webglVendor && webglRenderer ? hmac(`${webglVendor}|${webglRenderer}`) : null);
    return {
      id: identity.id,
      nickname: identity.nickname || null,
      deviceHash: identity.device_hash || null,
      usedAttempts: identity.used_attempts || 0,
      firstAttemptId: identity.first_attempt_id || null,
      lastSeenAt: identity.last_seen_at || identity.created_at,
      latestFingerprintId: latest ? latest.id : null,
      ipPrefixHash: net.ip_prefix_hash || source.ip_prefix_hash || null,
      ipPrefix: net.ip_prefix || source.ip_prefix || null,
      uaBrowser: net.ua_browser || source.ua_browser || null,
      uaOs: net.ua_os || source.ua_os || null,
      uaDevice: net.ua_device || source.ua_device || null,
      acceptLanguage: net.accept_language || source.accept_language || null,
      timezone: source.timezone || null,
      languages: source.languages || null,
      screenW: source.screen_w || null,
      screenH: source.screen_h || null,
      dpr: source.dpr || null,
      viewportW: source.viewport_w || null,
      viewportH: source.viewport_h || null,
      platform: source.platform || net.uach_platform || null,
      hardwareConcurrency: source.hardware_concurrency || null,
      deviceMemory: source.device_memory || null,
      touch: source.touch == null ? null : Number(source.touch),
      webglVendor,
      webglRenderer,
      webglHash: source.webgl_hash || null,
      webglKey,
      hasFingerprint: Boolean(latest),
    };
  });
}

function sameValue(a, b) {
  const av = nonempty(a);
  const bv = nonempty(b);
  return Boolean(av && bv && av === bv);
}

function sameNumber(a, b, tolerance = 0) {
  const av = Number(a);
  const bv = Number(b);
  return Number.isFinite(av) && Number.isFinite(bv) && Math.abs(av - bv) <= tolerance;
}

function compareIdentitySignals(a, b, overrideAction = null) {
  const matches = [];
  let score = 0;
  let strong = 0;
  let medium = 0;

  const add = (type, label, weight, strength, details = {}) => {
    score += weight;
    if (strength === "strong") strong += 1;
    if (strength === "medium") medium += 1;
    matches.push({ type, label, weight, strength, details });
  };

  if (overrideAction === "force_merge") {
    add("manual", "管理员强制合并", 100, "strong");
  }

  const webglSame = (sameValue(a.webglHash, b.webglHash) || sameValue(a.webglKey, b.webglKey))
    && sameValue(a.webglRenderer, b.webglRenderer);
  if (webglSame) {
    add("webgl", "WebGL 渲染器与哈希一致", 45, "strong", {
      vendor: a.webglVendor || b.webglVendor,
      renderer: a.webglRenderer || b.webglRenderer,
    });
  }

  const screenSame = sameNumber(a.screenW, b.screenW)
    && sameNumber(a.screenH, b.screenH)
    && sameNumber(a.dpr, b.dpr, 0.02)
    && sameValue(a.timezone, b.timezone)
    && sameValue(a.platform, b.platform);
  if (screenSame) {
    add("screen_device", "屏幕/DPR/时区/平台一致", 35, "strong", {
      screen: `${a.screenW}x${a.screenH}`,
      dpr: a.dpr,
      timezone: a.timezone,
      platform: a.platform,
    });
  }

  const ipSame = sameValue(a.ipPrefixHash, b.ipPrefixHash);
  const uaCoreSame = sameValue(a.uaBrowser, b.uaBrowser) && sameValue(a.uaOs, b.uaOs);
  const langSame = sameValue(a.acceptLanguage, b.acceptLanguage) || sameValue(a.languages, b.languages);
  if (ipSame && uaCoreSame && langSame) {
    add("network_ua", "IP 段 + 浏览器/系统 + 语言一致", 30, "medium", {
      ipPrefix: a.ipPrefix || b.ipPrefix,
      browser: a.uaBrowser || b.uaBrowser,
      os: a.uaOs || b.uaOs,
    });
  } else if (ipSame && (uaCoreSame || langSame)) {
    add("network_partial", "IP 段与部分 UA/语言一致", 18, "medium", {
      ipPrefix: a.ipPrefix || b.ipPrefix,
    });
  }

  if (sameValue(a.deviceHash, b.deviceHash)) {
    add("legacy_hash", "旧设备/IP 粗略哈希一致", 22, "medium");
  }

  if (sameValue(a.timezone, b.timezone) && sameValue(a.languages, b.languages)) {
    add("locale", "时区与语言列表一致", 8, "weak");
  }

  if (sameNumber(a.hardwareConcurrency, b.hardwareConcurrency)
    && sameNumber(a.deviceMemory, b.deviceMemory, 0.1)
    && a.touch != null && b.touch != null && Number(a.touch) === Number(b.touch)) {
    add("hardware", "CPU/内存/触摸能力一致", 8, "weak");
  }

  const high = overrideAction === "force_merge"
    || (score >= CONFIG.clusterAutoThreshold && strong >= 2)
    || (score >= 90 && strong >= 1 && medium >= 1);
  const review = !high && score >= CONFIG.clusterReviewThreshold && (strong >= 1 || medium >= 2);
  return {
    score,
    matches,
    strong,
    medium,
    confidenceLevel: high ? "high" : (review ? "medium" : "low"),
    autoEnforced: high,
  };
}

function latestPairOverrides() {
  const rows = db.prepare("SELECT * FROM cluster_overrides ORDER BY created_at ASC, id ASC").all();
  const map = new Map();
  for (const row of rows) map.set(pairKey(row.identity_a, row.identity_b), row);
  return map;
}

function unionFind(ids) {
  const parent = new Map(ids.map((idv) => [idv, idv]));
  const find = (x) => {
    let p = parent.get(x) || x;
    while (p !== parent.get(p)) p = parent.get(p);
    let cur = x;
    while (parent.get(cur) !== p) {
      const next = parent.get(cur);
      parent.set(cur, p);
      cur = next;
    }
    return p;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const groups = () => {
    const out = new Map();
    for (const idv of ids) {
      const root = find(idv);
      if (!out.has(root)) out.set(root, []);
      out.get(root).push(idv);
    }
    return [...out.values()].filter((g) => g.length > 1).map((g) => g.sort());
  };
  return { union, groups };
}

function clusterIdFor(members, status) {
  return `clu_${sha(`${status}:${members.slice().sort().join("|")}`).slice(0, 28)}`;
}

function edgeAppliesTo(edge, members) {
  const set = new Set(members);
  return set.has(edge.identityA) && set.has(edge.identityB);
}

let _clusterRebuildAt = 0;

function rebuildIdentityClusters(force = false) {
  const now = nowMs();
  if (!force && now - _clusterRebuildAt < 5000) return;
  _clusterRebuildAt = now;
  const startedAt = nowMs();

  const signals = latestFingerprintSignals();
  const ids = signals.map((s) => s.id);
  const byId = new Map(signals.map((s) => [s.id, s]));
  const overrides = latestPairOverrides();
  const edges = [];

  const forceMergePairs = [...overrides.entries()]
    .filter(([, override]) => override.action === "force_merge")
    .map(([key]) => key);
  const candidateResult = clusterCandidatePairs(signals, forceMergePairs, CONFIG.clusterRebuildMaxPairs);
  if (candidateResult.truncated) {
    throw new Error(`cluster candidate limit exceeded (${CONFIG.clusterRebuildMaxPairs})`);
  }
  for (const [leftId, rightId] of candidateResult.pairs) {
    if (nowMs() - startedAt > CONFIG.clusterRebuildMaxMs) {
      throw new Error(`cluster rebuild exceeded ${CONFIG.clusterRebuildMaxMs}ms before commit`);
    }
    const a = byId.get(leftId);
    const b = byId.get(rightId);
    if (!a || !b) continue;
    const key = pairKey(a.id, b.id);
    const override = overrides.get(key);
    if (override && override.action === "force_separate") continue;
    const cmp = compareIdentitySignals(a, b, override ? override.action : null);
    if (cmp.confidenceLevel === "low") continue;
    edges.push({
      identityA: a.id,
      identityB: b.id,
      score: cmp.score,
      confidenceLevel: cmp.confidenceLevel,
      autoEnforced: cmp.autoEnforced ? 1 : 0,
      evidence: {
        matches: cmp.matches,
        strong: cmp.strong,
        medium: cmp.medium,
        override: override ? { action: override.action, reason: override.reason || null } : null,
      },
    });
  }

  const highUf = unionFind(ids);
  for (const edge of edges.filter((e) => e.autoEnforced)) highUf.union(edge.identityA, edge.identityB);
  const highGroups = highUf.groups();
  const highMembers = new Set(highGroups.flat());

  const reviewUf = unionFind(ids.filter((idv) => !highMembers.has(idv)));
  for (const edge of edges.filter((e) => !e.autoEnforced && !highMembers.has(e.identityA) && !highMembers.has(e.identityB))) {
    reviewUf.union(edge.identityA, edge.identityB);
  }
  const reviewGroups = reviewUf.groups();

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE identities SET link_cluster_id = NULL").run();
    db.prepare("DELETE FROM identity_cluster_edges").run();
    db.prepare("DELETE FROM identity_cluster_members").run();
    db.prepare("DELETE FROM identity_clusters").run();

    const insertCluster = db.prepare(`
      INSERT INTO identity_clusters (id, status, confidence, auto_enforced, member_count, evidence_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMember = db.prepare(`
      INSERT INTO identity_cluster_members (cluster_id, identity_id, confidence, role, evidence_json, auto_enforced)
      VALUES (?, ?, ?, 'member', ?, ?)
    `);
    const insertEdge = db.prepare(`
      INSERT INTO identity_cluster_edges (id, cluster_id, identity_a, identity_b, score, confidence_level, auto_enforced, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const writeGroup = (members, status, autoEnforced) => {
      const groupEdges = edges.filter((edge) => edgeAppliesTo(edge, members) && (autoEnforced ? edge.autoEnforced : !edge.autoEnforced));
      if (!groupEdges.length) return;
      const confidence = Math.max(...groupEdges.map((edge) => edge.score));
      const clusterId = clusterIdFor(members, status);
      const evidence = {
        status,
        autoEnforced: Boolean(autoEnforced),
        summary: autoEnforced ? "高置信自动合并，同簇共享作答次数并按人上榜。" : "中置信仅供管理员复核，不自动影响用户。",
        topMatches: groupEdges
          .flatMap((edge) => edge.evidence.matches.map((m) => m.label))
          .filter((v, idx, arr) => arr.indexOf(v) === idx)
          .slice(0, 8),
      };
      insertCluster.run(clusterId, status, confidence, autoEnforced ? 1 : 0, members.length, JSON.stringify(evidence), nowIso(), nowIso());
      for (const memberId of members) {
        const memberSignal = byId.get(memberId) || {};
        insertMember.run(clusterId, memberId, confidence, JSON.stringify({
          latestFingerprintId: memberSignal.latestFingerprintId || null,
          nickname: memberSignal.nickname || null,
        }), autoEnforced ? 1 : 0);
        if (autoEnforced) {
          db.prepare("UPDATE identities SET link_cluster_id = ?, last_fingerprint_id = COALESCE(?, last_fingerprint_id) WHERE id = ?")
            .run(clusterId, memberSignal.latestFingerprintId || null, memberId);
        }
      }
      for (const edge of groupEdges) {
        insertEdge.run(id("cedge"), clusterId, edge.identityA, edge.identityB, edge.score, edge.confidenceLevel, edge.autoEnforced, JSON.stringify(edge.evidence), nowIso());
      }
    };

    for (const members of highGroups) writeGroup(members, "auto_high", true);
    for (const members of reviewGroups) writeGroup(members, "review", false);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  invalidateLeaderboard();
  return { identities: ids.length, candidatePairs: candidateResult.count, edges: edges.length };
}

function enforcedClusterForIdentity(identityId) {
  return db.prepare(`
    SELECT c.*
    FROM identity_cluster_members m JOIN identity_clusters c ON c.id = m.cluster_id
    WHERE m.identity_id = ? AND c.auto_enforced = 1
    LIMIT 1
  `).get(identityId) || null;
}

function personIdentityIds(identityId) {
  const cluster = enforcedClusterForIdentity(identityId);
  if (!cluster) return [identityId];
  return db.prepare("SELECT identity_id AS id FROM identity_cluster_members WHERE cluster_id = ? ORDER BY identity_id")
    .all(cluster.id).map((row) => row.id);
}

function attemptUsageForIdentity(identityId) {
  const cluster = enforcedClusterForIdentity(identityId);
  const ids = cluster
    ? db.prepare("SELECT identity_id AS id FROM identity_cluster_members WHERE cluster_id = ? ORDER BY identity_id").all(cluster.id).map((row) => row.id)
    : [identityId];
  const used = ids.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE identity_id IN (${sqlPlaceholders(ids)}) AND status IN ('active', 'finished')`).get(...ids).n
    : 0;
  return {
    cluster,
    identityIds: ids,
    used,
    remaining: Math.max(0, CONFIG.maxAttempts - used),
  };
}

function createAppeal(identityId, message) {
  const cluster = enforcedClusterForIdentity(identityId);
  const recent = db.prepare(`
    SELECT id FROM appeals
    WHERE identity_id = ? AND status = 'open' AND created_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(identityId, new Date(nowMs() - 6 * 60 * 60 * 1000).toISOString());
  if (recent) return recent.id;
  const appealId = id("apl");
  db.prepare("INSERT INTO appeals (id, identity_id, cluster_id, message, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)")
    .run(appealId, identityId, cluster ? cluster.id : null, String(message || "").slice(0, 500), nowIso());
  return appealId;
}

function adminClusterPayload() {
  const clusters = db.prepare("SELECT * FROM identity_clusters ORDER BY auto_enforced DESC, confidence DESC, member_count DESC, updated_at DESC").all();
  return clusters.map((cluster) => {
    const members = db.prepare(`
      SELECT m.identity_id AS identityId, i.nickname, i.used_attempts AS usedAttempts, i.max_attempts AS maxAttempts,
             i.first_attempt_id AS firstAttemptId, i.created_at AS createdAt, i.last_seen_at AS lastSeenAt,
             i.excluded_from_board AS excluded,
             (SELECT COUNT(*) FROM attempts a WHERE a.identity_id = i.id AND a.status = 'finished') AS completedAttempts
      FROM identity_cluster_members m JOIN identities i ON i.id = m.identity_id
      WHERE m.cluster_id = ? ORDER BY i.created_at ASC
    `).all(cluster.id);
    const ids = members.map((m) => m.identityId);
    const stats = ids.length
      ? db.prepare(`SELECT COUNT(*) AS attempts, SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS completed FROM attempts WHERE identity_id IN (${sqlPlaceholders(ids)}) AND status IN ('active', 'finished')`).get(...ids)
      : { attempts: 0, completed: 0 };
    const edges = db.prepare("SELECT * FROM identity_cluster_edges WHERE cluster_id = ? ORDER BY score DESC").all(cluster.id).map((edge) => ({
      identityA: edge.identity_a,
      identityB: edge.identity_b,
      score: Math.round(edge.score),
      confidenceLevel: edge.confidence_level,
      autoEnforced: Boolean(edge.auto_enforced),
      evidence: parseJsonSafe(edge.evidence_json, { matches: [] }),
    }));
    const evidence = parseJsonSafe(cluster.evidence_json, {});
    return {
      clusterId: cluster.id,
      status: cluster.status,
      autoEnforced: Boolean(cluster.auto_enforced),
      confidence: Math.round(cluster.confidence),
      memberCount: cluster.member_count,
      attempts: stats.attempts || 0,
      completed: stats.completed || 0,
      lastSeen: members.map((m) => m.lastSeenAt).filter(Boolean).sort().pop() || null,
      summary: evidence.summary || "",
      topMatches: Array.isArray(evidence.topMatches) ? evidence.topMatches : [],
      evidence,
      members,
      edges,
    };
  });
}

// ---------------------------------------------------------------------------
// Leaderboard + result
// ---------------------------------------------------------------------------

let _lbCache = { at: 0, data: null };

function invalidateLeaderboard() {
  _lbCache = { at: 0, data: null };
}

function buildLeaderboard() {
  const now = nowMs();
  if (_lbCache.data && now - _lbCache.at < CONFIG.leaderboardCacheMs) return _lbCache.data;
  const attempts = db.prepare(`
    SELECT i.id AS identityId, i.nickname AS nickname, i.excluded_from_board AS excluded,
           COALESCE(m.cluster_id, i.id) AS personKey,
           a.id AS attemptId, a.reported_ability_index AS idx, a.below_reportable_threshold AS below,
           a.finished_at AS fin, a.started_at AS started
    FROM identities i
    JOIN attempts a ON a.identity_id = i.id
    LEFT JOIN identity_cluster_members m ON m.identity_id = i.id AND m.auto_enforced = 1
    WHERE a.status = 'finished'
    ORDER BY a.finished_at ASC, a.started_at ASC, a.id ASC
  `).all();
  const firstByPerson = new Map();
  for (const attempt of attempts) {
    if (!firstByPerson.has(attempt.personKey)) firstByPerson.set(attempt.personKey, attempt);
  }
  const rows = [...firstByPerson.values()]
    .filter((r) => !r.excluded && r.idx != null && !r.below)
    .sort((a, b) => (b.idx - a.idx) || String(a.fin || "").localeCompare(String(b.fin || "")))
    .map((r) => ({
      identityId: r.identityId,
      personKey: r.personKey,
      attemptId: r.attemptId,
      nickname: r.nickname,
      idx: r.idx,
      fin: r.fin,
    }));
  const rankByIdentity = new Map();
  const rankByPerson = new Map();
  rows.forEach((r, i) => rankByPerson.set(r.personKey, i + 1));
  const memberships = db.prepare("SELECT cluster_id, identity_id FROM identity_cluster_members WHERE auto_enforced = 1").all();
  rows.forEach((r, i) => {
    rankByIdentity.set(r.identityId, i + 1);
    for (const m of memberships) {
      if (m.cluster_id === r.personKey) rankByIdentity.set(m.identity_id, i + 1);
    }
  });
  const dist = Array.from({ length: 10 }, () => 0);
  for (const r of rows) dist[Math.max(0, Math.min(9, Math.floor(r.idx / 10)))] += 1;
  const totalParticipants = firstByPerson.size;
  const data = { rows, firstByPerson, total: rows.length, rankByIdentity, rankByPerson, dist, totalParticipants };
  _lbCache = { at: now, data };
  return data;
}

function standingForIdentity(identity) {
  const lb = buildLeaderboard();
  const base = { onBoard: false, boardRank: null, percentile: null, totalRanked: lb.total };
  if (!identity) return base;
  const cluster = enforcedClusterForIdentity(identity.id);
  const personKey = cluster ? cluster.id : identity.id;
  const first = lb.firstByPerson.get(personKey);
  if (!first || first.below) return base;
  const rank = lb.rankByPerson.get(personKey) || null;
  const beaten = lb.rows.filter((r) => r.idx < first.idx).length;
  const percentile = lb.total > 1 ? Math.max(0, Math.min(99, Math.round((beaten / (lb.total - 1)) * 100))) : null;
  return { onBoard: rank != null, boardRank: rank, percentile, totalRanked: lb.total };
}

function rankLabelFrom(standing) {
  if (standing.percentile == null) return "样本较少，暂未生成排名";
  return `超过约 ${standing.percentile}% 的测试者`;
}

function publicResult(attempt) {
  const identity = db.prepare("SELECT * FROM identities WHERE id = ?").get(attempt.identity_id);
  const lb = buildLeaderboard();
  const cluster = identity ? enforcedClusterForIdentity(identity.id) : null;
  const personKey = cluster ? cluster.id : (identity ? identity.id : attempt.identity_id);
  const first = lb.firstByPerson.get(personKey);
  const rankingAttemptId = first ? first.attemptId : ((identity && identity.first_attempt_id) || attempt.id);
  const ra = db.prepare("SELECT * FROM attempts WHERE id = ?").get(rankingAttemptId) || attempt;
  const below = Boolean(ra.below_reportable_threshold);
  const idx = ra.reported_ability_index ?? 0;
  const standing = standingForIdentity(identity);
  const isPractice = attempt.id !== rankingAttemptId;
  const out = {
    abilityIndex: idx,
    tier: tierFromScore(idx, below),
    level: tierFromScore(idx, below),
    message: messageFromScore(idx, below),
    rank: rankLabelFrom(standing),
    percentile: standing.percentile,
    onBoard: standing.onBoard,
    boardRank: standing.boardRank,
    totalRanked: standing.totalRanked,
    nickname: identity ? identity.nickname || null : null,
    displayNickname: identity ? displayNickname(identity.nickname, identity.id) : defaultNicknameForIdentity(null),
    isPractice,
  };
  if (isPractice) {
    const pBelow = Boolean(attempt.below_reportable_threshold);
    const pIdx = attempt.reported_ability_index ?? 0;
    out.practiceAbilityIndex = pIdx;
    out.practiceTier = tierFromScore(pIdx, pBelow);
  }
  return out;
}

function recalculateIdentityAfterAttemptDelete(identityId, deletedAttempt) {
  if (!identityId) return null;
  const identity = db.prepare("SELECT * FROM identities WHERE id = ?").get(identityId);
  if (!identity) return null;

  const nextFirst = db.prepare(`
    SELECT id FROM attempts
    WHERE identity_id = ? AND status = 'finished'
    ORDER BY started_at ASC, id ASC
    LIMIT 1
  `).get(identityId);
  const used = db.prepare(`
    SELECT COUNT(*) AS n FROM attempts
    WHERE identity_id = ? AND status IN ('active', 'finished')
  `).get(identityId).n;
  const activeStillExists = identity.active_attempt_id
    ? db.prepare("SELECT id FROM attempts WHERE id = ? AND identity_id = ? AND status = 'active'").get(identity.active_attempt_id, identityId)
    : null;

  db.prepare(`
    UPDATE identities
    SET first_attempt_id = ?,
        active_attempt_id = ?,
        used_attempts = MIN(max_attempts, ?)
    WHERE id = ?
  `).run(nextFirst ? nextFirst.id : null, activeStillExists ? activeStillExists.id : null, used, identityId);

  return {
    oldFirstAttemptId: identity.first_attempt_id || null,
    newFirstAttemptId: nextFirst ? nextFirst.id : null,
    deletedWasActive: Boolean(deletedAttempt && identity.active_attempt_id === deletedAttempt.id),
    recalculatedUsedAttempts: used,
  };
}

function deleteAttemptRecord(attemptId, adminId) {
  const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  if (!attempt) return null;
  const itemCount = db.prepare("SELECT COUNT(*) AS n FROM attempt_items WHERE attempt_id = ?").get(attemptId).n;
  const summary = {
    attemptId: attempt.id,
    identityId: attempt.identity_id,
    status: attempt.status,
    reportedAbilityIndex: attempt.reported_ability_index,
    correctCount: attempt.correct_count,
    answerCount: attempt.answer_count,
    timeoutCount: attempt.timeout_count,
    stopReason: attempt.stop_reason,
    startedAt: attempt.started_at,
    finishedAt: attempt.finished_at,
    itemCount,
  };

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM attempt_items WHERE attempt_id = ?").run(attempt.id);
    db.prepare("DELETE FROM attempts WHERE id = ?").run(attempt.id);
    const identityUpdate = recalculateIdentityAfterAttemptDelete(attempt.identity_id, attempt);
    db.prepare(`
      INSERT INTO audit_logs
      (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id("aud"),
      "admin",
      adminId,
      "delete_attempt",
      "attempt",
      attempt.id,
      JSON.stringify({ ...summary, identityUpdate }),
      nowIso(),
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  invalidateLeaderboard();
  return summary;
}

function sanitizeNickname(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/[\x00-\x1f\x7f]/g, "").replace(/[<>]/g, "").trim();
  return s.slice(0, 16);
}

function defaultNicknameForIdentity(identityId) {
  if (!identityId) return `${CONFIG.defaultNickname}0000`;
  let value = Number.parseInt(hmac(`default-nickname:${identityId}`).slice(0, 8), 16) % 10000;
  if (value === 8964) value = 8965;
  return `${CONFIG.defaultNickname}${String(value).padStart(4, "0")}`;
}

function displayNickname(nickname, identityId = null) {
  const clean = sanitizeNickname(nickname);
  if (clean && clean !== `${CONFIG.defaultNickname}8964`) return clean;
  return defaultNicknameForIdentity(identityId);
}

function nicknameReviewRemaining(identity) {
  const failures = Number(identity.nickname_review_failures || 0);
  const locked = Boolean(identity.nickname_review_locked);
  return locked ? 0 : Math.max(0, CONFIG.nicknameReviewMaxFailures - failures);
}

function resetNicknameReview(identityId, roundNumber) {
  db.prepare(`
    UPDATE identities
    SET nickname_review_failures = 0,
        nickname_review_locked = 0,
        nickname_review_status = ?,
        nickname_reviewed_at = ?,
        nickname_review_request_id = NULL,
        nickname_review_label = NULL,
        nickname_review_suggestion = NULL,
        last_seen_at = ?
    WHERE id = ?
  `).run(`practice_round_${roundNumber}_reset`, nowIso(), nowIso(), identityId);
}

function tc3Hmac(key, msg, encoding) {
  return crypto.createHmac("sha256", key).update(msg, "utf8").digest(encoding);
}

function tc3Date(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function tencentTmsConfigured() {
  return Boolean(CONFIG.tencentTmsSecretId && CONFIG.tencentTmsSecretKey);
}

function localNicknamePrecheck(nickname) {
  const value = String(nickname || "").toLowerCase();
  const compact = value.replace(/\s+/g, "");
  const rules = [
    { label: "LocalSensitiveDefault", pattern: /逍遥雀士\s*8964/i },
    { label: "LocalAd", pattern: /(加我|私聊|关注|领取|领红包|优惠券|返现|代打|陪玩|推广|广告|进群|入群|群号|微信|微.?信|v信|vx|qq|q群|http|www\.|\.com|\.cn)/i },
    { label: "LocalPolitical", pattern: /(习近平|共产党|国民党|民进党|台独|港独|法轮功|政治|民主革命|六四|64事件)/i },
    { label: "LocalAbuse", pattern: /(傻逼|操你|艹|妈的|去死|滚|废物|垃圾)/i },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(value) || rule.pattern.test(compact)) {
      return {
        blocked: true,
        suggestion: "Block",
        label: rule.label,
        provider: "local_rule",
      };
    }
  }
  return { blocked: false };
}

async function moderateNicknameWithTencent(nickname, identity) {
  if (!tencentTmsConfigured()) {
    if (!IS_PROD) {
      return { available: false, passed: true, suggestion: "Pass", label: "DevBypass", provider: "disabled_dev" };
    }
    return { available: false, passed: false, suggestion: "Unavailable", label: "ProviderNotConfigured", provider: "tencent_tms" };
  }

  const host = CONFIG.tencentTmsEndpoint;
  const service = "tms";
  const action = "TextModeration";
  const version = "2020-12-29";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = tc3Date(timestamp);
  const contentType = "application/json; charset=utf-8";
  const payload = JSON.stringify({
    Content: Buffer.from(nickname, "utf8").toString("base64"),
    BizType: CONFIG.tencentTmsBizType,
    DataId: id("nick").slice(0, 64),
    Type: "TEXT",
    SourceLanguage: "zh",
    SessionId: identity.id.slice(0, 64),
  });

  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-tc-action:${action.toLowerCase()}`,
    "",
  ].join("\n");
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha(payload),
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    String(timestamp),
    credentialScope,
    sha(canonicalRequest),
  ].join("\n");
  const secretDate = tc3Hmac(`TC3${CONFIG.tencentTmsSecretKey}`, date);
  const secretService = tc3Hmac(secretDate, service);
  const secretSigning = tc3Hmac(secretService, "tc3_request");
  const signature = tc3Hmac(secretSigning, stringToSign, "hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${CONFIG.tencentTmsSecretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.tencentTmsTimeoutMs);
  try {
    const response = await fetch(`https://${host}/`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: authorization,
        "Content-Type": contentType,
        Host: host,
        "X-TC-Action": action,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": version,
        "X-TC-Region": CONFIG.tencentTmsRegion,
        "X-TC-Language": "zh-CN",
      },
      body: payload,
    });
    const textBody = await response.text();
    const data = textBody ? JSON.parse(textBody) : {};
    const out = data.Response || {};
    if (!response.ok || out.Error) {
      return {
        available: false,
        passed: false,
        suggestion: out.Error ? out.Error.Code : `HTTP_${response.status}`,
        label: "ProviderError",
        requestId: out.RequestId || null,
        provider: "tencent_tms",
      };
    }
    return {
      available: true,
      passed: out.Suggestion === "Pass",
      suggestion: out.Suggestion || "",
      label: out.Label || "",
      subLabel: out.SubLabel || "",
      score: out.Score == null ? null : Number(out.Score),
      requestId: out.RequestId || null,
      provider: "tencent_tms",
    };
  } catch (err) {
    return {
      available: false,
      passed: false,
      suggestion: err && err.name === "AbortError" ? "Timeout" : "RequestFailed",
      label: "ProviderError",
      requestId: null,
      provider: "tencent_tms",
    };
  } finally {
    clearTimeout(timer);
  }
}

function writeNicknameReview(identityId, nickname, moderation) {
  const now = nowIso();
  if (moderation.passed) {
    db.prepare(`
      UPDATE identities
      SET nickname = ?,
          nickname_review_locked = 1,
          nickname_review_status = 'pass',
          nickname_reviewed_at = ?,
          nickname_review_request_id = ?,
          nickname_review_label = ?,
          nickname_review_suggestion = ?,
          last_seen_at = ?
      WHERE id = ?
    `).run(nickname, now, moderation.requestId || null, moderation.label || null, moderation.suggestion || null, now, identityId);
    invalidateLeaderboard();
    return db.prepare("SELECT * FROM identities WHERE id = ?").get(identityId);
  }

  const current = db.prepare("SELECT * FROM identities WHERE id = ?").get(identityId);
  const failures = Number(current.nickname_review_failures || 0) + (moderation.available ? 1 : 0);
  const locked = moderation.available && failures >= CONFIG.nicknameReviewMaxFailures ? 1 : Number(current.nickname_review_locked || 0);
  db.prepare(`
    UPDATE identities
    SET nickname = NULL,
        nickname_review_failures = ?,
        nickname_review_locked = ?,
        nickname_review_status = ?,
        nickname_reviewed_at = ?,
        nickname_review_request_id = ?,
        nickname_review_label = ?,
        nickname_review_suggestion = ?,
        last_seen_at = ?
    WHERE id = ?
  `).run(
    failures,
    locked,
    moderation.available ? "reject" : "unavailable",
    now,
    moderation.requestId || null,
    moderation.label || null,
    moderation.suggestion || null,
    now,
    identityId,
  );
  invalidateLeaderboard();
  return db.prepare("SELECT * FROM identities WHERE id = ?").get(identityId);
}

// ---------------------------------------------------------------------------
// Static
// ---------------------------------------------------------------------------

function serveFile(res, filePath, cache = "public, max-age=3600", headOnly = false, extraHeaders = {}) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    text(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": cache,
    ...extraHeaders,
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
}

function staticCacheFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "no-store";
  if (ext === ".js" || ext === ".css") return "public, max-age=31536000, immutable";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".woff", ".woff2"].includes(ext)) {
    return "public, max-age=604800";
  }
  return "public, max-age=3600";
}

function normalizedHost(req) {
  const raw = String(req.headers.host || "").split(",")[0].trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(1, end) : raw;
  }
  return raw.replace(/:\d+$/, "");
}

function isConfiguredPublicHost(req) {
  return CONFIG.publicHostnames.includes(normalizedHost(req));
}

function isConfiguredAdminHost(req) {
  return CONFIG.adminHostnames.includes(normalizedHost(req));
}

function isKnownHost(req) {
  if (!IS_PROD) return true;
  const host = normalizedHost(req);
  return CONFIG.publicHostnames.includes(host) || CONFIG.adminHostnames.includes(host);
}

function isAdminHost(req, pathname) {
  if (isConfiguredAdminHost(req)) return true;
  if (!IS_PROD) {
    const host = normalizedHost(req);
    return host.startsWith("admin.") || pathname === "/admin" || pathname.startsWith("/admin/");
  }
  return false;
}

// ---------------------------------------------------------------------------
// User / public API
// ---------------------------------------------------------------------------

async function handleUserApi(req, res, url) {
  if (isTencentMobileBrowser(req)) {
    return json(res, 403, {
      code: "TENCENT_IN_APP_BROWSER_BLOCKED",
      error: "请在外部浏览器打开本测试。微信或 QQ 内置浏览器不支持正式作答。",
    });
  }

  if (practiceService) {
    const practiceHandled = await practiceService.handleUserApi(req, res, url);
    if (practiceHandled !== false) return practiceHandled;
  }

  const examApi = url.pathname === "/api/leaderboard"
    || url.pathname.startsWith("/api/sample")
    || url.pathname.startsWith("/api/attempts")
    || url.pathname.startsWith("/api/appeals");
  if (!CONFIG.examEnabled && examApi) {
    return json(res, 403, { code: "EXAM_DISABLED", error: "考试模式暂未开放。" });
  }

  if (url.pathname === "/api/leaderboard" && req.method === "GET") {
    const limited = checkRateLimit(req, "leaderboard", CONFIG.leaderboardRateLimitPerMinute, 60);
    if (!limited.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limited.retryAfterSeconds }, { "Retry-After": String(limited.retryAfterSeconds) });
    }
    const lb = buildLeaderboard();
    const topN = Math.max(1, Math.min(200, Number(url.searchParams.get("top")) || CONFIG.defaultTopN));
    const top = lb.rows.slice(0, topN).map((r, i) => ({
      rank: i + 1,
      nickname: displayNickname(r.nickname, r.identityId),
      abilityIndex: r.idx,
      tier: tierFromScore(r.idx, false),
    }));
    const identity = getIdentity(req);
    let you = null;
    if (identity) {
      const standing = standingForIdentity(identity);
      let idx = null;
      let tier = null;
      if (identity.first_attempt_id) {
        const fa = db.prepare("SELECT reported_ability_index AS idx, below_reportable_threshold AS bt FROM attempts WHERE id = ?").get(identity.first_attempt_id);
        if (fa) { idx = fa.idx ?? 0; tier = tierFromScore(idx, Boolean(fa.bt)); }
      }
      you = {
        hasResult: Boolean(identity.first_attempt_id),
        abilityIndex: idx,
        tier,
        onBoard: standing.onBoard,
        boardRank: standing.boardRank,
        percentile: standing.percentile,
        nickname: identity.nickname || null,
        displayNickname: displayNickname(identity.nickname, identity.id),
      };
    }
    return json(res, 200, { top, totalRanked: lb.total, totalParticipants: lb.totalParticipants, distribution: lb.dist, defaultNickname: identity ? defaultNicknameForIdentity(identity.id) : defaultNicknameForIdentity(null), you });
  }

  if (req.method === "GET" && url.pathname === "/api/user/me") {
    const limited = checkRateLimit(req, "user_me", CONFIG.userMeRateLimitPerMinute, 60);
    if (!limited.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limited.retryAfterSeconds }, { "Retry-After": String(limited.retryAfterSeconds) });
    }
    let identity = getIdentity(req);
    let setCookieHeader = null;
    if (!identity) {
      const identityCreateLimit = checkRateLimit(req, "identity_create", CONFIG.identityCreateRateLimitPerHour, 60 * 60);
      if (!identityCreateLimit.allowed) {
        return json(res, 429, { error: "身份创建请求过于频繁，请稍后再试。", retryAfterSeconds: identityCreateLimit.retryAfterSeconds }, { "Retry-After": String(identityCreateLimit.retryAfterSeconds) });
      }
      identity = mintIdentity(req, res);
      setCookieHeader = res.__identityCookie;
    } else {
      db.prepare("UPDATE identities SET last_seen_at = ? WHERE id = ?").run(nowIso(), identity.id);
    }
    const usage = attemptUsageForIdentity(identity.id);
    const remaining = usage.remaining;
    const payload = {
      ready: true,
      csrf: identity.csrf_token,
      sampleStatus: identity.sample_status,
      nickname: identity.nickname || null,
      remainingAttempts: remaining,
      maxAttempts: CONFIG.maxAttempts,
      activeAttemptId: identity.active_attempt_id || null,
      hasResult: Boolean(identity.first_attempt_id),
      firstAttemptId: identity.first_attempt_id || null,
      sharedAttemptLimit: Boolean(usage.cluster),
      defaultNickname: defaultNicknameForIdentity(identity.id),
      displayNickname: displayNickname(identity.nickname, identity.id),
      examEnabled: CONFIG.examEnabled,
      practiceEnabled: true,
      nicknameReviewRemaining: nicknameReviewRemaining(identity),
      nicknameReviewLocked: Boolean(identity.nickname_review_locked),
    };
    return json(res, 200, payload, setCookieHeader ? { "Set-Cookie": setCookieHeader } : {});
  }

  if (url.pathname === "/api/sample" && req.method === "GET") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    return json(res, 200, publicSample(identity));
  }

  if (req.method === "POST" && url.pathname === "/api/sample/answer") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const body = await readJson(req);
    const idx = Number(body.selectedIndex);
    const options = sampleOptions();
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) return json(res, 400, { error: "请选择一个样题选项。" });
    db.prepare("UPDATE identities SET sample_status = 'answered', sample_selected_index = ? WHERE id = ?").run(idx, identity.id);
    const fresh = db.prepare("SELECT * FROM identities WHERE id = ?").get(identity.id);
    return json(res, 200, publicSample(fresh));
  }

  if (req.method === "POST" && url.pathname === "/api/sample/confirm") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    if (identity.sample_selected_index == null) return json(res, 400, { error: "请先完成样题。" });
    db.prepare("UPDATE identities SET sample_status = 'confirmed' WHERE id = ?").run(identity.id);
    return json(res, 200, { ok: true, csrf: identity.csrf_token });
  }

  if (req.method === "POST" && url.pathname === "/api/user/nickname") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "nickname", CONFIG.nicknameRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, {
        error: `操作太频繁，请 ${limit.retryAfterSeconds} 秒后再试。`,
        retryAfterSeconds: limit.retryAfterSeconds,
        csrf: identity.csrf_token,
      });
    }
    const body = await readJson(req);
    const nickname = sanitizeNickname(body.nickname);
    const fresh = db.prepare("SELECT * FROM identities WHERE id = ?").get(identity.id);
    if (fresh.nickname_review_locked) {
      return json(res, 200, {
        ok: false,
        rejected: true,
        locked: true,
        canRetry: false,
        message: "当前昵称本轮已设定，暂不能再次修改。",
        nickname: fresh.nickname || null,
        displayNickname: displayNickname(fresh.nickname, fresh.id),
        defaultNickname: defaultNicknameForIdentity(fresh.id),
        nicknameReviewRemaining: 0,
        nicknameReviewLocked: true,
        csrf: identity.csrf_token,
      });
    }
    if (!nickname) {
      db.prepare(`
        UPDATE identities
        SET nickname = NULL,
            nickname_review_status = 'default',
            nickname_reviewed_at = ?,
            last_seen_at = ?
        WHERE id = ?
      `).run(nowIso(), nowIso(), identity.id);
      invalidateLeaderboard();
      return json(res, 200, {
        ok: true,
        nickname: null,
        displayNickname: defaultNicknameForIdentity(identity.id),
        defaultNickname: defaultNicknameForIdentity(identity.id),
        nicknameReviewRemaining: nicknameReviewRemaining(fresh),
        nicknameReviewLocked: Boolean(fresh.nickname_review_locked),
        csrf: identity.csrf_token,
      });
    }
    if (nickname.length < 2) return json(res, 400, { error: "昵称至少 2 个字符。", csrf: identity.csrf_token });

    let moderation = await moderateNicknameWithTencent(nickname, fresh);
    const localRule = localNicknamePrecheck(nickname);
    if (moderation.passed && localRule.blocked) {
      moderation = {
        ...moderation,
        passed: false,
        available: true,
        suggestion: localRule.suggestion,
        label: localRule.label,
        provider: `${moderation.provider}+${localRule.provider}`,
      };
    }
    const updated = writeNicknameReview(fresh.id, nickname, moderation);
    const remaining = nicknameReviewRemaining(updated);
    if (moderation.passed) {
      return json(res, 200, {
        ok: true,
        approved: true,
        nickname,
        displayNickname: nickname,
        defaultNickname: defaultNicknameForIdentity(fresh.id),
        nicknameReviewRemaining: remaining,
        nicknameReviewLocked: Boolean(updated.nickname_review_locked),
        csrf: identity.csrf_token,
      });
    }

    const locked = Boolean(updated.nickname_review_locked);
    const message = locked
      ? "已为你使用默认名称。"
      : "哎呀，这个名字暂时用不了，换一个试试吧～";
    return json(res, 200, {
      ok: false,
      locked,
      canRetry: !locked,
      message,
      nickname: null,
      displayNickname: defaultNicknameForIdentity(fresh.id),
      defaultNickname: defaultNicknameForIdentity(fresh.id),
      nicknameReviewRemaining: remaining,
      nicknameReviewLocked: locked,
      csrf: identity.csrf_token,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/fp") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "fp", CONFIG.attemptWriteRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const recent = db.prepare("SELECT created_at FROM fingerprints WHERE identity_id = ? AND source = 'client' ORDER BY created_at DESC LIMIT 1").get(identity.id);
    if (recent && (nowMs() - new Date(recent.created_at).getTime()) < 10 * 60 * 1000) {
      return json(res, 200, { ok: true, throttled: true, csrf: identity.csrf_token });
    }
    const c = (await readJson(req)) || {};
    const ip = clientIp(req);
    const ipPrefix = ipPrefixOf(ip);
    const ua = String(req.headers["user-agent"] || "");
    const parsed = parseUserAgent(ua);
    const num = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : null; };
    const real = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const str = (v, max) => (v == null ? null : String(v).slice(0, max));
    const langs = Array.isArray(c.languages) ? c.languages.join(",") : c.languages;
    const fingerprintId = id("fp");
    db.prepare(`
      INSERT INTO fingerprints
      (id, identity_id, attempt_id, captured_at, source, ip_hash, ip_prefix_hash, ip_prefix,
       ua_raw, ua_browser, ua_os, ua_device, ua_mobile, accept_language,
       timezone, languages, screen_w, screen_h, dpr, viewport_w, viewport_h, platform,
       hardware_concurrency, device_memory, touch, color_depth, color_scheme,
       webgl_vendor, webgl_renderer, webgl_hash, signal_json, created_at)
      VALUES (?, ?, ?, ?, 'client', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fingerprintId, identity.id, identity.active_attempt_id || null, nowIso(),
      ip ? hmac(ip) : null, ipPrefix ? hmac(ipPrefix) : null, ipPrefix || null,
      ua.slice(0, 400), parsed.browser, parsed.os, parsed.device, parsed.mobile ? 1 : 0, String(req.headers["accept-language"] || "").slice(0, 200),
      str(c.timezone, 64), str(langs, 200), num(c.screenW, 100000), num(c.screenH, 100000), real(c.dpr), num(c.viewportW, 100000), num(c.viewportH, 100000), str(c.platform, 64),
      num(c.hardwareConcurrency, 1024), real(c.deviceMemory), c.touch ? 1 : 0, num(c.colorDepth, 64), str(c.colorScheme, 16),
      str(c.webglVendor, 128), str(c.webglRenderer, 256), str(c.webglHash, 64), JSON.stringify(c).slice(0, 2000), nowIso(),
    );
    db.prepare("UPDATE identities SET last_fingerprint_id = ? WHERE id = ?").run(fingerprintId, identity.id);
    markClusterRebuildDirty(); // PERF-001：只标记需要重算，由后台任务合并执行，不在请求内做全量聚类
    return json(res, 200, { ok: true, csrf: identity.csrf_token });
  }

  if (req.method === "POST" && url.pathname === "/api/appeals") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "appeals", CONFIG.nicknameRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const body = await readJson(req);
    const appealId = createAppeal(identity.id, body.message || "用户请求人工复核同一性拦截。");
    return json(res, 200, {
      ok: true,
      appealId,
      message: "已提交复核请求。请保留当前页面，并联系管理员说明情况。",
      csrf: identity.csrf_token,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/attempts/start") {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "attempt_start", CONFIG.attemptStartRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const fresh = db.prepare("SELECT * FROM identities WHERE id = ?").get(identity.id);
    if (fresh.sample_status !== "confirmed") return json(res, 400, { error: "请先完成样题并确认理解。" });
    if (fresh.active_attempt_id) {
      const active = db.prepare("SELECT * FROM attempts WHERE id = ?").get(fresh.active_attempt_id);
      if (active && active.identity_id === fresh.id && active.status === "active") {
        return json(res, 200, nextOrFinish(active.id));
      }
      db.prepare("UPDATE identities SET active_attempt_id = NULL WHERE id = ?").run(fresh.id);
    }
    const usage = attemptUsageForIdentity(fresh.id);
    if (usage.used >= CONFIG.maxAttempts) {
      return json(res, 403, {
        code: "DUPLICATE_ATTEMPT_LIMIT",
        error: "系统检测到当前会话与已有记录高度相似，因此共享总计 2 次作答机会；当前机会已用完。如你认为这是误判，可以提交复核请求。",
        remainingAttempts: 0,
        appealAvailable: true,
        clusterId: usage.cluster ? usage.cluster.id : null,
      });
    }
    const attemptId = id("att");
    db.prepare(`
      INSERT INTO attempts (id, identity_id, status, total_budget_seconds, started_at, last_resumed_at)
      VALUES (?, ?, 'active', ?, ?, ?)
    `).run(attemptId, fresh.id, CONFIG.totalBudgetSeconds, nowIso(), nowIso());
    db.prepare("UPDATE identities SET used_attempts = used_attempts + 1, active_attempt_id = ? WHERE id = ?").run(attemptId, fresh.id);
    try {
      captureServerFingerprint(req, fresh.id, attemptId);
    } catch (err) {
      console.error("[fp] capture failed", err.message);
    }
    return json(res, 200, nextOrFinish(attemptId));
  }

  const currentMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/current$/);
  if (req.method === "GET" && currentMatch) {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "attempt_current", CONFIG.attemptWriteRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ? AND identity_id = ?").get(currentMatch[1], identity.id);
    if (!attempt) return json(res, 404, { error: "测试不存在。" });
    if (attempt.status === "finished") return json(res, 200, { status: "finished", attemptId: attempt.id, result: publicResult(attempt) });
    if (attempt.status === "technical_aborted") return json(res, 200, { status: "technical_aborted", attemptId: attempt.id });
    return json(res, 200, nextOrFinish(attempt.id));
  }

  const readyMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/items\/([^/]+)\/ready$/);
  if (req.method === "POST" && readyMatch) {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "attempt_write", CONFIG.attemptWriteRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const [attemptId, itemId] = [readyMatch[1], readyMatch[2]];
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ? AND identity_id = ? AND status = 'active'").get(attemptId, identity.id);
    if (!attempt) return json(res, 404, { error: "测试不存在。" });
    const item = db.prepare("SELECT * FROM attempt_items WHERE id = ? AND attempt_id = ? AND answered_at IS NULL").get(itemId, attemptId);
    if (!item) return json(res, 404, { error: "题目不存在。" });
    if (item.load_status !== "ready") {
      const assignedMs = new Date(item.assigned_at).getTime();
      if (nowMs() - assignedMs > CONFIG.readyTimeoutSeconds * 1000 * 2) {
        const aborted = technicalAbort(attemptId, "ready_timeout");
        return json(res, 200, { status: "technical_aborted", attemptId: aborted.id });
      }
      const shown = nowIso();
      const expires = new Date(nowMs() + CONFIG.questionSeconds * 1000).toISOString();
      db.prepare("UPDATE attempt_items SET load_status = 'ready', ready_at = ?, shown_at = ?, expires_at = ? WHERE id = ?")
        .run(shown, shown, expires, itemId);
      db.prepare("UPDATE attempts SET current_timed_item_id = ?, formal_started_at = COALESCE(formal_started_at, ?), last_active_tick_at = ? WHERE id = ?")
        .run(itemId, shown, shown, attemptId);
      recordExposure(item.question_id);
    }
    return json(res, 200, { status: "continue", attemptId, question: publicQuestion(itemId, true), csrf: identity.csrf_token });
  }

  const failMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/items\/([^/]+)\/load-failed$/);
  if (req.method === "POST" && failMatch) {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "attempt_write", CONFIG.attemptWriteRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ? AND identity_id = ? AND status = 'active'").get(failMatch[1], identity.id);
    if (!attempt) return json(res, 404, { error: "测试不存在。" });
    db.prepare("UPDATE attempt_items SET load_status = 'image_failed' WHERE id = ? AND attempt_id = ?").run(failMatch[2], attempt.id);
    const aborted = technicalAbort(attempt.id, "resource_load_failed");
    return json(res, 200, { status: "technical_aborted", attemptId: aborted.id });
  }

  const answerMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/(answer|timeout|finish)$/);
  if (req.method === "POST" && answerMatch) {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const limit = checkRateLimit(req, "attempt_write", CONFIG.attemptWriteRateLimitPerMinute, 60);
    if (!limit.allowed) {
      return json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: limit.retryAfterSeconds, csrf: identity.csrf_token }, { "Retry-After": String(limit.retryAfterSeconds) });
    }
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ? AND identity_id = ? AND status = 'active'").get(answerMatch[1], identity.id);
    if (!attempt) return json(res, 404, { error: "测试不存在。" });
    if (answerMatch[2] === "finish") {
      const finished = finishAttempt(attempt.id, "user_early_finish");
      return json(res, 200, { status: "finished", attemptId: attempt.id, result: publicResult(finished), csrf: identity.csrf_token });
    }
    const body = await readJson(req);
    const itemId = body.attemptItemId;
    try {
      answerItem(attempt.id, itemId, answerMatch[2] === "timeout" ? null : Number(body.selectedIndex), answerMatch[2] === "timeout" ? "timeout" : "normal");
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    return json(res, 200, nextOrFinish(attempt.id));
  }

  const resultMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/result$/);
  if (req.method === "GET" && resultMatch) {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ? AND identity_id = ?").get(resultMatch[1], identity.id);
    if (!attempt) return json(res, 404, { error: "测试不存在。" });
    if (attempt.status !== "finished") return json(res, 400, { error: "测试尚未完成。" });
    return json(res, 200, { status: "finished", result: publicResult(attempt) });
  }

  const imgMatch = url.pathname.match(/^\/api\/question-image\/([^/]+)$/);
  if (req.method === "GET" && imgMatch) {
    const identity = requireIdentity(req, res);
    if (!identity) return;
    const row = db.prepare(`
      SELECT ai.*, q.image_path, a.identity_id
      FROM attempt_items ai
      JOIN attempts a ON a.id = ai.attempt_id
      JOIN questions q ON q.id = ai.question_id
      WHERE ai.id = ?
    `).get(imgMatch[1]);
    if (!row || row.identity_id !== identity.id) return text(res, 404, "Not found");
    return serveFile(res, questionImagePath(row.image_path), "private, no-store");
  }

  return false;
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

async function handleAdminApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/admin/me") {
    const session = getAdminSession(req);
    if (!session) return json(res, 200, { loggedIn: false });
    return json(res, 200, { loggedIn: true, csrf: session.csrf_token });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const limited = checkRateLimit(req, "admin_login", 8, 300);
    if (!limited.allowed) {
      return json(res, 429, { error: "登录尝试过于频繁，请稍后再试。" }, { "Retry-After": String(limited.retryAfterSeconds) });
    }
    const body = await readJson(req);
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const totp = typeof body.totp === "string" ? body.totp.trim() : "";
    if (!username || username.length > 128 || password.length > 1024 || totp.length > 16) {
      return json(res, 400, { error: "管理员登录参数无效。" });
    }
    const accountRule = adminLoginAccountRule(username);
    const accountLimit = rateLimiter.check([accountRule]);
    if (!accountLimit.allowed) {
      return json(res, 429, { error: "登录尝试过于频繁，请稍后再试。" }, { "Retry-After": String(accountLimit.retryAfterSeconds) });
    }
    const admin = db.prepare("SELECT * FROM admin_users WHERE username = ? AND disabled = 0").get(username);
    const ok = admin && verifyPassword(password, admin.password_hash) && verifyTotp(admin.totp_secret, totp);
    if (!ok) {
      const failureLimit = rateLimiter.consume([accountRule], CONFIG.adminLoginAccountWindowMinutes * 60);
      if (!failureLimit.allowed) {
        return json(res, 429, { error: "登录尝试过于频繁，请稍后再试。" }, { "Retry-After": String(failureLimit.retryAfterSeconds) });
      }
      return json(res, 401, { error: "管理员登录失败。" });
    }
    const raw = crypto.randomBytes(32).toString("hex");
    const sid = id("ases");
    const csrf = crypto.randomBytes(24).toString("hex");
    const expires = new Date(nowMs() + 1000 * 60 * 60 * 8).toISOString();
    db.prepare("INSERT INTO admin_sessions (id, admin_user_id, session_hash, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(sid, admin.id, sha(raw), csrf, nowIso(), expires, nowIso());
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'admin_login', 'admin_session', ?, ?, ?)")
      .run(id("aud"), admin.id, sid, JSON.stringify({ ipPrefixHash: hmac(ipPrefixOf(clientIp(req))) }), nowIso());
    return json(res, 200, { loggedIn: true, csrf }, { "Set-Cookie": adminCookie(ADMIN_SESSION_COOKIE, `${sid}.${raw}`, { maxAge: 60 * 60 * 8 }) });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    db.prepare("DELETE FROM admin_sessions WHERE id = ?").run(admin.__session.id);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearCookie(ADMIN_SESSION_COOKIE, true) });
  }

  const admin = requireAdmin(req, res);
  if (!admin) return;
  const csrf = admin.__session.csrf_token;

  if (practiceService) {
    const practiceHandled = await practiceService.handleAdminApi(req, res, url, admin, csrf);
    if (practiceHandled !== false) return practiceHandled;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    const lb = buildLeaderboard();
    const stats = {
      finishedAttempts: db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status = 'finished'").get().n,
      technicalAborted: db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE status = 'technical_aborted'").get().n,
      totalIdentities: db.prepare("SELECT COUNT(*) AS n FROM identities").get().n,
      rankedIdentities: lb.total,
      averageAbilityIndex: Math.round(db.prepare("SELECT AVG(reported_ability_index) AS v FROM attempts WHERE status = 'finished' AND below_reportable_threshold = 0").get().v || 0),
      todayExposures: db.prepare("SELECT COALESCE(SUM(shown_count), 0) AS n FROM item_exposure_daily WHERE day = ?").get(new Date().toISOString().slice(0, 10)).n,
    };
    const attempts = db.prepare(`
      SELECT a.id, a.identity_id AS identityId, i.nickname AS nickname, i.excluded_from_board AS excluded,
             a.status, a.reported_ability_index AS reportedAbilityIndex, a.correct_count AS correctCount,
             a.answer_count AS answerCount, a.timeout_count AS timeoutCount, a.stop_reason AS stopReason, a.started_at AS startedAt
      FROM attempts a LEFT JOIN identities i ON i.id = a.identity_id
      ORDER BY a.started_at DESC LIMIT 100
    `).all();
    return json(res, 200, { stats, attempts, csrf });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/suspicious") {
    const clusters = adminClusterPayload();
    const appeals = db.prepare(`
      SELECT a.id, a.identity_id AS identityId, i.nickname, a.cluster_id AS clusterId, a.message, a.status, a.created_at AS createdAt
      FROM appeals a LEFT JOIN identities i ON i.id = a.identity_id
      WHERE a.status = 'open'
      ORDER BY a.created_at DESC LIMIT 100
    `).all();
    return json(res, 200, { clusters, appeals, clusterRebuild: { ...clusterRebuildStatus, queued: clusterRebuildDirty }, csrf });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/clusters/merge") {
    const body = await readJson(req);
    const identityIds = Array.isArray(body.identityIds)
      ? [...new Set(body.identityIds.map((x) => String(x || "").trim()).filter(Boolean))]
      : [];
    if (identityIds.length < 2) return json(res, 400, { error: "至少需要 2 个身份 ID。" });
    const existing = db.prepare(`SELECT id FROM identities WHERE id IN (${sqlPlaceholders(identityIds)})`).all(...identityIds).map((row) => row.id);
    if (existing.length !== identityIds.length) return json(res, 404, { error: "有身份 ID 不存在。" });
    const reason = String(body.reason || "管理员强制合并").slice(0, 300);
    for (let i = 0; i < identityIds.length; i += 1) {
      for (let j = i + 1; j < identityIds.length; j += 1) {
        db.prepare("INSERT INTO cluster_overrides (id, action, identity_a, identity_b, admin_user_id, reason, created_at) VALUES (?, 'force_merge', ?, ?, ?, ?, ?)")
          .run(id("covr"), identityIds[i], identityIds[j], admin.id, reason, nowIso());
      }
    }
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'force_merge_identities', 'cluster', ?, ?, ?)")
      .run(id("aud"), admin.id, identityIds[0], JSON.stringify({ identityIds, reason }), nowIso());
    markClusterRebuildDirty();
    setImmediate(processClusterRebuildJob);
    return json(res, 200, { ok: true, rebuildQueued: true, clusters: adminClusterPayload(), csrf });
  }

  const separateMatch = url.pathname.match(/^\/api\/admin\/clusters\/([^/]+)\/members\/([^/]+)\/separate$/);
  if (req.method === "POST" && separateMatch) {
    const [clusterId, identityId] = [separateMatch[1], separateMatch[2]];
    const body = await readJson(req);
    const members = db.prepare("SELECT identity_id AS id FROM identity_cluster_members WHERE cluster_id = ?").all(clusterId).map((row) => row.id);
    if (!members.includes(identityId)) return json(res, 404, { error: "簇成员不存在。" });
    const reason = String(body.reason || "管理员解除合并").slice(0, 300);
    for (const otherId of members) {
      if (otherId === identityId) continue;
      db.prepare("INSERT INTO cluster_overrides (id, action, identity_a, identity_b, admin_user_id, reason, created_at) VALUES (?, 'force_separate', ?, ?, ?, ?, ?)")
        .run(id("covr"), identityId, otherId, admin.id, reason, nowIso());
    }
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'force_separate_identity', 'cluster', ?, ?, ?)")
      .run(id("aud"), admin.id, clusterId, JSON.stringify({ identityId, members, reason }), nowIso());
    markClusterRebuildDirty();
    setImmediate(processClusterRebuildJob);
    return json(res, 200, { ok: true, rebuildQueued: true, clusters: adminClusterPayload(), csrf });
  }

  const appealResolveMatch = url.pathname.match(/^\/api\/admin\/appeals\/([^/]+)\/resolve$/);
  if (req.method === "POST" && appealResolveMatch) {
    const appeal = db.prepare("SELECT * FROM appeals WHERE id = ?").get(appealResolveMatch[1]);
    if (!appeal) return json(res, 404, { error: "复核请求不存在。" });
    db.prepare("UPDATE appeals SET status = 'resolved', resolved_at = ? WHERE id = ?").run(nowIso(), appeal.id);
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'resolve_appeal', 'appeal', ?, ?, ?)")
      .run(id("aud"), admin.id, appeal.id, JSON.stringify({ identityId: appeal.identity_id, clusterId: appeal.cluster_id }), nowIso());
    return json(res, 200, { ok: true, csrf });
  }

  const detailMatch = url.pathname.match(/^\/api\/admin\/attempts\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(detailMatch[1]);
    if (!attempt) return json(res, 404, { error: "记录不存在。" });
    const identity = db.prepare("SELECT * FROM identities WHERE id = ?").get(attempt.identity_id);
    const itemsRaw = db.prepare(`
      SELECT ai.*, q.id AS qid, q.a, q.b, q.p, q.rit, q.stage, q.difficulty, q.answer_index
      FROM attempt_items ai JOIN questions q ON q.id = ai.question_id
      WHERE ai.attempt_id = ? ORDER BY ai.sequence
    `).all(attempt.id);
    const respTimes = [];
    const items = itemsRaw.map((row) => {
      const opts = db.prepare("SELECT option_index, label FROM question_options WHERE question_id = ? ORDER BY option_index").all(row.qid);
      const ttr = (row.ready_at && row.assigned_at) ? (new Date(row.ready_at).getTime() - new Date(row.assigned_at).getTime()) : null;
      if (row.response_time_ms != null) respTimes.push(row.response_time_ms);
      return {
        sequence: row.sequence,
        questionId: row.qid,
        selectedIndex: row.selected_index,
        selectedLabel: row.selected_index == null ? null : opts.find((o) => o.option_index === row.selected_index)?.label,
        answerLabel: opts.find((o) => o.option_index === row.answer_index)?.label,
        responseType: row.response_type,
        correct: Boolean(row.correct),
        responseTimeMs: row.response_time_ms ?? null,
        loadStatus: row.load_status,
        assignedAt: row.assigned_at,
        readyAt: row.ready_at,
        shownAt: row.shown_at,
        answeredAt: row.answered_at,
        timeToReadyMs: (ttr != null && ttr >= 0) ? ttr : null,
        thetaBefore: Number(row.theta_before?.toFixed?.(4) ?? row.theta_before),
        thetaAfter: row.theta_after == null ? null : Number(row.theta_after.toFixed(4)),
        seBefore: Number(row.se_before?.toFixed?.(4) ?? row.se_before),
        seAfter: row.se_after == null ? null : Number(row.se_after.toFixed(4)),
        a: row.a, b: row.b, p: row.p, rit: row.rit, stage: row.stage, difficulty: row.difficulty,
      };
    });
    const wallDurationSeconds = (attempt.finished_at && attempt.started_at)
      ? Math.round((new Date(attempt.finished_at).getTime() - new Date(attempt.started_at).getTime()) / 1000) : null;
    const fp = db.prepare("SELECT * FROM fingerprints WHERE attempt_id = ? ORDER BY captured_at DESC LIMIT 1").get(attempt.id)
      || db.prepare("SELECT * FROM fingerprints WHERE identity_id = ? ORDER BY captured_at DESC LIMIT 1").get(attempt.identity_id);
    const identityCluster = identity ? enforcedClusterForIdentity(identity.id) : null;
    return json(res, 200, {
      attempt: {
        id: attempt.id,
        identityId: attempt.identity_id,
        nickname: identity ? identity.nickname : null,
        excluded: identity ? Boolean(identity.excluded_from_board) : false,
        isFirstAttempt: identity ? identity.first_attempt_id === attempt.id : false,
        status: attempt.status,
        theta: Number(attempt.theta.toFixed(4)),
        se: Number(attempt.se.toFixed(4)),
        rawAbilityIndex: attempt.raw_ability_index,
        reportedAbilityIndex: attempt.reported_ability_index,
        belowThreshold: Boolean(attempt.below_reportable_threshold),
        correctCount: attempt.correct_count,
        answerCount: attempt.answer_count,
        timeoutCount: attempt.timeout_count,
        stopReason: attempt.stop_reason,
        startedAt: attempt.started_at,
        formalStartedAt: attempt.formal_started_at,
        finishedAt: attempt.finished_at,
        activeElapsedSeconds: attempt.active_elapsed_seconds,
        wallDurationSeconds,
        avgResponseMs: respTimes.length ? Math.round(respTimes.reduce((s, x) => s + x, 0) / respTimes.length) : null,
        fastestResponseMs: respTimes.length ? Math.min(...respTimes) : null,
        slowestResponseMs: respTimes.length ? Math.max(...respTimes) : null,
      },
      identity: identity ? {
        id: identity.id,
        nickname: identity.nickname,
        usedAttempts: identity.used_attempts,
        maxAttempts: identity.max_attempts,
        createdAt: identity.created_at,
        lastSeenAt: identity.last_seen_at,
        deviceHashPrefix: identity.device_hash ? String(identity.device_hash).slice(0, 12) : null,
        linkClusterId: identityCluster ? identityCluster.id : null,
        linkClusterConfidence: identityCluster ? Math.round(identityCluster.confidence) : null,
        excludedFromBoard: Boolean(identity.excluded_from_board),
        flagged: Boolean(identity.flagged),
      } : null,
      fingerprint: fpToApi(fp),
      items,
      csrf,
    });
  }
  if (req.method === "DELETE" && detailMatch) {
    const deleted = deleteAttemptRecord(detailMatch[1], admin.id);
    if (!deleted) return json(res, 404, { error: "记录不存在。" });
    return json(res, 200, { ok: true, deleted, csrf });
  }

  const excludeMatch = url.pathname.match(/^\/api\/admin\/identities\/([^/]+)\/exclude$/);
  if (req.method === "POST" && excludeMatch) {
    const body = await readJson(req);
    const excluded = body.excluded ? 1 : 0;
    const target = db.prepare("SELECT id FROM identities WHERE id = ?").get(excludeMatch[1]);
    if (!target) return json(res, 404, { error: "身份不存在。" });
    db.prepare("UPDATE identities SET excluded_from_board = ? WHERE id = ?").run(excluded, target.id);
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id("aud"), "admin", admin.id, excluded ? "exclude_from_board" : "include_in_board", "identity", target.id, null, nowIso());
    invalidateLeaderboard();
    return json(res, 200, { ok: true, excluded: Boolean(excluded), csrf });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/identities") {
    const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
    const activity = String(url.searchParams.get("activity") || "all");
    const board = String(url.searchParams.get("board") || "all");
    const pageSize = Math.max(10, Math.min(100, Number(url.searchParams.get("pageSize")) || 25));
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const practiceRows = practiceService ? practiceService.adminIdentityIndex() : [];
    const practiceByIdentity = new Map(practiceRows.map((row) => [row.identityId, row]));
    let rows = db.prepare(`
      SELECT i.id, i.nickname, i.nickname_review_status, i.nickname_review_locked,
             i.nickname_review_failures, i.used_attempts, i.max_attempts,
             i.excluded_from_board, i.flagged, i.created_at, i.last_seen_at,
             (SELECT COUNT(*) FROM attempts a WHERE a.identity_id = i.id) AS exam_attempts,
             (SELECT COUNT(*) FROM attempts a WHERE a.identity_id = i.id AND a.status = 'finished') AS finished_exam_attempts,
             (SELECT a.started_at FROM attempts a WHERE a.identity_id = i.id ORDER BY a.started_at DESC LIMIT 1) AS latest_exam_at,
             (SELECT a.reported_ability_index FROM attempts a WHERE a.identity_id = i.id ORDER BY a.started_at DESC LIMIT 1) AS latest_ability_index
      FROM identities i
    `).all().map((row) => {
      const practice = practiceByIdentity.get(row.id) || null;
      const lastActivityAt = [row.last_seen_at, row.latest_exam_at, practice && practice.lastResponseAt, practice && practice.roundStartedAt]
        .filter(Boolean).sort().at(-1) || row.created_at;
      return {
        id: row.id,
        nickname: row.nickname,
        displayNickname: displayNickname(row.nickname, row.id),
        nicknameReviewStatus: row.nickname_review_status,
        nicknameLocked: Boolean(row.nickname_review_locked),
        nicknameReviewFailures: Number(row.nickname_review_failures || 0),
        usedAttempts: Number(row.used_attempts || 0),
        maxAttempts: Number(row.max_attempts || 0),
        excludedFromBoard: Boolean(row.excluded_from_board),
        flagged: Boolean(row.flagged),
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        lastActivityAt,
        examAttempts: Number(row.exam_attempts || 0),
        finishedExamAttempts: Number(row.finished_exam_attempts || 0),
        latestExamAt: row.latest_exam_at,
        latestAbilityIndex: row.latest_ability_index,
        practice,
      };
    });
    if (query) rows = rows.filter((row) => [row.id, row.nickname, row.displayNickname].some((value) => String(value || "").toLowerCase().includes(query)));
    if (activity === "practice") rows = rows.filter((row) => row.practice);
    if (activity === "exam") rows = rows.filter((row) => row.examAttempts > 0);
    if (activity === "none") rows = rows.filter((row) => !row.practice && row.examAttempts === 0);
    if (board === "included") rows = rows.filter((row) => !row.excludedFromBoard);
    if (board === "excluded") rows = rows.filter((row) => row.excludedFromBoard);
    rows.sort((left, right) => String(right.lastActivityAt || "").localeCompare(String(left.lastActivityAt || "")) || left.id.localeCompare(right.id));
    const total = rows.length;
    return json(res, 200, {
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      identities: rows.slice((page - 1) * pageSize, page * pageSize),
      csrf,
    });
  }

  const identityMatch = url.pathname.match(/^\/api\/admin\/identities\/([^/]+)$/);
  if (req.method === "GET" && identityMatch) {
    const identity = db.prepare("SELECT * FROM identities WHERE id = ?").get(identityMatch[1]);
    if (!identity) return json(res, 404, { error: "身份不存在。" });
    const attempts = db.prepare(`
      SELECT id, status, reported_ability_index AS reportedAbilityIndex, correct_count AS correctCount,
             answer_count AS answerCount, timeout_count AS timeoutCount, stop_reason AS stopReason,
             started_at AS startedAt, finished_at AS finishedAt
      FROM attempts WHERE identity_id = ? ORDER BY started_at
    `).all(identity.id);
    const fps = db.prepare("SELECT * FROM fingerprints WHERE identity_id = ? ORDER BY captured_at DESC LIMIT 20").all(identity.id).map(fpToApi);
    const identityCluster = enforcedClusterForIdentity(identity.id);
    return json(res, 200, {
      identity: {
        id: identity.id,
        nickname: identity.nickname,
        displayNickname: displayNickname(identity.nickname, identity.id),
        nicknameReviewStatus: identity.nickname_review_status,
        nicknameReviewLocked: Boolean(identity.nickname_review_locked),
        nicknameReviewFailures: Number(identity.nickname_review_failures || 0),
        usedAttempts: identity.used_attempts,
        maxAttempts: identity.max_attempts,
        firstAttemptId: identity.first_attempt_id,
        excludedFromBoard: Boolean(identity.excluded_from_board),
        flagged: Boolean(identity.flagged),
        sampleStatus: identity.sample_status,
        createdAt: identity.created_at,
        lastSeenAt: identity.last_seen_at,
        deviceHashPrefix: identity.device_hash ? String(identity.device_hash).slice(0, 12) : null,
        linkClusterId: identityCluster ? identityCluster.id : null,
        linkClusterConfidence: identityCluster ? Math.round(identityCluster.confidence) : null,
      },
      attempts,
      practice: practiceService ? practiceService.adminIdentityPractice(identity.id) : null,
      fingerprints: fps,
      csrf,
    });
  }

  // ---- 协助改名：管理员直接设置/清空昵称（绕过审核、锁定为管理员设定）----
  const adminNickMatch = url.pathname.match(/^\/api\/admin\/identities\/([^/]+)\/nickname$/);
  if (req.method === "POST" && adminNickMatch) {
    const target = db.prepare("SELECT * FROM identities WHERE id = ?").get(adminNickMatch[1]);
    if (!target) return json(res, 404, { error: "身份不存在。" });
    const body = await readJson(req);
    const nickname = sanitizeNickname(body.nickname);
    if (nickname && nickname.length < 2) return json(res, 400, { error: "昵称至少 2 个字符。" });
    if (nickname) {
      db.prepare("UPDATE identities SET nickname = ?, nickname_review_status = 'admin_set', nickname_review_locked = 1, nickname_review_failures = 0, nickname_reviewed_at = ?, last_seen_at = ? WHERE id = ?")
        .run(nickname, nowIso(), nowIso(), target.id);
    } else {
      db.prepare("UPDATE identities SET nickname = NULL, nickname_review_status = 'default', nickname_review_locked = 0, nickname_review_failures = 0, nickname_reviewed_at = ? WHERE id = ?")
        .run(nowIso(), target.id);
    }
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'admin_set_nickname', 'identity', ?, ?, ?)")
      .run(id("aud"), admin.id, target.id, JSON.stringify({ nickname: nickname || null }), nowIso());
    invalidateLeaderboard();
    return json(res, 200, { ok: true, nickname: nickname || null, displayNickname: displayNickname(nickname || null, target.id), csrf });
  }

  // ---- 解锁本轮改名（让用户可再次修改）----
  const adminNickUnlockMatch = url.pathname.match(/^\/api\/admin\/identities\/([^/]+)\/nickname\/unlock$/);
  if (req.method === "POST" && adminNickUnlockMatch) {
    const target = db.prepare("SELECT id FROM identities WHERE id = ?").get(adminNickUnlockMatch[1]);
    if (!target) return json(res, 404, { error: "身份不存在。" });
    db.prepare("UPDATE identities SET nickname_review_locked = 0, nickname_review_failures = 0, nickname_review_status = 'default' WHERE id = ?").run(target.id);
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'admin_unlock_nickname', 'identity', ?, ?, ?)")
      .run(id("aud"), admin.id, target.id, null, nowIso());
    return json(res, 200, { ok: true, csrf });
  }

  // ---- 重置作答次数（给一次新的考试机会）----
  const resetAttemptsMatch = url.pathname.match(/^\/api\/admin\/identities\/([^/]+)\/reset-attempts$/);
  if (req.method === "POST" && resetAttemptsMatch) {
    const target = db.prepare("SELECT id FROM identities WHERE id = ?").get(resetAttemptsMatch[1]);
    if (!target) return json(res, 404, { error: "身份不存在。" });
    db.prepare("UPDATE identities SET used_attempts = 0, active_attempt_id = NULL WHERE id = ?").run(target.id);
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'admin_reset_attempts', 'identity', ?, ?, ?)")
      .run(id("aud"), admin.id, target.id, null, nowIso());
    return json(res, 200, { ok: true, csrf });
  }

  // ---- 考试题库浏览 ----
  if (req.method === "GET" && url.pathname === "/api/admin/questions") {
    const qs = db.prepare("SELECT * FROM questions ORDER BY stage, difficulty, id").all();
    const out = qs.map((q) => {
      const opts = db.prepare("SELECT option_index, label FROM question_options WHERE question_id = ? ORDER BY option_index").all(q.id);
      return {
        id: q.id, source: q.source, stage: q.stage, difficulty: q.difficulty, a: q.a, b: q.b, n: q.n,
        active: Boolean(q.active), excluded: Boolean(q.excluded), answerIndex: q.answer_index,
        answerLabel: (opts.find((o) => o.option_index === q.answer_index) || {}).label || null,
        options: opts.map((o) => o.label), hasImage: Boolean(q.image_path),
      };
    });
    return json(res, 200, { questions: out, total: out.length, csrf });
  }
  const examImgMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/image$/);
  if ((req.method === "GET" || req.method === "HEAD") && examImgMatch) {
    const q = db.prepare("SELECT image_path FROM questions WHERE id = ?").get(examImgMatch[1]);
    if (!q || !q.image_path) return text(res, 404, "Not found");
    return serveFile(res, questionImagePath(q.image_path), "private, max-age=60", req.method === "HEAD");
  }
  const examToggleMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)\/active$/);
  if (req.method === "POST" && examToggleMatch) {
    const q = db.prepare("SELECT id FROM questions WHERE id = ?").get(examToggleMatch[1]);
    if (!q) return json(res, 404, { error: "题目不存在。" });
    const body = await readJson(req);
    const active = body.active ? 1 : 0;
    db.prepare("UPDATE questions SET active = ?, updated_at = ? WHERE id = ?").run(active, nowIso(), q.id);
    db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'admin', ?, 'admin_toggle_question', 'question', ?, ?, ?)")
      .run(id("aud"), admin.id, q.id, JSON.stringify({ active: Boolean(active) }), nowIso());
    return json(res, 200, { ok: true, active: Boolean(active), csrf });
  }

  // ---- 身份搜索（按昵称或 ID，便于协助改名/调整）----
  if (req.method === "GET" && url.pathname === "/api/admin/identity-search") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 40);
    if (!q) return json(res, 200, { results: [], csrf });
    const like = `%${q}%`;
    const rows = db.prepare("SELECT id, nickname, used_attempts, max_attempts, excluded_from_board, nickname_review_locked, last_seen_at FROM identities WHERE id LIKE ? OR nickname LIKE ? ORDER BY last_seen_at DESC LIMIT 30").all(like, like);
    return json(res, 200, { results: rows.map((r) => ({ id: r.id, nickname: r.nickname, usedAttempts: r.used_attempts, maxAttempts: r.max_attempts, excluded: Boolean(r.excluded_from_board), nicknameLocked: Boolean(r.nickname_review_locked), lastSeenAt: r.last_seen_at })), csrf });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/export/attempts.csv") {
    const rows = db.prepare(`
      SELECT a.id, a.identity_id, i.nickname, i.excluded_from_board, a.status, a.theta, a.se,
             a.raw_ability_index, a.reported_ability_index, a.correct_count, a.answer_count,
             a.timeout_count, a.below_reportable_threshold, a.stop_reason, a.started_at, a.finished_at
      FROM attempts a LEFT JOIN identities i ON i.id = a.identity_id
      ORDER BY a.started_at
    `).all();
    const header = ["id", "identity_id", "nickname", "excluded_from_board", "status", "theta", "se",
      "raw_ability_index", "reported_ability_index", "correct_count", "answer_count",
      "timeout_count", "below_reportable_threshold", "stop_reason", "started_at", "finished_at"];
    const csv = [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n");
    return text(res, 200, csv, "text/csv;charset=utf-8", {
      "Content-Disposition": `attachment; filename="attempts-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  return false;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function router(req, res) {
  try {
    // OPS-002：内部健康检查（仅 localhost，供容器 healthcheck 用，不在公开/管理域名暴露）
    if (req.method === "GET" && isLoopbackHealthRequest(req)) {
      const _p = req.url.split("?")[0];
      if (_p === "/health/live") return json(res, 200, { status: "live" });
      if (_p === "/health/ready") {
        try {
          db.prepare("SELECT 1").get();
          const ok = !practiceService || !!practiceService.getCurrentBank();
          return ok ? json(res, 200, { status: "ready" }) : json(res, 503, { status: "starting" });
        } catch (e) { return json(res, 503, { status: "unhealthy" }); }
      }
    }
    if (IS_PROD && !isKnownHost(req)) {
      return text(res, 421, "Misdirected Request", "text/plain;charset=utf-8", { "Cache-Control": "no-store" });
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const adminPath = url.pathname === "/admin"
      || url.pathname.startsWith("/admin/")
      || url.pathname === "/admin.html"
      || url.pathname === "/admin.js"
      || url.pathname.startsWith("/api/admin");
    if (IS_PROD && adminPath && !isConfiguredAdminHost(req)) {
      return text(res, 404, "Not found", "text/plain;charset=utf-8", { "Cache-Control": "no-store" });
    }
    if (IS_PROD && isConfiguredAdminHost(req) && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) && !url.pathname.startsWith("/api/admin")) {
      return json(res, 404, { error: "Not found" });
    }
    const qimgMatch = url.pathname.match(/^\/qimg\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp)$/i);
    if ((req.method === "GET" || req.method === "HEAD") && qimgMatch) {
      if (!CONFIG.examEnabled) return json(res, 403, { code: "EXAM_DISABLED", error: "考试模式暂未开放。" });
      const limited = checkRateLimit(req, "asset", CONFIG.assetRateLimitPerMinute, 60);
      if (!limited.allowed) return text(res, 429, "Too many requests", "text/plain;charset=utf-8", { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" });
      const question = questionByAssetToken(qimgMatch[1]);
      if (!question) return text(res, 404, "Not found");
      return serveFile(res, questionImagePath(question.image_path), "public, max-age=31536000, immutable", req.method === "HEAD");
    }
    const practiceTileMatch = url.pathname.match(/^\/practice-tiles\/([a-z0-9_-]+\.svg)$/i);
    if ((req.method === "GET" || req.method === "HEAD") && practiceTileMatch) {
      const limited = checkRateLimit(req, "practice_asset", CONFIG.assetRateLimitPerMinute, 60);
      if (!limited.allowed) return text(res, 429, "Too many requests", "text/plain;charset=utf-8", { "Retry-After": String(limited.retryAfterSeconds), "Cache-Control": "no-store" });
      return serveFile(res, path.join(SOURCE_ROOT, "svg-tiles", "simple_tiles", practiceTileMatch[1]), "public, max-age=31536000, immutable", req.method === "HEAD");
    }
    if (url.pathname.startsWith("/api/admin")) {
      const handled = await handleAdminApi(req, res, url);
      if (handled !== false) return;
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/assets/")) {
      if (url.pathname === "/assets/sample-question" && (req.method === "GET" || req.method === "HEAD")) {
        if (!CONFIG.examEnabled) return json(res, 403, { code: "EXAM_DISABLED", error: "考试模式暂未开放。" });
        return serveFile(res, path.join(SOURCE_ROOT, "SampleQuestion.jpg"), "public, max-age=604800", req.method === "HEAD");
      }
      if (url.pathname === "/assets/sample-solution" && (req.method === "GET" || req.method === "HEAD")) {
        if (!CONFIG.examEnabled) return json(res, 403, { code: "EXAM_DISABLED", error: "考试模式暂未开放。" });
        return serveFile(res, path.join(SOURCE_ROOT, "SampleSolution.jpg"), "public, max-age=604800", req.method === "HEAD");
      }
      const handled = await handleUserApi(req, res, url);
      if (handled !== false) return;
      return json(res, 404, { error: "Not found" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed");
    let filePath;
    const adminHost = isAdminHost(req, url.pathname);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      filePath = path.join(PUBLIC_DIR, adminHost ? "admin.html" : "portal.html");
    } else if (url.pathname === "/admin") {
      filePath = path.join(PUBLIC_DIR, "admin.html");
    } else if (url.pathname === "/practice" || url.pathname === "/practice/") {
      if (adminHost) return text(res, 404, "Not found");
      filePath = path.join(PUBLIC_DIR, "practice.html");
    } else if (url.pathname === "/exam" || url.pathname === "/exam/" || url.pathname === "/user.html") {
      if (!CONFIG.examEnabled) return text(res, 403, "考试模式暂未开放。", "text/plain;charset=utf-8", { "Cache-Control": "no-store" });
      filePath = path.join(PUBLIC_DIR, "user.html");
    } else {
      const safe = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
      filePath = path.join(PUBLIC_DIR, safe);
      if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, "Forbidden");
    }
    // Establish the soft identity on the top-level user document load, so the cookie is
    // reliably persisted (via navigation, not XHR) before any protected request. This is
    // the primary fix for first-visit "会话已失效". See REMEDIATION_PLAN.md §1.3 (F1).
    let extraHeaders = {};
    const identityPages = new Set(["portal.html", "practice.html", "user.html"]);
    if (req.method === "GET" && !adminHost && identityPages.has(path.basename(filePath)) && !getIdentity(req)) {
      const identityCreateLimit = checkRateLimit(req, "identity_create", CONFIG.identityCreateRateLimitPerHour, 60 * 60);
      if (!identityCreateLimit.allowed) {
        return json(res, 429, { error: "身份创建请求过于频繁，请稍后再试。", retryAfterSeconds: identityCreateLimit.retryAfterSeconds }, { "Retry-After": String(identityCreateLimit.retryAfterSeconds) });
      }
      mintIdentity(req, res);
      if (res.__identityCookie) extraHeaders = { "Set-Cookie": res.__identityCookie };
    }
    return serveFile(res, filePath, staticCacheFor(filePath), req.method === "HEAD", extraHeaders);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return json(res, 500, { error: "服务器错误。" });
    try { res.end(); } catch { /* noop */ }
  }
}

initSchema();
importQuestionBank();
seedAdmin();
practiceService = createPracticeService({
  db,
  sourceRoot: SOURCE_ROOT,
  id,
  nowIso,
  nowMs,
  json,
  text,
  readJson,
  requireIdentity,
  checkRateLimit,
  captureServerFingerprint,
  displayNickname,
  resetNicknameReview,
  deviceHash,
});
practiceService.init();
markClusterRebuildDirty();
processClusterRebuildJob();

const server = http.createServer((req, res) => {
  router(req, res);
});
// OPS-002：HTTP 超时，防止慢速/挂起连接长期占用事件循环与连接
server.requestTimeout = 30000;
server.headersTimeout = 25000;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => {
  console.log(`Adaptive test app listening on ${HOST}:${PORT}`);
  if (!IS_PROD) {
    console.log("Dev mode: codeless identity auto-mints on first visit.");
    console.log("Dev admin: admin / DevOnly-ChangeMe!");
  }
});

// ---------------------------------------------------------------------------
// Background sweeper — server-side enforcement of the per-question 70s timeout
// and the dynamic abandonment deadline (= last activity + remaining*70s). Without
// this, an attempt whose client stops calling stays 'active' forever (the
// "4am still active at 6pm" bug). See REMEDIATION_PLAN.md §2.
// ---------------------------------------------------------------------------

function computeLastActivityMs(attempt) {
  const agg = db.prepare("SELECT MAX(answered_at) AS la, MAX(shown_at) AS ls FROM attempt_items WHERE attempt_id = ?").get(attempt.id);
  const candidates = [attempt.started_at, attempt.last_resumed_at, attempt.last_active_tick_at, agg.la, agg.ls]
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter((n) => Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : nowMs();
}

function sweepActiveAttempts() {
  let actives;
  try {
    actives = db.prepare("SELECT id FROM attempts WHERE status = 'active'").all();
  } catch (err) {
    console.error("[sweep] query failed", err);
    return;
  }
  for (const { id: attemptId } of actives) {
    try {
      // 1) enforce single-question 70s even with no client polling
      resolveExpiredCurrentItem(attemptId);
      const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
      if (!attempt || attempt.status !== "active") continue;
      // 2) a question currently in progress (ready, not expired) -> leave it running
      const liveItem = db.prepare(`
        SELECT expires_at FROM attempt_items
        WHERE attempt_id = ? AND load_status = 'ready' AND answered_at IS NULL
        ORDER BY sequence DESC LIMIT 1
      `).get(attemptId);
      if (liveItem && liveItem.expires_at && new Date(liveItem.expires_at).getTime() > nowMs()) continue;
      // 3) between questions: finish immediately if a stop rule is already met
      const stop = shouldStop(attempt);
      if (stop) { finishAttempt(attemptId, stop, "sweeper"); continue; }
      // 4) dynamic abandonment deadline = lastActivity + remaining_questions * 70s
      const remaining = Math.max(0, CONFIG.maxItems - attempt.answer_count);
      const deadline = computeLastActivityMs(attempt) + remaining * CONFIG.questionSeconds * 1000;
      if (nowMs() > deadline) finishAttempt(attemptId, "timeout_submit", "sweeper");
    } catch (err) {
      console.error("[sweep] attempt failed", attemptId, err);
    }
  }
}

sweepActiveAttempts(); // collect existing zombie sessions on startup
setInterval(sweepActiveAttempts, CONFIG.sweepIntervalSeconds * 1000);
setInterval(pruneRateLimitBuckets, 60 * 1000);    // SEC-003：定期清理过期限流桶
setInterval(processClusterRebuildJob, 30 * 1000); // PERF-001：合并执行后台聚类重建
