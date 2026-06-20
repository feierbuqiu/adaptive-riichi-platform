import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

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

async function mintIdentity(port) {
  const res = await request(port, `127.0.0.1:${port}`, "/api/user/me");
  assert.equal(res.status, 200, res.body);
  const cookie = (res.headers["set-cookie"]?.[0] || "").split(";")[0];
  assert.ok(cookie, "identity cookie must be set");
  return { cookie, csrf: JSON.parse(res.body).csrf };
}

test("user writes enforce per-identity CSRF, identity isolation, and survive oversized input", { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-security-"));
  const bankRoot = path.join(root, "practice-bank");
  fs.mkdirSync(bankRoot);
  fs.writeFileSync(path.join(bankRoot, "bank.config.json"), JSON.stringify({
    id: "test-bank", displayName: "Test Bank", sourceFile: "questions.jsonl",
    expectedUsableQuestions: 1, cohortPool: [1],
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
      IDENTITY_CREATE_RATE_LIMIT_PER_HOUR: "100",
      GLOBAL_RATE_LIMIT_PER_MINUTE: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode == null) { child.kill(); await once(child, "exit"); }
    fs.rmSync(root, { recursive: true, force: true });
  });

  let ready = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) assert.fail(`server exited during startup (${child.exitCode}): ${logs}`);
    try {
      ready = await request(port, `127.0.0.1:${port}`, "/health/ready");
      if (ready.status === 200) break;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready?.status, 200, logs);

  const a = await mintIdentity(port);
  const b = await mintIdentity(port);
  assert.notEqual(a.cookie, b.cookie, "distinct identities get distinct cookies");
  assert.notEqual(a.csrf, b.csrf, "distinct identities get distinct CSRF tokens");

  // CSRF: a write without a token is refused.
  const noToken = await request(port, `127.0.0.1:${port}`, "/api/practice/session", { method: "POST", headers: { Cookie: a.cookie }, body: {} });
  assert.equal(noToken.status, 403, noToken.body);

  // IDOR/isolation: identity A's cookie with identity B's CSRF token is refused.
  const crossToken = await request(port, `127.0.0.1:${port}`, "/api/practice/session", { method: "POST", headers: { Cookie: a.cookie, "X-CSRF-Token": b.csrf }, body: {} });
  assert.equal(crossToken.status, 403, crossToken.body);

  // The matching identity + token pair is accepted.
  const accepted = await request(port, `127.0.0.1:${port}`, "/api/practice/session", { method: "POST", headers: { Cookie: a.cookie, "X-CSRF-Token": a.csrf }, body: {} });
  assert.equal(accepted.status, 200, accepted.body);
  assert.ok(JSON.parse(accepted.body).sessionId);

  // Oversized body (> 64 KiB JSON cap) is rejected without taking the server down.
  const huge = JSON.stringify({ blob: "x".repeat(70 * 1024) });
  const oversized = await request(port, `127.0.0.1:${port}`, "/api/practice/session", { method: "POST", headers: { Cookie: a.cookie, "X-CSRF-Token": a.csrf }, body: huge });
  assert.ok(oversized.status >= 400, `oversized body should be rejected, got ${oversized.status}`);
  const stillAlive = await request(port, `127.0.0.1:${port}`, "/api/user/me", { headers: { Cookie: a.cookie } });
  assert.equal(stillAlive.status, 200, "server must remain responsive after an oversized request");

  // ENG-005: every response carries a request id.
  assert.match(stillAlive.headers["x-request-id"] || "", /^req_/);

  // OPS-005: the anonymous RUM beacon is accepted without identity/CSRF, stores valid
  // telemetry, and swallows malformed input without erroring or storing it.
  const rumOk = await request(port, `127.0.0.1:${port}`, "/api/rum", { method: "POST", body: { page: "/practice", lcpMs: 1200, cls: 0.05, navType: "navigate" } });
  assert.equal(rumOk.status, 204, rumOk.body);
  const rumJunk = await request(port, `127.0.0.1:${port}`, "/api/rum", { method: "POST", body: "not-json-object" });
  assert.equal(rumJunk.status, 204, "malformed telemetry is swallowed, not errored");
  const telemetryDb = new DatabaseSync(path.join(root, "app.sqlite"), { readOnly: true });
  const rumCount = telemetryDb.prepare("SELECT COUNT(*) AS n FROM rum_events").get().n;
  telemetryDb.close();
  assert.equal(rumCount, 1, "exactly the one valid beacon was stored");
});
