const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MIN_ACCURACY_RANK_ANSWERS = 20;
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;

function normalizeBankConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("practice bank config must be an object");
  const id = String(input.id || "").trim();
  const displayName = String(input.displayName || "").trim();
  const sourceFile = String(input.sourceFile || "questions.enriched.jsonl").trim();
  const expectedUsableQuestions = Number(input.expectedUsableQuestions);
  const cohortPool = Array.isArray(input.cohortPool)
    ? input.cohortPool.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    : [];
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error("practice bank config has an invalid id");
  if (!displayName || displayName.length > 100) throw new Error("practice bank config has an invalid displayName");
  if (path.basename(sourceFile) !== sourceFile || !sourceFile.endsWith(".jsonl")) throw new Error("practice bank config has an invalid sourceFile");
  if (!Number.isInteger(expectedUsableQuestions) || expectedUsableQuestions < 1) throw new Error("practice bank config has an invalid expectedUsableQuestions");
  if (!cohortPool.length || new Set(cohortPool).size !== cohortPool.length) throw new Error("practice bank config cohortPool must contain unique positive question numbers");
  if (cohortPool.length > expectedUsableQuestions) throw new Error("practice bank config cohortPool exceeds the usable question count");
  return Object.freeze({ id, displayName, sourceFile, expectedUsableQuestions, cohortPool: Object.freeze(cohortPool) });
}

function parseMpsz(value) {
  const out = [];
  for (const match of String(value || "").matchAll(/([0-9]+)([mpsz])/g)) {
    for (const digit of match[1]) out.push(`${digit}${match[2]}`);
  }
  return out;
}

function baseKind(code) {
  const value = String(code || "");
  if (!/^[0-9][mpsz]$/.test(value)) return null;
  return `${value[0] === "0" ? "5" : value[0]}${value[1]}`;
}

function validTileCode(code) {
  const value = String(code || "");
  if (!/^[0-9][mpsz]$/.test(value)) return false;
  const n = Number(value[0]);
  if (value[1] === "z") return n >= 1 && n <= 7;
  return n >= 0 && n <= 9;
}

function shuffle(items, randomInt = crypto.randomInt) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function tileIndex(code) {
  let n = Number(code[0]);
  if (n === 0) n = 5;
  return ({ m: 0, p: 9, s: 18, z: 27 })[code[1]] + n - 1;
}

function canFormMelds(counts) {
  let i = 0;
  while (i < 34 && counts[i] === 0) i += 1;
  if (i === 34) return true;
  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canFormMelds(counts)) { counts[i] += 3; return true; }
    counts[i] += 3;
  }
  if (i < 27 && i % 9 <= 6 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i] -= 1; counts[i + 1] -= 1; counts[i + 2] -= 1;
    if (canFormMelds(counts)) { counts[i] += 1; counts[i + 1] += 1; counts[i + 2] += 1; return true; }
    counts[i] += 1; counts[i + 1] += 1; counts[i + 2] += 1;
  }
  return false;
}

function isWinningHand(counts) {
  for (let i = 0; i < 34; i += 1) {
    if (counts[i] >= 2) {
      counts[i] -= 2;
      const ok = canFormMelds(counts);
      counts[i] += 2;
      if (ok) return true;
    }
  }
  let pairs = 0;
  let types = 0;
  for (const count of counts) {
    if (count > 0) { types += 1; if (count === 2) pairs += 1; }
  }
  if (types === 7 && pairs === 7) return true;
  const terminals = new Set([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]);
  let all = true;
  let pair = false;
  for (let i = 0; i < 34; i += 1) {
    if (counts[i] > 0 && !terminals.has(i)) return false;
  }
  for (const index of terminals) {
    if (counts[index] === 0) all = false;
    if (counts[index] >= 2) pair = true;
  }
  return all && pair;
}

function isTenpai(codes) {
  const counts = new Array(34).fill(0);
  for (const code of codes) counts[tileIndex(code)] += 1;
  for (let i = 0; i < 34; i += 1) {
    if (counts[i] >= 4) continue;
    counts[i] += 1;
    const ok = isWinningHand(counts);
    counts[i] -= 1;
    if (ok) return true;
  }
  return false;
}

function responseKey(response) {
  return `${response.action}|${response.tile}|${response.riichi ? 1 : 0}`;
}

function answersEqual(left, right) {
  return responseKey(left) === responseKey(right);
}

function normalizeResponse(raw, render) {
  const action = raw && raw.action === "ankan" ? "ankan" : "discard";
  let tile = String(raw && raw.tile || "").trim();
  const riichi = action === "discard" && Boolean(raw && raw.riichi);
  if (!validTileCode(tile)) throw new Error("请选择有效的牌。");
  const all = [...parseMpsz(render.hand), ...parseMpsz(render.draw)];
  if (action === "discard") {
    if (!all.includes(tile)) throw new Error("所选牌不在当前手牌中。");
    if (riichi) {
      if ((render.melds || []).length) throw new Error("有副露时不能立直。");
      const index = all.indexOf(tile);
      if (index < 0 || !isTenpai(all.slice(0, index).concat(all.slice(index + 1)))) {
        throw new Error("该切牌不能形成有效立直。");
      }
    }
    return { action, tile, riichi };
  }
  tile = baseKind(tile);
  const count = all.filter((code) => baseKind(code) === tile).length;
  if (count < 4) throw new Error("当前手牌不能执行该暗杠。");
  return { action, tile, riichi: false };
}

function number(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function timingPayload(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    readyAt: input.readyAt ? String(input.readyAt).slice(0, 40) : null,
    firstShownAt: input.firstShownAt ? String(input.firstShownAt).slice(0, 40) : null,
    firstInteractionAt: input.firstInteractionAt ? String(input.firstInteractionAt).slice(0, 40) : null,
    visibleTimeMs: number(input.visibleTimeMs, 0, 365 * 24 * 60 * 60 * 1000),
    focusedTimeMs: number(input.focusedTimeMs, 0, 365 * 24 * 60 * 60 * 1000),
    activeThinkingTimeMs: number(input.activeThinkingTimeMs, 0, 365 * 24 * 60 * 60 * 1000),
    clientElapsedMs: number(input.clientElapsedMs, 0, 365 * 24 * 60 * 60 * 1000),
    readyToSubmitMs: number(input.readyToSubmitMs, 0, 365 * 24 * 60 * 60 * 1000),
    loadTimeMs: number(input.loadTimeMs, 0, 24 * 60 * 60 * 1000),
    hiddenCount: number(input.hiddenCount, 0, 100000),
    blurCount: number(input.blurCount, 0, 100000),
    resumeCount: number(input.resumeCount, 0, 100000),
    interactionCount: number(input.interactionCount, 0, 100000),
    activitySegments: Array.isArray(input.activitySegments) ? input.activitySegments.slice(0, 1000) : [],
  };
}

function csvText(rows, headers) {
  const escape = (value) => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
}

function createPracticeService(options) {
  const {
    db, sourceRoot, id, nowIso, nowMs, json, text, readJson, requireIdentity,
    checkRateLimit, captureServerFingerprint, displayNickname, resetNicknameReview,
    deviceHash, practiceBankRoot,
  } = options;
  let currentBank = null;
  let cohortPool = Object.freeze([]);

  function initSchema() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS practice_banks (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        display_name TEXT NOT NULL,
        question_count INTEGER NOT NULL,
        source_sha256 TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS practice_questions (
        bank_id TEXT NOT NULL,
        bank_version TEXT NOT NULL,
        source_number INTEGER NOT NULL,
        render_json TEXT NOT NULL,
        answer_action TEXT NOT NULL,
        answer_tile TEXT NOT NULL,
        answer_riichi INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (bank_id, bank_version, source_number)
      );
      CREATE TABLE IF NOT EXISTS practice_rounds (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        bank_version TEXT NOT NULL,
        round_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        analysis_eligible INTEGER NOT NULL,
        total_questions INTEGER NOT NULL,
        order_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (identity_id, bank_id, bank_version, round_number)
      );
      CREATE TABLE IF NOT EXISTS practice_assignments (
        id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL,
        source_number INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        cohort_seed_item INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'assigned',
        assigned_at TEXT NOT NULL,
        ready_at TEXT,
        first_shown_at TEXT,
        answered_at TEXT,
        advanced_at TEXT,
        UNIQUE (round_id, source_number),
        UNIQUE (round_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS practice_responses (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL UNIQUE,
        identity_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        bank_version TEXT NOT NULL,
        source_number INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        selected_action TEXT NOT NULL,
        selected_tile TEXT NOT NULL,
        selected_riichi INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        analysis_eligible INTEGER NOT NULL,
        client_submission_id TEXT,
        session_id TEXT,
        fingerprint_id TEXT,
        assigned_at TEXT NOT NULL,
        ready_at TEXT,
        first_shown_at TEXT,
        first_interaction_at TEXT,
        submitted_at TEXT NOT NULL,
        server_wall_time_ms INTEGER NOT NULL,
        server_ready_to_submit_ms INTEGER,
        client_elapsed_time_ms INTEGER NOT NULL DEFAULT 0,
        client_ready_to_submit_ms INTEGER NOT NULL DEFAULT 0,
        client_visible_time_ms INTEGER NOT NULL DEFAULT 0,
        client_focused_time_ms INTEGER NOT NULL DEFAULT 0,
        client_active_thinking_time_ms INTEGER NOT NULL DEFAULT 0,
        client_load_time_ms INTEGER NOT NULL DEFAULT 0,
        hidden_count INTEGER NOT NULL DEFAULT 0,
        blur_count INTEGER NOT NULL DEFAULT 0,
        resume_count INTEGER NOT NULL DEFAULT 0,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        timing_json TEXT,
        device_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS practice_sessions (
        id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        round_id TEXT,
        bank_id TEXT NOT NULL,
        bank_version TEXT NOT NULL,
        fingerprint_id TEXT,
        device_hash TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT,
        client_json TEXT
      );
      CREATE TABLE IF NOT EXISTS practice_activity (
        assignment_id TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        session_id TEXT,
        ready_at TEXT,
        first_shown_at TEXT,
        first_interaction_at TEXT,
        visible_time_ms INTEGER NOT NULL DEFAULT 0,
        focused_time_ms INTEGER NOT NULL DEFAULT 0,
        active_thinking_time_ms INTEGER NOT NULL DEFAULT 0,
        load_time_ms INTEGER NOT NULL DEFAULT 0,
        hidden_count INTEGER NOT NULL DEFAULT 0,
        blur_count INTEGER NOT NULL DEFAULT 0,
        resume_count INTEGER NOT NULL DEFAULT 0,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        timing_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_practice_rounds_identity ON practice_rounds(identity_id, bank_id, bank_version, round_number);
      CREATE INDEX IF NOT EXISTS idx_practice_assignments_round ON practice_assignments(round_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_practice_responses_identity ON practice_responses(identity_id, bank_id, bank_version);
      CREATE INDEX IF NOT EXISTS idx_practice_responses_bank ON practice_responses(bank_id, bank_version, source_number);
      CREATE INDEX IF NOT EXISTS idx_practice_sessions_identity ON practice_sessions(identity_id, started_at);
    `);
    const responseColumns = new Set(db.prepare("PRAGMA table_info(practice_responses)").all().map((column) => column.name));
    if (!responseColumns.has("server_ready_to_submit_ms")) db.exec("ALTER TABLE practice_responses ADD COLUMN server_ready_to_submit_ms INTEGER");
    if (!responseColumns.has("client_elapsed_time_ms")) db.exec("ALTER TABLE practice_responses ADD COLUMN client_elapsed_time_ms INTEGER NOT NULL DEFAULT 0");
    if (!responseColumns.has("client_ready_to_submit_ms")) db.exec("ALTER TABLE practice_responses ADD COLUMN client_ready_to_submit_ms INTEGER NOT NULL DEFAULT 0");
  }

  function loadBank() {
    const configured = process.env.PRACTICE_BANK_ROOT;
    const bankRoot = practiceBankRoot
      ? path.resolve(practiceBankRoot)
      : configured
        ? path.resolve(configured)
        : path.join(sourceRoot, "practice-bank");
    const configFile = path.join(bankRoot, "bank.config.json");
    if (!fs.existsSync(configFile)) throw new Error(`practice bank config missing: ${configFile}`);
    const bankConfig = normalizeBankConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
    cohortPool = bankConfig.cohortPool;
    const file = path.join(bankRoot, bankConfig.sourceFile);
    if (!fs.existsSync(file)) throw new Error(`practice bank missing: ${file}`);
    const raw = fs.readFileSync(file, "utf8");
    const sourceHash = crypto.createHash("sha256").update(raw).digest("hex");
    const version = `${sourceHash.slice(0, 12)}`;
    const records = raw.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const usable = records.filter((record) => record.answer && record.answer.public_practice_eligible && !record.answer.is_disputed);
    if (usable.length !== bankConfig.expectedUsableQuestions) {
      throw new Error(`practice bank expected ${bankConfig.expectedUsableQuestions} usable questions, got ${usable.length}`);
    }
    const ids = new Set(usable.map((record) => Number(record.id)));
    const missingCohort = cohortPool.filter((number) => !ids.has(number));
    if (missingCohort.length) throw new Error(`practice cohort contains unavailable questions: ${missingCohort.join(",")}`);

    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE practice_banks SET is_current = 0 WHERE id = ?").run(bankConfig.id);
      db.prepare(`
        INSERT INTO practice_banks (id, version, display_name, question_count, source_sha256, active, is_current, created_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?)
        ON CONFLICT(id, version) DO UPDATE SET display_name=excluded.display_name, question_count=excluded.question_count,
          source_sha256=excluded.source_sha256, active=1, is_current=1
      `).run(bankConfig.id, version, bankConfig.displayName, usable.length, sourceHash, nowIso());
      const insert = db.prepare(`
        INSERT INTO practice_questions
          (bank_id, bank_version, source_number, render_json, answer_action, answer_tile, answer_riichi, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(bank_id, bank_version, source_number) DO UPDATE SET
          render_json=excluded.render_json, answer_action=excluded.answer_action,
          answer_tile=excluded.answer_tile, answer_riichi=excluded.answer_riichi, active=1
      `);
      for (const record of usable) {
        const sourceAnswer = record.answer;
        const answer = sourceAnswer.answer_action === "kan"
          ? { action: "ankan", tile: sourceAnswer.answer_tile, riichi: false }
          : { action: "discard", tile: sourceAnswer.answer_tile, riichi: sourceAnswer.answer_action === "riichi" };
        const annotation = record.annotation || {};
        const render = {
          scene: annotation.scene || {},
          doraIndicators: annotation.dora_indicators || "",
          hand: annotation.hand || "",
          draw: annotation.draw || "",
          melds: annotation.melds || [],
          layoutVariant: annotation.layout_variant || "standard",
        };
        insert.run(bankConfig.id, version, Number(record.id), JSON.stringify(render), answer.action, answer.tile, answer.riichi ? 1 : 0, nowIso());
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    currentBank = {
      id: bankConfig.id,
      version,
      displayName: bankConfig.displayName,
      questionCount: usable.length,
      cohortSize: cohortPool.length,
      sourceHash,
    };
  }

  function init() {
    initSchema();
    loadBank();
    return currentBank;
  }

  function bankQuestions(bank = currentBank) {
    return db.prepare(`
      SELECT source_number FROM practice_questions
      WHERE bank_id = ? AND bank_version = ? AND active = 1 ORDER BY source_number
    `).all(bank.id, bank.version).map((row) => Number(row.source_number));
  }

  function makeOrder(roundNumber) {
    const all = bankQuestions();
    if (roundNumber === 1) {
      const rest = all.filter((number) => !cohortPool.includes(number));
      return [...shuffle(cohortPool), ...shuffle(rest)];
    }
    return shuffle(all);
  }

  function latestRound(identityId) {
    return db.prepare(`
      SELECT * FROM practice_rounds WHERE identity_id = ? AND bank_id = ? AND bank_version = ?
      ORDER BY round_number DESC LIMIT 1
    `).get(identityId, currentBank.id, currentBank.version);
  }

  function activeRound(identityId) {
    return db.prepare(`
      SELECT * FROM practice_rounds WHERE identity_id = ? AND bank_id = ? AND bank_version = ? AND status = 'active'
      ORDER BY round_number DESC LIMIT 1
    `).get(identityId, currentBank.id, currentBank.version);
  }

  function rankingRows() {
    const rows = db.prepare(`
      SELECT r.identity_id AS identityId, i.nickname,
             COUNT(*) AS answered, COALESCE(SUM(r.correct), 0) AS correct
      FROM practice_responses r JOIN identities i ON i.id = r.identity_id
      WHERE r.bank_id = ? AND r.bank_version = ? AND COALESCE(i.excluded_from_board, 0) = 0
      GROUP BY r.identity_id, i.nickname
    `).all(currentBank.id, currentBank.version).map((row) => ({
      ...row,
      answered: Number(row.answered),
      correct: Number(row.correct),
      accuracy: Number(row.answered) ? Number(row.correct) / Number(row.answered) : 0,
    }));
    const countRows = rows.filter((row) => row.answered >= MIN_ACCURACY_RANK_ANSWERS)
      .sort((a, b) => b.answered - a.answered || b.accuracy - a.accuracy || a.identityId.localeCompare(b.identityId));
    let lastCount = null;
    let countRank = 0;
    countRows.forEach((row, index) => {
      if (row.answered !== lastCount) countRank = index + 1;
      row.countRank = countRank;
      lastCount = row.answered;
    });
    const accuracyRows = rows.filter((row) => row.answered >= MIN_ACCURACY_RANK_ANSWERS)
      .sort((a, b) => b.accuracy - a.accuracy || b.answered - a.answered || a.identityId.localeCompare(b.identityId));
    let lastAccuracy = null;
    let lastAnswered = null;
    let accuracyRank = 0;
    accuracyRows.forEach((row, index) => {
      if (row.accuracy !== lastAccuracy || row.answered !== lastAnswered) accuracyRank = index + 1;
      row.accuracyRank = accuracyRank;
      lastAccuracy = row.accuracy;
      lastAnswered = row.answered;
    });
    return { rows, countRows, accuracyRows };
  }

  function publicRanking(identityId, topN = 10) {
    const ranking = rankingRows();
    const shape = (row, kind) => ({
      rank: kind === "accuracy" ? row.accuracyRank : row.countRank,
      nickname: displayNickname(row.nickname, row.identityId),
      answered: row.answered,
      correct: row.correct,
      accuracy: Math.round(row.accuracy * 10000) / 100,
    });
    const countTop = ranking.countRows.slice(0, topN).map((row) => shape(row, "count"));
    const accuracyTop = ranking.accuracyRows.slice(0, topN).map((row) => shape(row, "accuracy"));
    const youBase = ranking.rows.find((row) => row.identityId === identityId) || { answered: 0, correct: 0, accuracy: 0 };
    const countRow = ranking.countRows.find((row) => row.identityId === identityId);
    const accuracyRow = ranking.accuracyRows.find((row) => row.identityId === identityId);
    return {
      countTop,
      accuracyTop,
      totalParticipants: ranking.rows.length,
      totalAccuracyRanked: ranking.accuracyRows.length,
      you: {
        answered: youBase.answered,
        correct: youBase.correct,
        accuracy: Math.round(youBase.accuracy * 10000) / 100,
        countRank: countRow ? countRow.countRank : null,
        accuracyRank: accuracyRow ? accuracyRow.accuracyRank : null,
        accuracyRankEligible: youBase.answered >= MIN_ACCURACY_RANK_ANSWERS,
        answersUntilAccuracyRank: Math.max(0, MIN_ACCURACY_RANK_ANSWERS - youBase.answered),
      },
    };
  }

  function statsFor(identityId, round = activeRound(identityId)) {
    const lifetime = db.prepare(`
      SELECT COUNT(*) AS answered, COALESCE(SUM(correct), 0) AS correct
      FROM practice_responses WHERE identity_id = ? AND bank_id = ? AND bank_version = ?
    `).get(identityId, currentBank.id, currentBank.version);
    let roundAnswered = 0;
    if (round) {
      roundAnswered = Number(db.prepare("SELECT COUNT(*) AS n FROM practice_responses WHERE round_id = ?").get(round.id).n);
    } else {
      const latest = latestRound(identityId);
      if (latest) roundAnswered = Number(db.prepare("SELECT COUNT(*) AS n FROM practice_responses WHERE round_id = ?").get(latest.id).n);
    }
    const answered = Number(lifetime.answered);
    const correct = Number(lifetime.correct);
    return {
      bankId: currentBank.id,
      bankVersion: currentBank.version,
      bankName: currentBank.displayName,
      totalQuestions: currentBank.questionCount,
      roundNumber: round ? Number(round.round_number) : (latestRound(identityId) ? Number(latestRound(identityId).round_number) : 0),
      roundAnswered,
      lifetimeAnswered: answered,
      lifetimeCorrect: correct,
      accuracy: answered ? Math.round(correct / answered * 10000) / 100 : 0,
    };
  }

  function questionRow(round, assignment) {
    return db.prepare(`
      SELECT * FROM practice_questions WHERE bank_id = ? AND bank_version = ? AND source_number = ?
    `).get(round.bank_id, round.bank_version, assignment.source_number);
  }

  function publicQuestion(round, assignment) {
    const question = questionRow(round, assignment);
    return {
      assignmentId: assignment.id,
      roundNumber: Number(round.round_number),
      sequence: Number(assignment.sequence),
      totalQuestions: Number(round.total_questions),
      assignedAt: assignment.assigned_at,
      render: JSON.parse(question.render_json),
    };
  }

  function feedbackPayload(identityId, round, assignment) {
    const response = db.prepare("SELECT * FROM practice_responses WHERE assignment_id = ?").get(assignment.id);
    const question = questionRow(round, assignment);
    const correctAnswer = { action: question.answer_action, tile: question.answer_tile, riichi: Boolean(question.answer_riichi) };
    return {
      status: "feedback",
      assignmentId: assignment.id,
      roundNumber: Number(round.round_number),
      sequence: Number(assignment.sequence),
      totalQuestions: Number(round.total_questions),
      sourceNumber: Number(assignment.source_number),
      correct: Boolean(response.correct),
      render: JSON.parse(question.render_json),
      selectedAnswer: { action: response.selected_action, tile: response.selected_tile, riichi: Boolean(response.selected_riichi) },
      correctAnswer,
      stats: statsFor(identityId, round),
      ranking: publicRanking(identityId),
    };
  }

  function getCurrent(identityId) {
    const round = activeRound(identityId);
    if (!round) {
      const latest = latestRound(identityId);
      return {
        status: latest && latest.status === "completed" ? "round_complete" : "not_started",
        canStartNextRound: !latest || latest.status === "completed",
        lastRoundNumber: latest ? Number(latest.round_number) : 0,
        stats: statsFor(identityId, null),
        ranking: publicRanking(identityId),
      };
    }
    const pendingFeedback = db.prepare(`
      SELECT * FROM practice_assignments WHERE round_id = ? AND answered_at IS NOT NULL AND advanced_at IS NULL
      ORDER BY sequence DESC LIMIT 1
    `).get(round.id);
    if (pendingFeedback) return feedbackPayload(identityId, round, pendingFeedback);
    const unanswered = db.prepare(`
      SELECT * FROM practice_assignments WHERE round_id = ? AND answered_at IS NULL ORDER BY sequence DESC LIMIT 1
    `).get(round.id);
    if (unanswered) {
      return { status: "question", question: publicQuestion(round, unanswered), stats: statsFor(identityId, round), ranking: publicRanking(identityId) };
    }
    const answered = Number(db.prepare("SELECT COUNT(*) AS n FROM practice_responses WHERE round_id = ?").get(round.id).n);
    if (answered >= Number(round.total_questions)) {
      db.prepare("UPDATE practice_rounds SET status='completed', completed_at=COALESCE(completed_at, ?) WHERE id = ?").run(nowIso(), round.id);
      return { status: "round_complete", canStartNextRound: true, lastRoundNumber: Number(round.round_number), stats: statsFor(identityId, round), ranking: publicRanking(identityId) };
    }
    const order = JSON.parse(round.order_json);
    const sourceNumber = Number(order[answered]);
    const assignment = {
      id: id("pasg"),
      round_id: round.id,
      source_number: sourceNumber,
      sequence: answered + 1,
      cohort_seed_item: Number(round.round_number) === 1 && answered < cohortPool.length ? 1 : 0,
      assigned_at: nowIso(),
    };
    db.prepare(`
      INSERT INTO practice_assignments
        (id, round_id, source_number, sequence, cohort_seed_item, status, assigned_at)
      VALUES (?, ?, ?, ?, ?, 'assigned', ?)
    `).run(assignment.id, assignment.round_id, assignment.source_number, assignment.sequence, assignment.cohort_seed_item, assignment.assigned_at);
    return { status: "question", question: publicQuestion(round, assignment), stats: statsFor(identityId, round), ranking: publicRanking(identityId) };
  }

  function startRound(req, identity) {
    const existing = activeRound(identity.id);
    if (existing) return getCurrent(identity.id);
    const latest = latestRound(identity.id);
    if (latest && latest.status !== "completed") throw new Error("当前轮次尚未完成。");
    const roundNumber = latest ? Number(latest.round_number) + 1 : 1;
    const order = makeOrder(roundNumber);
    const roundId = id("prnd");
    db.prepare(`
      INSERT INTO practice_rounds
        (id, identity_id, bank_id, bank_version, round_number, status, analysis_eligible, total_questions, order_json, started_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `).run(roundId, identity.id, currentBank.id, currentBank.version, roundNumber, roundNumber === 1 ? 1 : 0, order.length, JSON.stringify(order), nowIso());
    if (roundNumber > 1) resetNicknameReview(identity.id, roundNumber);
    try { captureServerFingerprint(req, identity.id, null); } catch (error) { console.error("[practice] fingerprint failed", error.message); }
    return getCurrent(identity.id);
  }

  function requirePracticeIdentity(req, res) {
    const identity = requireIdentity(req, res);
    return identity || null;
  }

  function limited(req, res, scope, limit = 180) {
    const result = checkRateLimit(req, scope, limit, 60);
    if (result.allowed) return false;
    json(res, 429, { error: "请求过于频繁，请稍后再试。", retryAfterSeconds: result.retryAfterSeconds }, { "Retry-After": String(result.retryAfterSeconds) });
    return true;
  }

  function upsertActivity(assignment, identity, body) {
    const timing = timingPayload(body.timing || body);
    const sessionId = body.sessionId ? String(body.sessionId).slice(0, 80) : null;
    db.prepare(`
      INSERT INTO practice_activity
        (assignment_id, identity_id, session_id, ready_at, first_shown_at, first_interaction_at,
         visible_time_ms, focused_time_ms, active_thinking_time_ms, load_time_ms,
         hidden_count, blur_count, resume_count, interaction_count, timing_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        session_id=COALESCE(excluded.session_id, practice_activity.session_id),
        ready_at=COALESCE(practice_activity.ready_at, excluded.ready_at),
        first_shown_at=COALESCE(practice_activity.first_shown_at, excluded.first_shown_at),
        first_interaction_at=COALESCE(practice_activity.first_interaction_at, excluded.first_interaction_at),
        visible_time_ms=MAX(practice_activity.visible_time_ms, excluded.visible_time_ms),
        focused_time_ms=MAX(practice_activity.focused_time_ms, excluded.focused_time_ms),
        active_thinking_time_ms=MAX(practice_activity.active_thinking_time_ms, excluded.active_thinking_time_ms),
        load_time_ms=MAX(practice_activity.load_time_ms, excluded.load_time_ms),
        hidden_count=MAX(practice_activity.hidden_count, excluded.hidden_count),
        blur_count=MAX(practice_activity.blur_count, excluded.blur_count),
        resume_count=MAX(practice_activity.resume_count, excluded.resume_count),
        interaction_count=MAX(practice_activity.interaction_count, excluded.interaction_count),
        timing_json=excluded.timing_json, updated_at=excluded.updated_at
    `).run(
      assignment.id, identity.id, sessionId, timing.readyAt, timing.firstShownAt, timing.firstInteractionAt,
      timing.visibleTimeMs, timing.focusedTimeMs, timing.activeThinkingTimeMs, timing.loadTimeMs,
      timing.hiddenCount, timing.blurCount, timing.resumeCount, timing.interactionCount,
      JSON.stringify(timing), nowIso(),
    );
    return db.prepare("SELECT * FROM practice_activity WHERE assignment_id = ?").get(assignment.id);
  }

  function adminIdentityIndex() {
    const rows = db.prepare(`
      WITH response_stats AS (
        SELECT identity_id,
               COUNT(*) AS answered,
               COALESCE(SUM(correct), 0) AS correct,
               COALESCE(SUM(analysis_eligible), 0) AS analysis_eligible_answers,
               MAX(submitted_at) AS last_response_at
        FROM practice_responses
        WHERE bank_id = ? AND bank_version = ?
        GROUP BY identity_id
      ), ranked_rounds AS (
        SELECT rr.*,
               ROW_NUMBER() OVER (PARTITION BY rr.identity_id ORDER BY rr.round_number DESC) AS row_num,
               (SELECT COUNT(*) FROM practice_responses p WHERE p.round_id = rr.id) AS round_answered,
               (SELECT COALESCE(SUM(correct), 0) FROM practice_responses p WHERE p.round_id = rr.id) AS round_correct
        FROM practice_rounds rr
        WHERE rr.bank_id = ? AND rr.bank_version = ?
      )
      SELECT rr.identity_id, i.nickname, i.excluded_from_board,
             rr.id AS latest_round_id, rr.round_number, rr.status AS round_status,
             rr.analysis_eligible AS round_analysis_eligible, rr.total_questions,
             rr.started_at, rr.completed_at, rr.round_answered, rr.round_correct,
             COALESCE(rs.answered, 0) AS answered, COALESCE(rs.correct, 0) AS correct,
             COALESCE(rs.analysis_eligible_answers, 0) AS analysis_eligible_answers,
             rs.last_response_at
      FROM ranked_rounds rr
      JOIN identities i ON i.id = rr.identity_id
      LEFT JOIN response_stats rs ON rs.identity_id = rr.identity_id
      WHERE rr.row_num = 1
    `).all(currentBank.id, currentBank.version, currentBank.id, currentBank.version);
    return rows.map((row) => {
      const answered = Number(row.answered || 0);
      const correct = Number(row.correct || 0);
      return {
        identityId: row.identity_id,
        nickname: row.nickname,
        displayNickname: displayNickname(row.nickname, row.identity_id),
        excludedFromBoard: Boolean(row.excluded_from_board),
        answered,
        correct,
        accuracy: answered ? Math.round((correct / answered) * 10000) / 100 : 0,
        analysisEligibleAnswers: Number(row.analysis_eligible_answers || 0),
        latestRoundId: row.latest_round_id,
        roundNumber: Number(row.round_number),
        roundStatus: row.round_status,
        roundAnalysisEligible: Boolean(row.round_analysis_eligible),
        roundAnswered: Number(row.round_answered || 0),
        roundCorrect: Number(row.round_correct || 0),
        totalQuestions: Number(row.total_questions || currentBank.questionCount),
        roundStartedAt: row.started_at,
        roundCompletedAt: row.completed_at,
        lastResponseAt: row.last_response_at,
      };
    });
  }

  function adminIdentityPractice(identityId) {
    const index = adminIdentityIndex().find((row) => row.identityId === identityId) || null;
    const rounds = db.prepare(`
      SELECT rr.id, rr.round_number, rr.status, rr.analysis_eligible, rr.total_questions,
             rr.started_at, rr.completed_at, COUNT(p.id) AS answered,
             COALESCE(SUM(p.correct), 0) AS correct, MAX(p.submitted_at) AS last_response_at
      FROM practice_rounds rr
      LEFT JOIN practice_responses p ON p.round_id = rr.id
      WHERE rr.identity_id = ? AND rr.bank_id = ? AND rr.bank_version = ?
      GROUP BY rr.id
      ORDER BY rr.round_number DESC
    `).all(identityId, currentBank.id, currentBank.version).map((row) => {
      const answered = Number(row.answered || 0);
      const correct = Number(row.correct || 0);
      return {
        id: row.id,
        roundNumber: Number(row.round_number),
        status: row.status,
        analysisEligible: Boolean(row.analysis_eligible),
        totalQuestions: Number(row.total_questions),
        answered,
        correct,
        accuracy: answered ? Math.round((correct / answered) * 10000) / 100 : 0,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        lastResponseAt: row.last_response_at,
      };
    });
    return {
      bank: currentBank,
      summary: index || {
        identityId,
        answered: 0,
        correct: 0,
        accuracy: 0,
        analysisEligibleAnswers: 0,
        roundNumber: 0,
        roundStatus: null,
        roundAnswered: 0,
        totalQuestions: currentBank.questionCount,
        lastResponseAt: null,
      },
      rounds,
    };
  }

  function adminPracticeResponses(identityId, filters = {}) {
    const pageSize = Math.max(10, Math.min(100, Number(filters.pageSize) || 25));
    const page = Math.max(1, Number(filters.page) || 1);
    const where = ["p.identity_id = ?", "p.bank_id = ?", "p.bank_version = ?"];
    const args = [identityId, currentBank.id, currentBank.version];
    const roundNumber = Number(filters.roundNumber);
    if (Number.isInteger(roundNumber) && roundNumber > 0) {
      where.push("rr.round_number = ?");
      args.push(roundNumber);
    }
    if (filters.correct === "correct" || filters.correct === "wrong") {
      where.push("p.correct = ?");
      args.push(filters.correct === "correct" ? 1 : 0);
    }
    const sourceNumber = Number(filters.sourceNumber);
    if (Number.isInteger(sourceNumber) && sourceNumber > 0) {
      where.push("p.source_number = ?");
      args.push(sourceNumber);
    }
    const from = `
      FROM practice_responses p
      JOIN practice_rounds rr ON rr.id = p.round_id
      JOIN practice_questions q ON q.bank_id = p.bank_id AND q.bank_version = p.bank_version AND q.source_number = p.source_number
      LEFT JOIN practice_assignments a ON a.id = p.assignment_id
      WHERE ${where.join(" AND ")}
    `;
    const total = Number(db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n);
    const rows = db.prepare(`
      SELECT p.id, p.round_id, rr.round_number, p.source_number, p.sequence,
             p.selected_action, p.selected_tile, p.selected_riichi, p.correct,
             q.answer_action, q.answer_tile, q.answer_riichi,
             p.analysis_eligible, COALESCE(a.cohort_seed_item, 0) AS cohort_seed_item,
             p.assigned_at, p.ready_at, p.first_shown_at, p.first_interaction_at, p.submitted_at,
             p.server_wall_time_ms, p.server_ready_to_submit_ms, p.client_elapsed_time_ms,
             p.client_ready_to_submit_ms, p.client_visible_time_ms, p.client_focused_time_ms,
             p.client_active_thinking_time_ms, p.client_load_time_ms,
             p.hidden_count, p.blur_count, p.resume_count, p.interaction_count,
             p.session_id, p.fingerprint_id, p.device_hash
      ${from}
      ORDER BY p.submitted_at DESC, p.sequence DESC
      LIMIT ? OFFSET ?
    `).all(...args, pageSize, (page - 1) * pageSize).map((row) => ({
      id: row.id,
      roundId: row.round_id,
      roundNumber: Number(row.round_number),
      sourceNumber: Number(row.source_number),
      sequence: Number(row.sequence),
      selectedAnswer: { action: row.selected_action, tile: row.selected_tile, riichi: Boolean(row.selected_riichi) },
      correctAnswer: { action: row.answer_action, tile: row.answer_tile, riichi: Boolean(row.answer_riichi) },
      correct: Boolean(row.correct),
      analysisEligible: Boolean(row.analysis_eligible),
      cohortSeedItem: Boolean(row.cohort_seed_item),
      assignedAt: row.assigned_at,
      readyAt: row.ready_at,
      firstShownAt: row.first_shown_at,
      firstInteractionAt: row.first_interaction_at,
      submittedAt: row.submitted_at,
      serverWallTimeMs: row.server_wall_time_ms,
      serverReadyToSubmitMs: row.server_ready_to_submit_ms,
      clientElapsedTimeMs: row.client_elapsed_time_ms,
      clientReadyToSubmitMs: row.client_ready_to_submit_ms,
      visibleTimeMs: row.client_visible_time_ms,
      focusedTimeMs: row.client_focused_time_ms,
      activeThinkingTimeMs: row.client_active_thinking_time_ms,
      loadTimeMs: row.client_load_time_ms,
      hiddenCount: Number(row.hidden_count || 0),
      blurCount: Number(row.blur_count || 0),
      resumeCount: Number(row.resume_count || 0),
      interactionCount: Number(row.interaction_count || 0),
      sessionId: row.session_id,
      fingerprintId: row.fingerprint_id,
      deviceHashPrefix: row.device_hash ? String(row.device_hash).slice(0, 12) : null,
    }));
    return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), responses: rows };
  }

  async function handleUserApi(req, res, url) {
    if (!url.pathname.startsWith("/api/practice")) return false;
    if (limited(req, res, "practice", 240)) return true;
    const identity = requirePracticeIdentity(req, res);
    if (!identity) return true;

    if (req.method === "GET" && url.pathname === "/api/practice/status") {
      return json(res, 200, { ...getCurrent(identity.id), csrf: identity.csrf_token, bank: currentBank, idleThresholdMs: IDLE_THRESHOLD_MS });
    }

    if (req.method === "POST" && url.pathname === "/api/practice/start") {
      try {
        return json(res, 200, { ...startRound(req, identity), csrf: identity.csrf_token, bank: currentBank, idleThresholdMs: IDLE_THRESHOLD_MS });
      } catch (error) {
        return json(res, 400, { error: error.message, csrf: identity.csrf_token });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/practice/current") {
      return json(res, 200, { ...getCurrent(identity.id), csrf: identity.csrf_token, bank: currentBank, idleThresholdMs: IDLE_THRESHOLD_MS });
    }

    if (req.method === "GET" && url.pathname === "/api/practice/leaderboard") {
      const topN = Math.max(1, Math.min(100, Number(url.searchParams.get("top")) || 20));
      return json(res, 200, { ...publicRanking(identity.id, topN), csrf: identity.csrf_token, bank: currentBank });
    }

    if (req.method === "POST" && url.pathname === "/api/practice/session") {
      const body = await readJson(req);
      const round = activeRound(identity.id);
      const sessionId = id("pses");
      let fingerprintId = null;
      try { fingerprintId = captureServerFingerprint(req, identity.id, null); } catch (error) { console.error("[practice] session fingerprint failed", error.message); }
      db.prepare(`
        INSERT INTO practice_sessions
          (id, identity_id, round_id, bank_id, bank_version, fingerprint_id, device_hash, started_at, last_seen_at, client_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sessionId, identity.id, round ? round.id : null, currentBank.id, currentBank.version, fingerprintId, deviceHash(req), nowIso(), nowIso(), JSON.stringify(body).slice(0, 5000));
      return json(res, 200, { sessionId, csrf: identity.csrf_token });
    }

    const sessionPing = url.pathname.match(/^\/api\/practice\/session\/([^/]+)\/ping$/);
    if (req.method === "POST" && sessionPing) {
      const body = await readJson(req);
      const result = db.prepare(`
        UPDATE practice_sessions SET last_seen_at = ?, client_json = ? WHERE id = ? AND identity_id = ?
      `).run(nowIso(), JSON.stringify(body).slice(0, 5000), sessionPing[1], identity.id);
      if (!result.changes) return json(res, 404, { error: "练习会话不存在。", csrf: identity.csrf_token });
      return json(res, 200, { ok: true, csrf: identity.csrf_token });
    }

    const readyMatch = url.pathname.match(/^\/api\/practice\/assignments\/([^/]+)\/ready$/);
    if (req.method === "POST" && readyMatch) {
      const assignment = db.prepare(`
        SELECT a.* FROM practice_assignments a JOIN practice_rounds r ON r.id=a.round_id
        WHERE a.id=? AND r.identity_id=? AND a.answered_at IS NULL
      `).get(readyMatch[1], identity.id);
      if (!assignment) return json(res, 404, { error: "当前题目不存在。", csrf: identity.csrf_token });
      const body = await readJson(req);
      const timing = timingPayload(body.timing || body);
      const readyAt = assignment.ready_at || timing.readyAt || nowIso();
      const shownAt = assignment.first_shown_at || timing.firstShownAt || readyAt;
      db.prepare("UPDATE practice_assignments SET ready_at=?, first_shown_at=? WHERE id=?")
        .run(readyAt, shownAt, assignment.id);
      upsertActivity(assignment, identity, { ...body, timing: { ...timing, readyAt, firstShownAt: shownAt } });
      return json(res, 200, { ok: true, csrf: identity.csrf_token });
    }

    const activityMatch = url.pathname.match(/^\/api\/practice\/assignments\/([^/]+)\/activity$/);
    if (req.method === "POST" && activityMatch) {
      const assignment = db.prepare(`
        SELECT a.* FROM practice_assignments a JOIN practice_rounds r ON r.id=a.round_id
        WHERE a.id=? AND r.identity_id=? AND a.answered_at IS NULL
      `).get(activityMatch[1], identity.id);
      if (!assignment) return json(res, 404, { error: "当前题目不存在。", csrf: identity.csrf_token });
      const body = await readJson(req);
      upsertActivity(assignment, identity, body);
      return json(res, 200, { ok: true, csrf: identity.csrf_token });
    }

    const answerMatch = url.pathname.match(/^\/api\/practice\/assignments\/([^/]+)\/answer$/);
    if (req.method === "POST" && answerMatch) {
      const assignment = db.prepare(`
        SELECT a.*, r.identity_id, r.bank_id, r.bank_version, r.round_number, r.analysis_eligible, r.total_questions
        FROM practice_assignments a JOIN practice_rounds r ON r.id=a.round_id
        WHERE a.id=? AND r.identity_id=?
      `).get(answerMatch[1], identity.id);
      if (!assignment) return json(res, 404, { error: "当前题目不存在。", csrf: identity.csrf_token });
      const existing = db.prepare("SELECT id FROM practice_responses WHERE assignment_id=?").get(assignment.id);
      const round = db.prepare("SELECT * FROM practice_rounds WHERE id=?").get(assignment.round_id);
      if (existing) return json(res, 200, { ...feedbackPayload(identity.id, round, assignment), csrf: identity.csrf_token });
      const body = await readJson(req);
      const question = questionRow(round, assignment);
      const render = JSON.parse(question.render_json);
      let selected;
      try { selected = normalizeResponse(body.response || body, render); }
      catch (error) { return json(res, 400, { error: error.message, csrf: identity.csrf_token }); }
      const correctAnswer = { action: question.answer_action, tile: question.answer_tile, riichi: Boolean(question.answer_riichi) };
      const correct = answersEqual(selected, correctAnswer);
      const activity = upsertActivity(assignment, identity, body);
      const submittedAt = nowIso();
      const serverWall = Math.max(0, nowMs() - new Date(assignment.assigned_at).getTime());
      const serverReadyToSubmit = assignment.ready_at ? Math.max(0, nowMs() - new Date(assignment.ready_at).getTime()) : null;
      const fingerprintId = db.prepare("SELECT last_fingerprint_id AS id FROM identities WHERE id=?").get(identity.id)?.id || null;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`
          INSERT INTO practice_responses
            (id, assignment_id, identity_id, round_id, bank_id, bank_version, source_number, sequence,
             selected_action, selected_tile, selected_riichi, correct, analysis_eligible,
             client_submission_id, session_id, fingerprint_id, assigned_at, ready_at, first_shown_at,
             first_interaction_at, submitted_at, server_wall_time_ms, server_ready_to_submit_ms,
             client_elapsed_time_ms, client_ready_to_submit_ms, client_visible_time_ms,
             client_focused_time_ms, client_active_thinking_time_ms, client_load_time_ms,
             hidden_count, blur_count, resume_count, interaction_count, timing_json, device_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id("pres"), assignment.id, identity.id, assignment.round_id, round.bank_id, round.bank_version,
          assignment.source_number, assignment.sequence, selected.action, selected.tile, selected.riichi ? 1 : 0,
          correct ? 1 : 0, round.analysis_eligible, body.submissionId ? String(body.submissionId).slice(0, 100) : null,
          activity.session_id || null, fingerprintId, assignment.assigned_at, assignment.ready_at || activity.ready_at,
          assignment.first_shown_at || activity.first_shown_at, activity.first_interaction_at, submittedAt,
          serverWall, serverReadyToSubmit, timingPayload(JSON.parse(activity.timing_json || "{}")).clientElapsedMs,
          timingPayload(JSON.parse(activity.timing_json || "{}")).readyToSubmitMs,
          activity.visible_time_ms, activity.focused_time_ms, activity.active_thinking_time_ms,
          activity.load_time_ms, activity.hidden_count, activity.blur_count, activity.resume_count,
          activity.interaction_count, activity.timing_json, deviceHash(req), submittedAt,
        );
        db.prepare("UPDATE practice_assignments SET status='answered', answered_at=? WHERE id=?").run(submittedAt, assignment.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        if (String(error.message).includes("UNIQUE")) return json(res, 200, { ...feedbackPayload(identity.id, round, assignment), csrf: identity.csrf_token });
        throw error;
      }
      return json(res, 200, { ...feedbackPayload(identity.id, round, db.prepare("SELECT * FROM practice_assignments WHERE id=?").get(assignment.id)), csrf: identity.csrf_token });
    }

    const nextMatch = url.pathname.match(/^\/api\/practice\/assignments\/([^/]+)\/next$/);
    if (req.method === "POST" && nextMatch) {
      const assignment = db.prepare(`
        SELECT a.* FROM practice_assignments a JOIN practice_rounds r ON r.id=a.round_id
        WHERE a.id=? AND r.identity_id=?
      `).get(nextMatch[1], identity.id);
      if (!assignment) return json(res, 404, { error: "题目不存在。", csrf: identity.csrf_token });
      if (!assignment.answered_at) return json(res, 409, { error: "提交答案后才能进入下一题。", csrf: identity.csrf_token });
      if (!assignment.advanced_at) db.prepare("UPDATE practice_assignments SET advanced_at=? WHERE id=?").run(nowIso(), assignment.id);
      return json(res, 200, { ...getCurrent(identity.id), csrf: identity.csrf_token, bank: currentBank, idleThresholdMs: IDLE_THRESHOLD_MS });
    }

    return false;
  }

  async function handleAdminApi(req, res, url, admin, csrf) {
    if (!url.pathname.startsWith("/api/admin/practice")) return false;
    if (req.method === "GET" && url.pathname === "/api/admin/practice/summary") {
      const summary = {
        bank: currentBank,
        identities: Number(db.prepare("SELECT COUNT(DISTINCT identity_id) AS n FROM practice_responses WHERE bank_id=? AND bank_version=?").get(currentBank.id, currentBank.version).n),
        responses: Number(db.prepare("SELECT COUNT(*) AS n FROM practice_responses WHERE bank_id=? AND bank_version=?").get(currentBank.id, currentBank.version).n),
        analysisEligible: Number(db.prepare("SELECT COUNT(*) AS n FROM practice_responses WHERE bank_id=? AND bank_version=? AND analysis_eligible=1").get(currentBank.id, currentBank.version).n),
        completedFirstRounds: Number(db.prepare("SELECT COUNT(*) AS n FROM practice_rounds WHERE bank_id=? AND bank_version=? AND round_number=1 AND status='completed'").get(currentBank.id, currentBank.version).n),
        activeRounds: Number(db.prepare("SELECT COUNT(*) AS n FROM practice_rounds WHERE bank_id=? AND bank_version=? AND status='active'").get(currentBank.id, currentBank.version).n),
      };
      return json(res, 200, { summary, csrf });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/practice/users") {
      const query = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const status = String(url.searchParams.get("status") || "all");
      const pageSize = Math.max(10, Math.min(100, Number(url.searchParams.get("pageSize")) || 25));
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      let users = adminIdentityIndex();
      if (query) users = users.filter((row) => [row.identityId, row.nickname, row.displayNickname].some((value) => String(value || "").toLowerCase().includes(query)));
      if (status === "active" || status === "completed") users = users.filter((row) => row.roundStatus === status);
      users.sort((left, right) => String(right.lastResponseAt || right.roundStartedAt || "").localeCompare(String(left.lastResponseAt || left.roundStartedAt || "")));
      const total = users.length;
      return json(res, 200, {
        bank: currentBank,
        total,
        page,
        pageSize,
        pages: Math.max(1, Math.ceil(total / pageSize)),
        users: users.slice((page - 1) * pageSize, page * pageSize),
        csrf,
      });
    }
    const adminPracticeUserMatch = url.pathname.match(/^\/api\/admin\/practice\/users\/([^/]+)$/);
    if (req.method === "GET" && adminPracticeUserMatch) {
      const identity = db.prepare("SELECT id, nickname, excluded_from_board FROM identities WHERE id = ?").get(adminPracticeUserMatch[1]);
      if (!identity) return json(res, 404, { error: "身份不存在。" });
      return json(res, 200, {
        identity: {
          id: identity.id,
          nickname: identity.nickname,
          displayNickname: displayNickname(identity.nickname, identity.id),
          excludedFromBoard: Boolean(identity.excluded_from_board),
        },
        practice: adminIdentityPractice(identity.id),
        csrf,
      });
    }
    const adminPracticeResponsesMatch = url.pathname.match(/^\/api\/admin\/practice\/users\/([^/]+)\/responses$/);
    if (req.method === "GET" && adminPracticeResponsesMatch) {
      const identity = db.prepare("SELECT id FROM identities WHERE id = ?").get(adminPracticeResponsesMatch[1]);
      if (!identity) return json(res, 404, { error: "身份不存在。" });
      return json(res, 200, {
        ...adminPracticeResponses(identity.id, {
          page: url.searchParams.get("page"),
          pageSize: url.searchParams.get("pageSize"),
          roundNumber: url.searchParams.get("round"),
          correct: url.searchParams.get("correct"),
          sourceNumber: url.searchParams.get("source"),
        }),
        csrf,
      });
    }
    const exportMatch = url.pathname === "/api/admin/practice/responses.csv" || url.pathname === "/api/admin/practice/cohort.csv";
    if (req.method === "GET" && exportMatch) {
      const cohortOnly = url.pathname.endsWith("cohort.csv");
      const rows = db.prepare(`
        SELECT p.id, p.identity_id, i.nickname, i.link_cluster_id, p.round_id, rr.round_number,
               p.bank_id, p.bank_version, p.source_number, p.sequence, a.cohort_seed_item,
               p.selected_action, p.selected_tile, p.selected_riichi, p.correct, p.analysis_eligible,
               p.assigned_at, p.ready_at, p.first_shown_at, p.first_interaction_at, p.submitted_at,
               p.server_wall_time_ms, p.server_ready_to_submit_ms, p.client_elapsed_time_ms,
               p.client_ready_to_submit_ms, p.client_visible_time_ms, p.client_focused_time_ms,
               p.client_active_thinking_time_ms, p.client_load_time_ms, p.hidden_count, p.blur_count,
               p.resume_count, p.interaction_count, p.session_id, p.fingerprint_id, p.device_hash,
               f.ip_prefix_hash, f.ip_prefix, f.ua_browser, f.ua_os, f.ua_device, f.ua_mobile,
               f.accept_language, f.timezone, f.screen_w, f.screen_h, f.dpr, f.viewport_w, f.viewport_h,
               f.platform, f.hardware_concurrency, f.device_memory, f.touch, f.color_scheme,
               f.webgl_vendor, f.webgl_renderer, f.webgl_hash
        FROM practice_responses p
        JOIN practice_assignments a ON a.id=p.assignment_id
        JOIN practice_rounds rr ON rr.id=p.round_id
        LEFT JOIN identities i ON i.id=p.identity_id
        LEFT JOIN fingerprints f ON f.id=p.fingerprint_id
        WHERE p.bank_id=? AND p.bank_version=? ${cohortOnly ? "AND p.analysis_eligible=1 AND a.cohort_seed_item=1" : ""}
        ORDER BY p.submitted_at
      `).all(currentBank.id, currentBank.version);
      const headers = rows.length ? Object.keys(rows[0]) : ["id"];
      const filename = cohortOnly ? "practice-cohort.csv" : "practice-responses.csv";
      return text(res, 200, csvText(rows, headers), "text/csv;charset=utf-8", { "Content-Disposition": `attachment; filename="${filename}"` });
    }
    // ---- 练习题库浏览（只读：含场况/牌面/答案）----
    if (req.method === "GET" && url.pathname === "/api/admin/practice/questions") {
      const rows = db.prepare(
        "SELECT source_number, render_json, answer_action, answer_tile, answer_riichi, active FROM practice_questions WHERE bank_id = ? AND bank_version = ? ORDER BY source_number"
      ).all(currentBank.id, currentBank.version);
      const questions = rows.map((r) => ({
        sourceNumber: r.source_number,
        render: JSON.parse(r.render_json),
        answer: { action: r.answer_action, tile: r.answer_tile, riichi: Boolean(r.answer_riichi) },
        active: Boolean(r.active),
        inCohort: cohortPool.includes(r.source_number),
      }));
      return json(res, 200, { bank: currentBank, total: questions.length, questions, csrf });
    }
    return false;
  }

  return {
    init,
    handleUserApi,
    handleAdminApi,
    getCurrentBank: () => currentBank,
    publicRanking,
    adminIdentityIndex,
    adminIdentityPractice,
    adminPracticeResponses,
  };
}

module.exports = {
  IDLE_THRESHOLD_MS,
  MIN_ACCURACY_RANK_ANSWERS,
  answersEqual,
  baseKind,
  createPracticeService,
  isTenpai,
  normalizeBankConfig,
  normalizeResponse,
  parseMpsz,
  shuffle,
  timingPayload,
};
