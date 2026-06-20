import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const {
  answersEqual, baseKind, createPracticeService, normalizeBankConfig,
  normalizeResponse, parseMpsz, shuffle, timingPayload,
} = require("../src/practice.js");

test("MPSZ parsing preserves red fives and duplicate positions", () => {
  assert.deepEqual(parseMpsz("405m550s77z"), ["4m", "0m", "5m", "5s", "5s", "0s", "7z", "7z"]);
  assert.equal(baseKind("0s"), "5s");
  assert.equal(baseKind("5s"), "5s");
});

test("duplicate positions are equivalent while red and normal fives are not", () => {
  const render = { hand: "55s123m123p123s11z", draw: "0s", melds: [] };
  assert.deepEqual(normalizeResponse({ action: "discard", tile: "5s", riichi: false }, render), { action: "discard", tile: "5s", riichi: false });
  assert.deepEqual(normalizeResponse({ action: "discard", tile: "0s", riichi: false }, render), { action: "discard", tile: "0s", riichi: false });
  assert.equal(answersEqual({ action: "discard", tile: "5s", riichi: false }, { action: "discard", tile: "0s", riichi: false }), false);
  assert.equal(answersEqual({ action: "discard", tile: "5s", riichi: false }, { action: "discard", tile: "5s", riichi: false }), true);
});

test("riichi, damaten, ankan and discard remain different semantic answers", () => {
  assert.equal(answersEqual({ action: "discard", tile: "4p", riichi: true }, { action: "discard", tile: "4p", riichi: false }), false);
  assert.equal(answersEqual({ action: "ankan", tile: "1s", riichi: false }, { action: "discard", tile: "1s", riichi: false }), false);
  const render = { hand: "555s123m123p11z", draw: "0s", melds: [] };
  assert.deepEqual(normalizeResponse({ action: "ankan", tile: "0s" }, render), { action: "ankan", tile: "5s", riichi: false });
});

test("bank config requires a bounded unique cohort", () => {
  const config = normalizeBankConfig({
    id: "test-bank",
    displayName: "Test Bank",
    sourceFile: "questions.enriched.jsonl",
    expectedUsableQuestions: 25,
    cohortPool: Array.from({ length: 20 }, (_, index) => index + 1),
  });
  assert.equal(config.cohortPool.length, 20);
  assert.throws(() => normalizeBankConfig({ ...config, cohortPool: [1, 1] }), /unique positive/);
});

test("shuffle returns a permutation without mutating input", () => {
  const input = [1, 2, 3, 4, 5];
  const output = shuffle(input, () => 0);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...output].sort((a, b) => a - b), input);
});

test("timing payload clamps and preserves multiple cleaning metrics", () => {
  const timing = timingPayload({ visibleTimeMs: 1000, focusedTimeMs: 900, activeThinkingTimeMs: 800, hiddenCount: 2, interactionCount: 3, activitySegments: [{ event: "shown" }] });
  assert.equal(timing.visibleTimeMs, 1000);
  assert.equal(timing.focusedTimeMs, 900);
  assert.equal(timing.activeThinkingTimeMs, 800);
  assert.equal(timing.hiddenCount, 2);
  assert.equal(timing.interactionCount, 3);
  assert.equal(timing.activitySegments.length, 1);
});

test("configured bank imports its eligible questions and hidden cohort", () => {
  const bankRoot = fs.mkdtempSync(path.join(os.tmpdir(), "practice-bank-"));
  const cohortPool = Array.from({ length: 20 }, (_, index) => index + 1);
  const records = Array.from({ length: 25 }, (_, index) => ({
    id: index + 1,
    annotation: { scene: {}, dora_indicators: "1m", hand: "123456789m123p1z", draw: "1z", melds: [] },
    answer: { answer_action: "discard", answer_tile: "1z", public_practice_eligible: true, is_disputed: false },
  }));
  fs.writeFileSync(path.join(bankRoot, "bank.config.json"), JSON.stringify({
    id: "test-bank",
    displayName: "Test Bank",
    sourceFile: "questions.enriched.jsonl",
    expectedUsableQuestions: records.length,
    cohortPool,
  }));
  fs.writeFileSync(path.join(bankRoot, "questions.enriched.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const dbPath = path.join(os.tmpdir(), `practice-import-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE identities (id TEXT PRIMARY KEY, nickname TEXT, excluded_from_board INTEGER NOT NULL DEFAULT 0)");
  let serial = 0;
  const service = createPracticeService({
    db,
    sourceRoot: bankRoot,
    practiceBankRoot: bankRoot,
    id: (prefix) => `${prefix}_${++serial}`,
    nowIso: () => "2026-06-19T00:00:00.000Z",
    nowMs: () => Date.now(),
    json: () => {}, text: () => {}, readJson: async () => ({}), requireIdentity: () => null,
    checkRateLimit: () => ({ allowed: true }), captureServerFingerprint: () => null,
    displayNickname: (_nickname, identityId) => identityId || "test", resetNicknameReview: () => {}, deviceHash: () => "test",
  });
  const bank = service.init();
  assert.equal(bank.questionCount, records.length);
  const imported = db.prepare("SELECT source_number FROM practice_questions ORDER BY source_number").all().map((row) => Number(row.source_number));
  assert.equal(imported.length, records.length);
  for (const number of cohortPool) assert.ok(imported.includes(number));
  const questions = db.prepare("SELECT * FROM practice_questions ORDER BY source_number").all();
  for (const question of questions) {
    const answer = { action: question.answer_action, tile: question.answer_tile, riichi: Boolean(question.answer_riichi) };
    assert.doesNotThrow(() => normalizeResponse(answer, JSON.parse(question.render_json)), `invalid answer for question ${question.source_number}`);
  }
  db.prepare("INSERT INTO identities (id, nickname) VALUES ('a', NULL), ('b', NULL), ('c', NULL)").run();
  const insertRound = db.prepare(`
    INSERT INTO practice_rounds
      (id, identity_id, bank_id, bank_version, round_number, status, analysis_eligible, total_questions, order_json, started_at)
    VALUES (?, ?, ?, ?, 1, 'active', 1, 25, '[]', '2026-06-19T00:00:00Z')
  `);
  for (const identity of ["a", "b", "c"]) insertRound.run(`round-${identity}`, identity, bank.id, bank.version);
  const insertResponse = db.prepare(`
    INSERT INTO practice_responses
      (id, assignment_id, identity_id, round_id, bank_id, bank_version, source_number, sequence,
       selected_action, selected_tile, selected_riichi, correct, analysis_eligible,
       assigned_at, submitted_at, server_wall_time_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discard', '1m', 0, ?, 1, ?, ?, 1000, ?)
  `);
  for (const identity of ["a", "b", "c"]) {
    const count = identity === "c" ? 19 : 20;
    for (let index = 0; index < count; index += 1) {
      const key = `${identity}-${index}`;
      insertResponse.run(`r-${key}`, `a-${key}`, identity, `round-${identity}`, bank.id, bank.version, imported[index], index + 1, 1, "2026-06-19T00:00:00Z", "2026-06-19T00:00:01Z", "2026-06-19T00:00:01Z");
    }
  }
  const ranking = service.publicRanking("a", 10);
  assert.equal(ranking.you.accuracyRankEligible, true);
  assert.equal(ranking.you.accuracyRank, 1);
  assert.equal(ranking.accuracyTop.length, 2);
  assert.deepEqual(ranking.accuracyTop.map((row) => row.rank), [1, 1]);
  assert.equal(ranking.countTop.some((row) => row.nickname === "c"), false);
  const adminUsers = service.adminIdentityIndex();
  assert.equal(adminUsers.length, 3);
  assert.equal(adminUsers.find((row) => row.identityId === "a").answered, 20);
  const adminDetail = service.adminIdentityPractice("a");
  assert.equal(adminDetail.rounds.length, 1);
  assert.equal(adminDetail.summary.accuracy, 100);
  const responsePage = service.adminPracticeResponses("a", { page: 1, pageSize: 10 });
  assert.equal(responsePage.total, 20);
  assert.equal(responsePage.responses.length, 10);
  db.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(bankRoot, { recursive: true, force: true });
});
