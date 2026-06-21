import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { errorBody, cookie, adminCookie, clearCookie } = require("../src/http.js");

test("error envelope carries error, code, and requestId, and allows extra fields", () => {
  assert.deepEqual(
    errorBody({ id: "req_abc" }, "UNAUTHENTICATED", "会话已失效"),
    { error: "会话已失效", code: "UNAUTHENTICATED", requestId: "req_abc" },
  );
  const withExtra = errorBody({ id: "req_x" }, "RATE_LIMITED", "慢一点", { retryAfterSeconds: 5 });
  assert.equal(withExtra.retryAfterSeconds, 5);
  assert.equal(errorBody(null, "C", "m").requestId, undefined);
});

test("cookie helpers set HttpOnly, SameSite, and Secure on request", () => {
  assert.match(cookie("identity", "v", { secure: true, maxAge: 60 }), /^identity=v; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=60$/);
  assert.match(adminCookie("s", "v", { secure: true }), /; HttpOnly; SameSite=Strict; Secure$/);
  assert.match(clearCookie("x", true), /^x=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
});
