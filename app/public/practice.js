(function () {
  "use strict";

  const state = {
    csrf: "", me: null, sessionId: null, payload: null, question: null,
    selectedIndex: -1, riichi: false, kan: false, kanKind: null,
    validRiichi: {}, submitting: false, feedback: null, idleThresholdMs: 300000,
    timing: null, tickTimer: null, activityTimer: null, sessionTimer: null,
  };
  const $ = (selector) => document.querySelector(selector);
  const els = {
    views: ["loadingView", "introView", "questionView", "completeView"].reduce((out, id) => { out[id] = $("#" + id); return out; }, {}),
    nickname: $("#practiceNickname"), progress: $("#progressStat"), accuracy: $("#accuracyStat"),
    countRank: $("#countRankStat"), accuracyRank: $("#accuracyRankStat"),
    introTitle: $("#introTitle"), introMessage: $("#introMessage"), start: $("#startPracticeBtn"),
    roundLabel: $("#roundLabel"), sequenceTitle: $("#sequenceTitle"), sourceNumber: $("#sourceNumber"),
    situation: $("#situationBar"), dora: $("#doraTiles"), tray: $("#handTray"),
    handArea: $("#handArea"), handWrap: $("#handWrap"), set: $("#setRow"), draw: $("#drawRow"), melds: $("#meldRow"),
    declare: $("#declareRow"), riichi: $("#riichiBtn"), kan: $("#kanBtn"), selection: $("#selectionInfo"), saveState: $("#saveState"),
    feedback: $("#feedbackPanel"), verdict: $("#feedbackVerdict"), selectedText: $("#selectedAnswerText"), correctText: $("#correctAnswerText"),
    submit: $("#submitAnswerBtn"), next: $("#nextQuestionBtn"), questionMessage: $("#questionMessage"),
    completeTitle: $("#completeTitle"), completeSummary: $("#completeSummary"), nextRound: $("#nextRoundBtn"),
    countBoard: $("#countBoard"), accuracyBoard: $("#accuracyBoard"), refreshBoard: $("#refreshBoardBtn"),
  };

  async function api(url, options) {
    const init = options || {};
    const headers = Object.assign({}, init.headers || {});
    if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (state.csrf && init.method && init.method !== "GET") headers["X-CSRF-Token"] = state.csrf;
    const response = await fetch(url, Object.assign({ credentials: "same-origin" }, init, {
      headers,
      body: init.body && typeof init.body !== "string" ? JSON.stringify(init.body) : init.body,
    }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "请求失败");
      error.status = response.status;
      throw error;
    }
    if (data.csrf) state.csrf = data.csrf;
    return data;
  }

  function show(id) {
    Object.keys(els.views).forEach((key) => els.views[key].classList.toggle("is-active", key === id));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setMessage(text, error) {
    els.questionMessage.textContent = text || "";
    els.questionMessage.classList.toggle("is-error", Boolean(error));
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function tileName(code) {
    const n = Number(code[0]), suit = code[1];
    if (suit === "z") return ({ 1: "东", 2: "南", 3: "西", 4: "北", 5: "白", 6: "发", 7: "中" })[n] || code;
    return (n === 0 ? "赤5" : n) + ({ m: "万", p: "饼", s: "索" })[suit];
  }

  function baseKind(code) { return (code[0] === "0" ? "5" : code[0]) + code[1]; }
  function rawTile(code) { return '<img src="' + PracticeTiles.src(code) + '" alt="' + esc(code) + '">'; }

  function tileIndex(code) {
    let number = Number(code[0]);
    if (number === 0) number = 5;
    return ({ m: 0, p: 9, s: 18, z: 27 })[code[1]] + number - 1;
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
    if (i < 27 && i % 9 <= 6 && counts[i + 1] && counts[i + 2]) {
      counts[i] -= 1; counts[i + 1] -= 1; counts[i + 2] -= 1;
      if (canFormMelds(counts)) { counts[i] += 1; counts[i + 1] += 1; counts[i + 2] += 1; return true; }
      counts[i] += 1; counts[i + 1] += 1; counts[i + 2] += 1;
    }
    return false;
  }
  function isWin(counts) {
    for (let i = 0; i < 34; i += 1) {
      if (counts[i] >= 2) {
        counts[i] -= 2;
        const ok = canFormMelds(counts);
        counts[i] += 2;
        if (ok) return true;
      }
    }
    let pairs = 0, types = 0;
    counts.forEach((count) => { if (count) { types += 1; if (count === 2) pairs += 1; } });
    if (types === 7 && pairs === 7) return true;
    const terminals = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];
    for (let i = 0; i < 34; i += 1) if (counts[i] && !terminals.includes(i)) return false;
    return terminals.every((i) => counts[i] > 0) && terminals.some((i) => counts[i] >= 2);
  }
  function isTenpai(codes) {
    const counts = new Array(34).fill(0);
    codes.forEach((code) => { counts[tileIndex(code)] += 1; });
    for (let i = 0; i < 34; i += 1) {
      if (counts[i] >= 4) continue;
      counts[i] += 1;
      const ok = isWin(counts);
      counts[i] -= 1;
      if (ok) return true;
    }
    return false;
  }
  function validRiichiSet(all) {
    const result = {};
    all.forEach((_, index) => { if (isTenpai(all.slice(0, index).concat(all.slice(index + 1)))) result[index] = true; });
    return result;
  }

  function timingNow() { return Date.now(); }
  function beginTiming(question) {
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.timing = {
      assignedAt: question.assignedAt, readyAt: null, firstShownAt: new Date().toISOString(), firstInteractionAt: null,
      visibleTimeMs: 0, focusedTimeMs: 0, activeThinkingTimeMs: 0, loadTimeMs: 0,
      hiddenCount: 0, blurCount: 0, resumeCount: 0, interactionCount: 0,
      activitySegments: [{ event: "shown", at: new Date().toISOString() }],
      startedAtMs: timingNow(), lastTick: timingNow(), lastInteraction: timingNow(), loadStarted: timingNow(),
    };
    state.tickTimer = setInterval(function () {
      if (!state.timing || state.feedback) return;
      const now = timingNow();
      const delta = Math.max(0, Math.min(5000, now - state.timing.lastTick));
      state.timing.lastTick = now;
      if (document.visibilityState === "visible") state.timing.visibleTimeMs += delta;
      if (document.visibilityState === "visible" && document.hasFocus()) state.timing.focusedTimeMs += delta;
      if (document.visibilityState === "visible" && document.hasFocus() && now - state.timing.lastInteraction <= state.idleThresholdMs) {
        state.timing.activeThinkingTimeMs += delta;
      }
    }, 1000);
  }

  function markInteraction(kind) {
    if (!state.timing) return;
    const now = timingNow();
    state.timing.lastInteraction = now;
    state.timing.interactionCount += 1;
    if (!state.timing.firstInteractionAt) state.timing.firstInteractionAt = new Date(now).toISOString();
    if (state.timing.activitySegments.length < 1000) state.timing.activitySegments.push({ event: kind, at: new Date(now).toISOString() });
  }

  function timingSnapshot() {
    if (!state.timing) return {};
    const copy = Object.assign({}, state.timing);
    copy.clientElapsedMs = Math.max(0, timingNow() - state.timing.startedAtMs);
    copy.readyToSubmitMs = state.timing.readyAt ? Math.max(0, timingNow() - new Date(state.timing.readyAt).getTime()) : 0;
    delete copy.startedAtMs; delete copy.lastTick; delete copy.lastInteraction; delete copy.loadStarted;
    return copy;
  }

  function flushActivity(keepalive) {
    if (!state.question || state.feedback || !state.timing) return Promise.resolve();
    return fetch("/api/practice/assignments/" + state.question.assignmentId + "/activity", {
      method: "POST", credentials: "same-origin", keepalive: Boolean(keepalive),
      headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrf },
      body: JSON.stringify({ sessionId: state.sessionId, timing: timingSnapshot() }),
    }).catch(() => {});
  }

  document.addEventListener("visibilitychange", function () {
    if (!state.timing) return;
    if (document.visibilityState === "hidden") state.timing.hiddenCount += 1;
    else state.timing.resumeCount += 1;
    state.timing.activitySegments.push({ event: document.visibilityState, at: new Date().toISOString() });
    flushActivity(true);
  });
  window.addEventListener("blur", function () { if (state.timing) { state.timing.blurCount += 1; state.timing.activitySegments.push({ event: "blur", at: new Date().toISOString() }); } });
  window.addEventListener("focus", function () { if (state.timing) { state.timing.resumeCount += 1; state.timing.activitySegments.push({ event: "focus", at: new Date().toISOString() }); } });
  window.addEventListener("pagehide", function () { flushActivity(true); });

  function renderStats(stats, ranking) {
    if (!stats) return;
    els.progress.textContent = stats.roundAnswered + " / " + stats.totalQuestions;
    els.accuracy.textContent = stats.lifetimeAnswered ? stats.accuracy.toFixed(2).replace(/\.00$/, "") + "%" : "—";
    const you = ranking && ranking.you;
    els.countRank.textContent = you && you.countRank ? "第 " + you.countRank + " 名" : (you ? "再答 " + you.answersUntilAccuracyRank + " 题入榜" : "—");
    els.accuracyRank.textContent = you && you.accuracyRankEligible
      ? "第 " + you.accuracyRank + " 名"
      : (you ? "再答 " + you.answersUntilAccuracyRank + " 题入榜" : "完成20题后入榜");
  }

  function boardRows(container, rows, type) {
    container.replaceChildren();
    if (!rows || !rows.length) {
      const empty = document.createElement("p"); empty.className = "muted-line"; empty.textContent = "还没有入榜记录。"; container.appendChild(empty); return;
    }
    rows.slice(0, 20).forEach((row) => {
      const item = document.createElement("div"); item.className = "practice-board-row";
      const rank = document.createElement("span"); rank.className = "rank"; rank.textContent = row.rank;
      const name = document.createElement("span"); name.className = "name"; name.textContent = row.nickname;
      const value = document.createElement("span"); value.className = "value";
      value.textContent = type === "count" ? row.answered + "题" : row.accuracy.toFixed(2).replace(/\.00$/, "") + "%";
      const small = document.createElement("small"); small.textContent = type === "count" ? "正确率 " + row.accuracy.toFixed(2).replace(/\.00$/, "") + "%" : "已答 " + row.answered + " 题";
      value.appendChild(small); item.append(rank, name, value); container.appendChild(item);
    });
  }

  function renderRanking(ranking) {
    if (!ranking) return;
    boardRows(els.countBoard, ranking.countTop, "count");
    boardRows(els.accuracyBoard, ranking.accuracyTop, "accuracy");
  }

  // 去外文：把题库里可能出现的日文术语换成中文；若仍含日文假名则不展示（杜绝外文）。
  var JP_TERMS = [["アガリトップ", "和出即一位"], ["ダブルリーチ", "双立直"], ["ダブリーチ", "双立直"], ["リーチ", "立直"], ["メンゼンツモ", "门前清自摸"], ["ツモ切り", "摸切"], ["ツモ", "自摸"], ["ドラ表示牌", "宝牌指示牌"], ["裏ドラ", "里宝牌"], ["赤ドラ", "赤宝牌"], ["ドラ", "宝牌"], ["テンパイ", "听牌"], ["ノーテン", "未听牌"], ["イーシャンテン", "一向听"], ["シャンテン", "向听"], ["メンゼン", "门清"], ["フリテン", "振听"], ["ダマテン", "默听"], ["ダマ", "默听"], ["トップ目", "首位"], ["トップ", "首位"], ["ラス目", "末位"], ["ラス", "末位"], ["アガリ", "和了"], ["巡目", "巡"], ["本場", "本场"], ["東家", "东家"], ["南家", "南家"], ["西家", "西家"], ["北家", "北家"]];
  function localizeScene(value) {
    var s = String(value == null ? "" : value);
    if (!s) return "";
    for (var i = 0; i < JP_TERMS.length; i += 1) s = s.split(JP_TERMS[i][0]).join(JP_TERMS[i][1]);
    if (/[぀-ゟ゠-ヿ]/.test(s)) return "";
    return s;
  }

  function renderSituation(scene) {
    const s = scene || {};
    const round = s.round_wind || "";
    const seat = s.seat_wind || "";
    const desc = localizeScene(s.description);
    els.situation.innerHTML = '<span class="sb-label">场况</span>'
      + '<span class="meta-chip"><span class="wind">' + esc(round) + "</span>" + esc(s.round_number || "") + "局</span>"
      + '<span class="meta-chip"><span class="k">自风</span><span class="wind">' + esc(seat) + "</span></span>"
      + '<span class="meta-chip"><span class="k">第</span>' + esc(s.turn || "") + " 巡</span>"
      + (desc ? '<span class="meta-chip extra">' + esc(desc) + "</span>" : "");
  }

  function renderDora(value) {
    const indicators = PracticeTiles.parse(value);
    const slots = indicators.concat(new Array(Math.max(0, 5 - indicators.length)).fill("back")).slice(0, 5);
    els.dora.innerHTML = slots.map((code) => '<img src="' + PracticeTiles.src(code) + '" alt="' + esc(code) + '">').join("");
  }

  function meldHtml(meld, width) {
    const codes = PracticeTiles.parse(meld.mpsz || "");
    const tileWidth = Math.round(width * .82), tileHeight = Math.round(tileWidth * 446 / 320);
    let called = Number.isInteger(meld.called_index) ? meld.called_index : (meld.called_position === "left" ? 0 : meld.called_position === "right" ? codes.length - 1 : 1);
    called = Math.max(0, Math.min(codes.length - 1, called));
    const inner = codes.map((code, index) => index === called
      ? '<span class="meld-rot">' + rawTile(code) + "</span>"
      : '<span class="meld-up">' + rawTile(code) + "</span>").join("");
    return '<span class="meld" style="--tw:' + tileWidth + "px;--th:" + tileHeight + 'px">' + inner + "</span>";
  }

  function layoutHand() {
    if (!state.question) return;
    const render = state.question.render;
    const narrow = window.innerWidth <= 700;
    const drawGap = narrow ? 12 : 24, meldGap = narrow ? 13 : 32;
    const inner = Math.max(280, els.handArea.clientWidth - 6);
    const meldUnits = (render.melds || []).reduce((sum, meld) => sum + Math.max(3, PracticeTiles.parse(meld.mpsz).length) * .9, 0);
    const units = state.allTiles.length + meldUnits;
    const width = Math.max(18, Math.min(narrow ? 56 : 64, Math.floor((inner - drawGap - (render.melds.length ? meldGap : 0) - 12) / Math.max(1, units))));
    els.set.style.setProperty("--hw", width + "px");
    els.draw.style.setProperty("--hw", width + "px");
    els.draw.style.marginLeft = drawGap + "px";
    els.melds.style.marginLeft = render.melds.length ? meldGap + "px" : "0";
    els.melds.innerHTML = render.melds.map((meld) => meldHtml(meld, width)).join("");
  }

  function ankanKinds() {
    const counts = {};
    state.allTiles.forEach((code) => { const kind = baseKind(code); counts[kind] = (counts[kind] || 0) + 1; });
    return Object.keys(counts).filter((kind) => counts[kind] >= 4);
  }

  function tileButtons() { return Array.from(els.handWrap.querySelectorAll(".seltile")); }
  function selectedCode() { return state.selectedIndex < 0 ? null : state.allTiles[state.selectedIndex]; }

  function paint() {
    tileButtons().forEach((button) => button.classList.remove("sel", "dim", "kan-on", "answer-wrong", "answer-correct"));
    if (state.kan) {
      tileButtons().forEach((button) => button.classList.add(baseKind(state.allTiles[Number(button.dataset.index)]) === state.kanKind ? "kan-on" : "dim"));
    } else if (state.selectedIndex >= 0) {
      tileButtons().forEach((button) => {
        if (Number(button.dataset.index) === state.selectedIndex) button.classList.add("sel");
        else if (state.riichi) button.classList.add("dim");
      });
    } else if (state.riichi) {
      tileButtons().forEach((button) => { if (!state.validRiichi[Number(button.dataset.index)]) button.classList.add("dim"); });
    }
  }

  function updateSelection() {
    const code = selectedCode();
    if (state.kan) els.selection.innerHTML = state.kanKind ? "已选：<b>暗杠 " + tileName(state.kanKind) + "</b>" : "请选择要暗杠的牌组";
    else if (!code) els.selection.innerHTML = state.riichi ? "已选择<b>立直</b>，请选择有效切牌" : "请点击你要切的牌";
    else els.selection.innerHTML = "已选：<b>" + (state.riichi ? "立直 + 切 " : "切 ") + tileName(code) + "</b>";
    els.submit.disabled = state.feedback || state.submitting || (state.kan ? !state.kanKind : state.selectedIndex < 0);
  }

  function renderQuestion(question, suppressReady) {
    state.payload = null; state.question = question; state.feedback = null; state.selectedIndex = -1; state.riichi = false; state.kan = false; state.kanKind = null; state.submitting = false;
    const render = question.render;
    state.allTiles = PracticeTiles.parse(render.hand).concat(PracticeTiles.parse(render.draw));
    state.validRiichi = (!render.melds || !render.melds.length) ? validRiichiSet(state.allTiles) : {};
    els.roundLabel.textContent = "第 " + question.roundNumber + " 轮";
    els.sequenceTitle.textContent = "本轮第 " + question.sequence + " / " + question.totalQuestions + " 题";
    els.sourceNumber.hidden = true; els.feedback.hidden = true; els.next.hidden = true; els.submit.hidden = false;
    els.riichi.className = "decl-btn riichi-btn"; els.kan.className = "decl-btn kan-btn";
    els.riichi.disabled = false; els.kan.disabled = false;   // 修复：提交反馈后被禁用，下一题必须重新启用，否则立直/暗杠点不动
    renderSituation(render.scene); renderDora(render.doraIndicators);
    const concealed = PracticeTiles.parse(render.hand), draw = PracticeTiles.parse(render.draw);
    els.set.innerHTML = concealed.map((code, index) => '<button class="seltile" data-index="' + index + '" type="button" aria-label="' + esc(code) + '">' + rawTile(code) + "</button>").join("");
    els.draw.innerHTML = draw.map((code, offset) => '<button class="seltile" data-index="' + (concealed.length + offset) + '" type="button" aria-label="' + esc(code) + '">' + rawTile(code) + "</button>").join("");
    const canRiichi = Object.keys(state.validRiichi).length > 0;
    const kinds = ankanKinds();
    els.riichi.hidden = !canRiichi; els.kan.hidden = !kinds.length; els.declare.hidden = !canRiichi && !kinds.length;
    paint(); updateSelection(); setMessage(""); show("questionView"); layoutHand();
    if (suppressReady) return;
    beginTiming(question);
    const images = Array.from(els.questionView ? els.questionView.querySelectorAll("img") : document.querySelectorAll("#questionView img"));
    Promise.all(images.map((image) => image.complete ? Promise.resolve() : new Promise((resolve) => { image.addEventListener("load", resolve, { once: true }); image.addEventListener("error", resolve, { once: true }); }))).then(async () => {
      if (!state.timing || state.question !== question) return;
      state.timing.readyAt = new Date().toISOString();
      state.timing.loadTimeMs = timingNow() - state.timing.loadStarted;
      els.saveState.textContent = "进度已保存";
      await api("/api/practice/assignments/" + question.assignmentId + "/ready", { method: "POST", body: { sessionId: state.sessionId, timing: timingSnapshot() } }).catch(() => { els.saveState.textContent = "等待网络恢复"; });
    });
  }

  function answerText(answer) {
    if (answer.action === "ankan") return "暗杠 " + tileName(answer.tile);
    if (answer.riichi) return "立直 + 切 " + tileName(answer.tile);
    return "切 " + tileName(answer.tile);
  }

  function semanticResponse() {
    return state.kan
      ? { action: "ankan", tile: state.kanKind, riichi: false }
      : { action: "discard", tile: selectedCode(), riichi: state.riichi };
  }

  function applyFeedback(payload) {
    state.feedback = payload; state.submitting = false;
    if (!state.question || state.question.assignmentId !== payload.assignmentId) {
      state.question = { assignmentId: payload.assignmentId, roundNumber: payload.roundNumber, sequence: payload.sequence, totalQuestions: payload.totalQuestions, render: payload.render };
      state.allTiles = PracticeTiles.parse(payload.render.hand).concat(PracticeTiles.parse(payload.render.draw));
      state.validRiichi = (!payload.render.melds || !payload.render.melds.length) ? validRiichiSet(state.allTiles) : {};
      renderQuestion(state.question, true);
      state.feedback = payload;
    }
    if (state.tickTimer) clearInterval(state.tickTimer);
    tileButtons().forEach((button) => { button.disabled = true; button.classList.remove("sel", "dim", "kan-on"); });
    els.riichi.disabled = true; els.kan.disabled = true;
    const selected = payload.selectedAnswer, correct = payload.correctAnswer;
    const buttons = tileButtons();
    if (!payload.correct && selected.action === "discard") {
      let index = state.selectedIndex;
      if (index < 0 || state.allTiles[index] !== selected.tile) index = state.allTiles.indexOf(selected.tile);
      if (index >= 0) buttons[index].classList.add("answer-wrong");
    }
    if (selected.action === "ankan" && !payload.correct) {
      buttons.forEach((button, index) => { if (baseKind(state.allTiles[index]) === selected.tile) button.classList.add("answer-wrong"); });
      els.kan.classList.add("answer-wrong");
    }
    if (correct.action === "discard") {
      buttons.forEach((button, index) => { if (state.allTiles[index] === correct.tile) button.classList.add("answer-correct"); });
    } else {
      buttons.forEach((button, index) => { if (baseKind(state.allTiles[index]) === correct.tile) button.classList.add("answer-correct"); });
      els.kan.hidden = false; els.declare.hidden = false; els.kan.classList.add("answer-correct");
    }
    if (selected.riichi && (!payload.correct || !correct.riichi)) { els.riichi.hidden = false; els.declare.hidden = false; els.riichi.classList.add("answer-wrong"); }
    if (correct.riichi) { els.riichi.hidden = false; els.declare.hidden = false; els.riichi.classList.add("answer-correct"); }
    els.sourceNumber.querySelector("strong").textContent = payload.sourceNumber;
    els.sourceNumber.hidden = false;
    els.verdict.textContent = payload.correct ? "✓ 回答正确" : "× 回答错误";
    els.verdict.className = "feedback-verdict " + (payload.correct ? "good" : "bad");
    els.selectedText.textContent = answerText(selected);
    els.correctText.textContent = answerText(correct);
    els.feedback.classList.toggle("is-correct", Boolean(payload.correct));
    els.feedback.hidden = false; els.submit.hidden = true; els.next.hidden = false;
    els.selection.textContent = "答案已经提交，不能修改。";
    renderStats(payload.stats, payload.ranking); renderRanking(payload.ranking); show("questionView");
  }

  function renderComplete(payload) {
    state.payload = payload; state.question = null; state.feedback = null;
    if (state.tickTimer) clearInterval(state.tickTimer);
    const round = payload.lastRoundNumber || (payload.stats && payload.stats.roundNumber) || 1;
    els.completeTitle.textContent = "第 " + round + " 轮已经完成";
    els.completeSummary.textContent = "累计作答 " + payload.stats.lifetimeAnswered + " 题，正确率 " + payload.stats.accuracy.toFixed(2).replace(/\.00$/, "") + "% 。";
    els.nextRound.textContent = "开始第 " + (round + 1) + " 轮";
    renderStats(payload.stats, payload.ranking); renderRanking(payload.ranking); show("completeView");
  }

  async function handlePayload(payload) {
    state.payload = payload;
    if (payload.idleThresholdMs) state.idleThresholdMs = payload.idleThresholdMs;
    renderStats(payload.stats, payload.ranking); renderRanking(payload.ranking);
    if (payload.status === "question") return renderQuestion(payload.question);
    if (payload.status === "feedback") return applyFeedback(payload);
    if (payload.status === "round_complete") return renderComplete(payload);
    const bankName = payload.stats && payload.stats.bankName ? payload.stats.bankName : "练习题库";
    els.introTitle.textContent = payload.lastRoundNumber ? "开始下一轮 " + bankName : "开始 " + bankName + " 首轮练习";
    els.start.textContent = payload.lastRoundNumber ? "开始第 " + (payload.lastRoundNumber + 1) + " 轮" : "开始练习";
    show("introView");
  }

  async function createSession() {
    const client = {
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ""; } })(),
      languages: navigator.languages || [], platform: navigator.platform || "",
      viewport: [window.innerWidth, window.innerHeight], screen: [screen.width, screen.height],
      dpr: window.devicePixelRatio || 1, touch: navigator.maxTouchPoints || 0,
    };
    const result = await api("/api/practice/session", { method: "POST", body: client });
    state.sessionId = result.sessionId;
  }

  els.handWrap.addEventListener("click", function (event) {
    if (state.feedback) return;
    const button = event.target.closest(".seltile");
    if (!button) return;
    const index = Number(button.dataset.index), code = state.allTiles[index];
    markInteraction("tile");
    if (state.kan) {
      if (ankanKinds().includes(baseKind(code))) state.kanKind = baseKind(code);
    } else if (!state.riichi || state.validRiichi[index]) {
      state.selectedIndex = state.selectedIndex === index ? -1 : index;
    }
    paint(); updateSelection();
  });

  els.riichi.addEventListener("click", function () {
    if (state.feedback) return;
    markInteraction("riichi");
    state.kan = false; state.kanKind = null; els.kan.classList.remove("is-on");
    state.riichi = !state.riichi; els.riichi.classList.toggle("is-on", state.riichi);
    if (state.riichi && state.selectedIndex >= 0 && !state.validRiichi[state.selectedIndex]) state.selectedIndex = -1;
    paint(); updateSelection();
  });

  els.kan.addEventListener("click", function () {
    if (state.feedback) return;
    markInteraction("ankan");
    state.kan = !state.kan; state.selectedIndex = -1; state.riichi = false; els.riichi.classList.remove("is-on");
    const kinds = ankanKinds(); state.kanKind = state.kan && kinds.length === 1 ? kinds[0] : null;
    els.kan.classList.toggle("is-on", state.kan); paint(); updateSelection();
  });

  els.submit.addEventListener("click", async function () {
    if (els.submit.disabled || state.submitting || state.feedback) return;
    state.submitting = true; els.submit.disabled = true; markInteraction("submit"); setMessage("正在提交…");
    try {
      const payload = await api("/api/practice/assignments/" + state.question.assignmentId + "/answer", {
        method: "POST",
        body: { response: semanticResponse(), sessionId: state.sessionId, submissionId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), timing: timingSnapshot() },
      });
      setMessage(""); applyFeedback(payload);
    } catch (error) {
      state.submitting = false; updateSelection(); setMessage(error.message, true);
    }
  });

  els.next.addEventListener("click", async function () {
    if (!state.feedback) return;
    els.next.disabled = true; setMessage("正在准备下一题…");
    try {
      const payload = await api("/api/practice/assignments/" + state.feedback.assignmentId + "/next", { method: "POST", body: {} });
      els.next.disabled = false; setMessage(""); await handlePayload(payload);
    } catch (error) { els.next.disabled = false; setMessage(error.message, true); }
  });

  async function startRound() {
    els.start.disabled = true; els.nextRound.disabled = true; els.introMessage.textContent = "正在生成随机题序…";
    try {
      const payload = await api("/api/practice/start", { method: "POST", body: {} });
      await createSession();
      els.start.disabled = false; els.nextRound.disabled = false; els.introMessage.textContent = "";
      await handlePayload(payload);
    } catch (error) {
      els.start.disabled = false; els.nextRound.disabled = false; els.introMessage.textContent = error.message; els.introMessage.classList.add("is-error");
    }
  }
  els.start.addEventListener("click", startRound);
  els.nextRound.addEventListener("click", startRound);

  els.refreshBoard.addEventListener("click", async function () {
    els.refreshBoard.disabled = true;
    try { const ranking = await api("/api/practice/leaderboard?top=20", { method: "GET" }); renderRanking(ranking); if (state.payload && state.payload.stats) renderStats(state.payload.stats, ranking); }
    finally { els.refreshBoard.disabled = false; }
  });

  window.addEventListener("resize", layoutHand);
  state.activityTimer = setInterval(() => flushActivity(false), 30000);
  state.sessionTimer = setInterval(() => {
    if (!state.sessionId) return;
    api("/api/practice/session/" + state.sessionId + "/ping", { method: "POST", body: { at: new Date().toISOString(), visible: document.visibilityState === "visible" } }).catch(() => {});
  }, 60000);

  (async function init() {
    try {
      state.me = await api("/api/user/me", { method: "GET" });
      state.csrf = state.me.csrf; els.nickname.textContent = state.me.displayNickname;
      const payload = await api("/api/practice/status", { method: "GET" });
      if (payload.status === "question" || payload.status === "feedback") await createSession();
      await handlePayload(payload);
    } catch (error) {
      show("introView"); els.introTitle.textContent = "练习载入失败"; els.introMessage.textContent = error.message; els.introMessage.classList.add("is-error"); els.start.hidden = true;
    }
  })();
})();
