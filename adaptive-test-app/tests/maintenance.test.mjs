import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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

function request(port, host, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
  });
}

test("server enforces private health routes and anonymous identity creation limits", { timeout: 20000 }, async (t) => {
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
});
