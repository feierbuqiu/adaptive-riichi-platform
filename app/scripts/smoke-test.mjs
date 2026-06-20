// Release smoke test (P1 release pipeline).
//
// Verifies the externally observable security boundaries against a running origin. Works
// both locally (against a spawned server) and on the production host (against localhost
// with the real Host headers), so the same checks gate every deploy.
//
// Environment:
//   SMOKE_BASE_URL          origin to hit, e.g. http://127.0.0.1:3000 or https://test.feierbuqiu.uk
//   SMOKE_PUBLIC_HOST       Host header for the user site (default: derived from SMOKE_BASE_URL)
//   SMOKE_ADMIN_HOST        Host header for the admin site (optional; enables admin checks)
//   SMOKE_CHECK_UNKNOWN_HOST=1   also assert an unknown Host returns 421 (only valid when
//                                hitting the origin directly, e.g. on the production box)

import http from "node:http";
import https from "node:https";

const baseUrl = process.env.SMOKE_BASE_URL || process.argv[2];
if (!baseUrl) {
  console.error("Usage: SMOKE_BASE_URL=http://127.0.0.1:3000 node scripts/smoke-test.mjs");
  process.exit(2);
}
const base = new URL(baseUrl);
const publicHost = process.env.SMOKE_PUBLIC_HOST || base.host;
const adminHost = process.env.SMOKE_ADMIN_HOST || null;
const checkUnknownHost = process.env.SMOKE_CHECK_UNKNOWN_HOST === "1";

function request(pathname, { host, method = "GET" } = {}) {
  const transport = base.protocol === "https:" ? https : http;
  const options = {
    protocol: base.protocol,
    hostname: base.hostname,
    port: base.port || (base.protocol === "https:" ? 443 : 80),
    path: pathname,
    method,
    headers: { Host: host || publicHost },
    servername: base.hostname,
  };
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const checks = [
  { name: "user home 200", run: () => request("/", { host: publicHost }), expect: (r) => r.status === 200 },
  { name: "user practice 200", run: () => request("/practice", { host: publicHost }), expect: (r) => r.status === 200 },
  { name: "admin path on user host 404", run: () => request("/admin", { host: publicHost }), expect: (r) => r.status === 404 },
  { name: "user write without CSRF 403", run: () => request("/api/attempts/start", { host: publicHost, method: "POST" }), expect: (r) => r.status === 403 },
  // Tile assets must actually serve at the origin — catches a missing/mis-mounted tile
  // directory (covers a number, a sou, and an honor tile). Run against the origin (not a
  // CDN) so cache hits cannot mask a broken backend.
  { name: "tile asset 1man 200", run: () => request("/practice-tiles/1man.svg", { host: publicHost }), expect: (r) => r.status === 200 },
  { name: "tile asset 1sou 200", run: () => request("/practice-tiles/1sou.svg", { host: publicHost }), expect: (r) => r.status === 200 },
  { name: "tile asset honor (tan) 200", run: () => request("/practice-tiles/tan.svg", { host: publicHost }), expect: (r) => r.status === 200 },
];

if (adminHost) {
  checks.push(
    { name: "admin app on admin host 200", run: () => request("/admin", { host: adminHost }), expect: (r) => r.status === 200 },
    { name: "user API on admin host 404", run: () => request("/api/user/me", { host: adminHost }), expect: (r) => r.status === 404 },
    {
      name: "unauthenticated admin API not logged in",
      run: () => request("/api/admin/me", { host: adminHost }),
      expect: (r) => r.status === 200 && JSON.parse(r.body).loggedIn === false,
    },
  );
}

if (checkUnknownHost) {
  checks.push({ name: "unknown host 421", run: () => request("/", { host: "unexpected.invalid" }), expect: (r) => r.status === 421 });
}

const results = [];
let failed = 0;
for (const check of checks) {
  try {
    const response = await check.run();
    const ok = check.expect(response);
    if (!ok) failed += 1;
    results.push({ check: check.name, status: response.status, ok });
  } catch (err) {
    failed += 1;
    results.push({ check: check.name, error: err.message, ok: false });
  }
}

console.log(JSON.stringify({ baseUrl, publicHost, adminHost, checkUnknownHost, results, failed }, null, 2));
process.exit(failed === 0 ? 0 : 1);
