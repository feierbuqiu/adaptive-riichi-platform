// Centralized runtime configuration (ENG-002, first extraction from server.js).
//
// Reads and validates environment-driven settings in one place. Pure with respect to the
// process environment — no database, filesystem, or network access — so it can be required
// by any module without side effects beyond the production secret check below.

const IS_PROD = process.env.NODE_ENV === "production";

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
  // Admin passkey (WebAuthn). rpId must be a registrable suffix of every admin origin.
  webauthnRpId: process.env.WEBAUTHN_RP_ID || envList("ADMIN_HOSTNAMES", "admin.localhost")[0] || "localhost",
  webauthnRpName: process.env.WEBAUTHN_RP_NAME || "Adaptive Riichi Admin",
  webauthnOrigins: process.env.WEBAUTHN_ORIGINS
    ? envList("WEBAUTHN_ORIGINS", "")
    : envList("ADMIN_HOSTNAMES", "admin.localhost").map((h) => `${IS_PROD ? "https" : "http"}://${h}`),
  adminSessionDays: Number(process.env.ADMIN_SESSION_DAYS) || 60,
  adminRecoveryCodeCount: Number(process.env.ADMIN_RECOVERY_CODE_COUNT) || 10,
};

const SECRET = process.env.SESSION_SECRET || (IS_PROD ? "" : "dev-session-secret-change-me");

if (IS_PROD && !SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

module.exports = { IS_PROD, CONFIG, SECRET, envList };
