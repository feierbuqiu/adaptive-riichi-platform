import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  FixedWindowRateLimiter,
  clusterCandidatePairs,
  csvCell,
  hostNameFromHeader,
  isLoopbackHealthRequest,
} = require("../src/maintenance.js");

test("CSV cells neutralize spreadsheet formulas and preserve quoting", () => {
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(csvCell(`${prefix}SUM(A1:A2)`), `"'${prefix}SUM(A1:A2)"`);
  }
  assert.equal(csvCell('normal "name"'), '"normal ""name"""');
  assert.equal(csvCell(null), '""');
});

test("fixed-window limiter enforces every supplied layer atomically", () => {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter({ maxKeys: 10, now: () => now });
  const rules = [
    { key: "global", limit: 100, layer: "global" },
    { key: "scope:login", limit: 20, layer: "endpoint" },
    { key: "ip:login:192.0.2.1", limit: 2, layer: "ip" },
    { key: "identity:login:idn_1", limit: 3, layer: "identity" },
  ];
  assert.equal(limiter.consume(rules, 60).allowed, true);
  assert.equal(limiter.consume(rules, 60).allowed, true);
  assert.deepEqual(limiter.consume(rules, 60), { allowed: false, retryAfterSeconds: 60, limitedBy: "ip" });
  assert.equal(limiter.size, 4);
  now += 60000;
  assert.equal(limiter.prune(), 0);
  assert.equal(limiter.consume(rules, 60).allowed, true);
});

test("fixed-window limiter rejects new state when its hard capacity is full", () => {
  const limiter = new FixedWindowRateLimiter({ maxKeys: 1, now: () => 0 });
  assert.equal(limiter.consume([{ key: "one", limit: 1 }], 60).allowed, true);
  assert.deepEqual(limiter.consume([{ key: "two", limit: 1 }], 60), {
    allowed: false,
    retryAfterSeconds: 60,
    limitedBy: "capacity",
  });
});

test("fixed-window limiter can reject blocked subjects without incrementing them", () => {
  const limiter = new FixedWindowRateLimiter({ maxKeys: 10, now: () => 0 });
  const rule = { key: "subject:admin:hashed", limit: 2, layer: "account" };
  assert.equal(limiter.check([rule]).allowed, true);
  assert.equal(limiter.consume([rule], 900).allowed, true);
  assert.equal(limiter.consume([rule], 900).allowed, true);
  assert.deepEqual(limiter.check([rule]), { allowed: false, retryAfterSeconds: 900, limitedBy: "account" });
  assert.equal(limiter.size, 1);
});

test("cluster candidates use indexed signals instead of a full Cartesian scan", () => {
  const unrelated = Array.from({ length: 10000 }, (_, index) => ({
    id: `idn_${index}`,
    deviceHash: `device_${index}`,
    ipPrefixHash: `ip_${index}`,
    uaBrowser: "chrome",
    uaOs: "windows",
  }));
  const large = clusterCandidatePairs(unrelated, [], 100000);
  assert.equal(large.truncated, false);
  assert.equal(large.count, 0);

  const related = clusterCandidatePairs([
    { id: "a", webglKey: "gpu", webglRenderer: "renderer" },
    { id: "b", webglKey: "gpu", webglRenderer: "renderer" },
    { id: "c", deviceHash: "other" },
  ], ["a|c"], 10);
  assert.deepEqual(related.pairs, [["a", "b"], ["a", "c"]]);
});

test("candidate pair bound fails closed before replacing existing clusters", () => {
  const sameDevice = Array.from({ length: 20 }, (_, index) => ({ id: `idn_${index}`, deviceHash: "shared" }));
  const result = clusterCandidatePairs(sameDevice, [], 10);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.pairs, []);
});

test("health endpoints require an exact loopback Host and loopback peer", () => {
  assert.equal(hostNameFromHeader("[::1]:3000"), "::1");
  assert.equal(isLoopbackHealthRequest({ headers: { host: "127.0.0.1:3000" }, socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopbackHealthRequest({ headers: { host: "localhost.evil" }, socket: { remoteAddress: "127.0.0.1" } }), false);
  assert.equal(isLoopbackHealthRequest({ headers: { host: "127.0.0.1:3000" }, socket: { remoteAddress: "172.18.0.2" } }), false);
});

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function request(port, host, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body == null
      ? null
      : (typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    const headers = { Host: host, ...(options.headers || {}) };
    if (body != null) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: options.method || "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function totp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/g, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}

test("server enforces health, host, admin-auth, CSRF, and abuse boundaries", { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-maintenance-"));
  const bankRoot = path.join(root, "practice-bank");
  fs.mkdirSync(bankRoot);
  fs.writeFileSync(path.join(bankRoot, "bank.config.json"), JSON.stringify({
    id: "test-bank",
    displayName: "Test Bank",
    sourceFile: "questions.jsonl",
    expectedUsableQuestions: 1,
    cohortPool: [1],
  }));
  fs.writeFileSync(path.join(bankRoot, "questions.jsonl"), `${JSON.stringify({
    id: 1,
    annotation: { scene: {}, dora_indicators: "1m", hand: "123456789m123p1z", draw: "1z", melds: [] },
    answer: { answer_action: "discard", answer_tile: "1z", public_practice_eligible: true, is_disputed: false },
  })}\n`);
  const port = await reservePort();
  const child = spawn(process.execPath, [path.resolve("src/server.js")], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      SOURCE_ROOT: root,
      PRACTICE_BANK_ROOT: bankRoot,
      DB_PATH: path.join(root, "app.sqlite"),
      PUBLIC_HOSTNAMES: "127.0.0.1",
      ADMIN_HOSTNAMES: "admin.localhost",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: "test-admin-password",
      ADMIN_TOTP_SECRET: "JBSWY3DPEHPK3PXP",
      ADMIN_LOGIN_ACCOUNT_FAILURE_LIMIT: "2",
      IDENTITY_CREATE_RATE_LIMIT_PER_HOUR: "1",
      GLOBAL_RATE_LIMIT_PER_MINUTE: "10000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill();
      await once(child, "exit");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let healthy = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) assert.fail(`server exited during startup (${child.exitCode}): ${logs}`);
    try {
      healthy = await request(port, `127.0.0.1:${port}`, "/health/ready");
      if (healthy.status === 200) break;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(healthy?.status, 200, logs);
  assert.equal(JSON.parse(healthy.body).status, "ready");

  const fakeLocalHost = await request(port, "localhost.evil", "/health/ready");
  assert.equal(fakeLocalHost.status, 421);

  const firstIdentity = await request(port, `127.0.0.1:${port}`, "/api/user/me");
  assert.equal(firstIdentity.status, 200, firstIdentity.body);
  assert.ok(firstIdentity.headers["set-cookie"]);
  const secondIdentity = await request(port, `127.0.0.1:${port}`, "/api/user/me");
  assert.equal(secondIdentity.status, 429, secondIdentity.body);
  assert.match(secondIdentity.body, /身份创建请求过于频繁/);

  assert.equal((await request(port, `127.0.0.1:${port}`, "/admin")).status, 404);
  assert.equal((await request(port, "admin.localhost", "/api/user/me")).status, 404);
  assert.equal((await request(port, `127.0.0.1:${port}`, "/api/attempts/start", { method: "POST" })).status, 403);
  const adminMe = await request(port, "admin.localhost", "/api/admin/me");
  assert.equal(adminMe.status, 200);
  assert.equal(JSON.parse(adminMe.body).loggedIn, false);

  const invalidBody = { username: "missing-admin", password: "wrong", totp: "000000" };
  const firstInvalid = await request(port, "admin.localhost", "/api/admin/login", {
    method: "POST", body: invalidBody, headers: { "CF-Connecting-IP": "198.51.100.1" },
  });
  assert.equal(firstInvalid.status, 401);
  assert.equal((await request(port, "admin.localhost", "/api/admin/login", {
    method: "POST", body: invalidBody, headers: { "CF-Connecting-IP": "198.51.100.2" },
  })).status, 401);
  const blockedLogin = await request(port, "admin.localhost", "/api/admin/login", {
    method: "POST", body: invalidBody, headers: { "CF-Connecting-IP": "198.51.100.3" },
  });
  assert.equal(blockedLogin.status, 429);
  assert.ok(Number(blockedLogin.headers["retry-after"]) > 0);

  const wrongExistingAdmin = await request(port, "admin.localhost", "/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "wrong", totp: "000000" },
    headers: { "CF-Connecting-IP": "198.51.100.4" },
  });
  assert.equal(wrongExistingAdmin.status, 401);
  assert.equal(wrongExistingAdmin.body, firstInvalid.body);

  const login = await request(port, "admin.localhost", "/api/admin/login", {
    method: "POST",
    body: { username: "admin", password: "test-admin-password", totp: totp("JBSWY3DPEHPK3PXP") },
  });
  assert.equal(login.status, 200, login.body);
  const loginBody = JSON.parse(login.body);
  const setCookie = login.headers["set-cookie"]?.[0] || "";
  assert.match(setCookie, /^__Host-admin_session=/);
  assert.match(setCookie, /; Path=\//);
  assert.match(setCookie, /; HttpOnly/);
  assert.match(setCookie, /; SameSite=Strict/);
  assert.match(setCookie, /; Secure/);
  assert.doesNotMatch(setCookie, /; Domain=/i);
  const sessionCookie = setCookie.split(";")[0];
  const auditDb = new DatabaseSync(path.join(root, "app.sqlite"), { readOnly: true });
  const loginAudit = auditDb.prepare("SELECT actor_type, action, target_type FROM audit_logs WHERE action = 'admin_login' ORDER BY created_at DESC LIMIT 1").get();
  auditDb.close();
  assert.deepEqual({ ...loginAudit }, { actor_type: "admin", action: "admin_login", target_type: "admin_session" });

  const rejectedLogout = await request(port, "admin.localhost", "/api/admin/logout", {
    method: "POST",
    headers: { Cookie: sessionCookie },
  });
  assert.equal(rejectedLogout.status, 403);
  const logout = await request(port, "admin.localhost", "/api/admin/logout", {
    method: "POST",
    headers: { Cookie: sessionCookie, "X-CSRF-Token": loginBody.csrf },
  });
  assert.equal(logout.status, 200, logout.body);
  assert.match(logout.headers["set-cookie"]?.[0] || "", /^__Host-admin_session=/);
});
