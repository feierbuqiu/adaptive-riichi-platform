import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { newRequestId, routeTemplate, accessLog } = require("../src/logging.js");

test("route template collapses high-cardinality segments", () => {
  assert.equal(routeTemplate("/practice-tiles/tan.svg"), "/practice-tiles/:tile");
  assert.equal(routeTemplate("/practice-tiles/1man.svg?v=vb1"), "/practice-tiles/:tile");
  assert.equal(routeTemplate("/api/practice/session/pses_abcdef123456/ping"), "/api/practice/session/:id/ping");
  assert.equal(routeTemplate(`/qimg/${"a".repeat(32)}.jpg`), "/qimg/:token");
  assert.equal(routeTemplate("/api/admin/practice/responses"), "/api/admin/practice/responses");
  assert.equal(routeTemplate("/api/user/me"), "/api/user/me");
});

test("access log redacts sensitive keys and emits one JSON line", () => {
  let out = "";
  accessLog({ id: "req_1", route: "/x", status: 200, cookie: "abc", csrf: "t", authorization: "Bearer z" }, (line) => { out += line; });
  assert.match(out, /\n$/);
  const parsed = JSON.parse(out);
  assert.equal(parsed.t, "access");
  assert.equal(parsed.id, "req_1");
  assert.equal(parsed.status, 200);
  assert.equal(parsed.cookie, undefined);
  assert.equal(parsed.csrf, undefined);
  assert.equal(parsed.authorization, undefined);
});

test("request ids are unique and prefixed", () => {
  assert.match(newRequestId(), /^req_[0-9a-f]{18}$/);
  assert.notEqual(newRequestId(), newRequestId());
});

test("access log never throws on a failing writer", () => {
  assert.doesNotThrow(() => accessLog({ id: "x" }, () => { throw new Error("stdout gone"); }));
});
