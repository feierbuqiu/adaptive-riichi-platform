(function () {
  const state = {
    csrf: "",
    remainingAttempts: 0,
    maxAttempts: 2,
    sampleStatus: "not_started",
    nickname: null,
    defaultNickname: "逍遥雀士",
    nicknameReviewRemaining: 2,
    nicknameReviewLocked: false,
    hasResult: false,
    activeAttemptId: null,
    attemptId: null,
    sample: null,
    sampleSelected: null,
    question: null,
    selected: null,
    timer: null,
    submitting: false,
    board: null,
    lastResult: null,
    shareObjectUrl: null,
    pendingConfirm: null,
    appealAvailable: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const els = {
    screens: ["blockedBrowserView", "homeView", "sampleView", "testView", "resultView", "leaderboardView"].reduce((m, idd) => {
      m[idd] = $("#" + idd);
      return m;
    }, {}),
    remainBadge: $("#remainBadge"),
    startBtn: $("#startBtn"),
    toBoardBtn: $("#toBoardBtn"),
    homeNote: $("#homeNote"),
    appealBtn: $("#appealBtn"),
    homeStanding: $("#homeStanding"),
    homeBoard: $("#homeBoard"),
    homeBoardMeta: $("#homeBoardMeta"),
    homeBoardMore: $("#homeBoardMore"),
    homeDist: $("#homeDist"),
    sampleTitle: $("#sampleTitle"),
    sampleImage: $("#sampleImage"),
    sampleOptions: $("#sampleOptions"),
    sampleFeedback: $("#sampleFeedback"),
    sampleBackBtn: $("#sampleBackBtn"),
    sampleSubmitBtn: $("#sampleSubmitBtn"),
    sampleSolutionBtn: $("#sampleSolutionBtn"),
    sampleConfirmBtn: $("#sampleConfirmBtn"),
    sampleHomeBtn: $("#sampleHomeBtn"),
    questionTitle: $("#questionTitle"),
    questionImage: $("#questionImage"),
    optionGrid: $("#optionGrid"),
    submitBtn: $("#submitBtn"),
    finishBtn: $("#finishBtn"),
    timerValue: $("#timerValue"),
    timerBar: $("#timerBar"),
    timerBox: $("#timerBox"),
    timerRing: $("#timerRing"),
    loadingMsg: $("#loadingMsg"),
    tierBadge: $("#tierBadge"),
    abilityIndex: $("#abilityIndex"),
    rankLabel: $("#rankLabel"),
    resultMessage: $("#resultMessage"),
    practiceNote: $("#practiceNote"),
    resultDist: $("#resultDist"),
    nicknameInput: $("#nicknameInput"),
    nicknameSaveBtn: $("#nicknameSaveBtn"),
    nicknameMsg: $("#nicknameMsg"),
    genShareBtn: $("#genShareBtn"),
    shareWrap: $(".share-wrap"),
    shareImg: $("#shareImg"),
    downloadShareBtn: $("#downloadShareBtn"),
    retakeBtn: $("#retakeBtn"),
    resultBoardBtn: $("#resultBoardBtn"),
    resultNote: $("#resultNote"),
    boardBackBtn: $("#boardBackBtn"),
    fullBoard: $("#fullBoard"),
    fullBoardMeta: $("#fullBoardMeta"),
    fullStanding: $("#fullStanding"),
    confirmModal: $("#confirmModal"),
    confirmStartBtn: $("#confirmStartBtn"),
    confirmCancelBtn: $("#confirmCancelBtn"),
  };

  function show(view) {
    for (const key of Object.keys(els.screens)) els.screens[key].classList.remove("is-active");
    els.screens[view].classList.add("is-active");
    window.scrollTo(0, 0);
  }

  function isTencentMobileBrowser() {
    const ua = navigator.userAgent || "";
    const lower = ua.toLowerCase();
    const mobile = /android|iphone|ipad|ipod|mobile/.test(lower);
    const wechat = lower.includes("micromessenger");
    const qqBrowser = lower.includes("mqqbrowser") || lower.includes("qqbrowser");
    const qqInApp = /(?:^|\s)qq\/[\d.]+/i.test(ua) || lower.includes(" qzone/");
    return mobile && (wechat || qqBrowser || qqInApp);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (state.csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrf;
    const res = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers,
      body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(data.error || "请求失败");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    if (data.csrf) state.csrf = data.csrf;
    return data;
  }

  function setMessage(el, text, kind = "") {
    el.textContent = text || "";
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-ok", kind === "ok");
  }

  function tierClass(tier) {
    const map = { "见习": "t0", "初心": "t1", "雀士": "t2", "雀杰": "t3", "雀豪": "t4", "雀圣": "t5", "魂天": "t6" };
    return map[tier] || "t0";
  }

  function clearTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function preloadImage(src, retry = true, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        img.onload = null;
        img.onerror = null;
        if (!retry) {
          done(reject, new Error("image load timeout"));
          return;
        }
        const retrySrc = src.includes("?") ? `${src}&retry=1` : `${src}?retry=1`;
        preloadImage(retrySrc, false, timeoutMs).then((loaded) => done(resolve, loaded)).catch((err) => done(reject, err));
      }, timeoutMs);
      img.onload = () => done(resolve, img.src);
      img.onerror = () => {
        if (!retry) { done(reject, new Error("image load failed")); return; }
        const retrySrc = src.includes("?") ? `${src}&retry=1` : `${src}?retry=1`;
        preloadImage(retrySrc, false, timeoutMs).then((loaded) => done(resolve, loaded)).catch((err) => done(reject, err));
      };
      img.src = src;
    });
  }

  function renderDist(container, distribution, highlightIdx) {
    container.innerHTML = "";
    const max = Math.max(1, ...distribution);
    distribution.forEach((count, i) => {
      const bar = document.createElement("div");
      bar.className = "dist-bar" + (i === highlightIdx ? " is-you" : "");
      bar.style.height = `${Math.round((count / max) * 100)}%`;
      bar.title = `${i * 10}-${i * 10 + 9}: ${count} 人`;
      container.appendChild(bar);
    });
  }

  // ---------- bootstrap & home ----------

  async function refreshMe() {
    const me = await api("/api/user/me");
    state.csrf = me.csrf || state.csrf;
    state.remainingAttempts = me.remainingAttempts;
    state.maxAttempts = me.maxAttempts;
    state.sampleStatus = me.sampleStatus;
    state.nickname = me.nickname;
    state.defaultNickname = me.defaultNickname || state.defaultNickname;
    state.nicknameReviewRemaining = me.nicknameReviewRemaining == null ? state.nicknameReviewRemaining : me.nicknameReviewRemaining;
    state.nicknameReviewLocked = Boolean(me.nicknameReviewLocked);
    state.hasResult = me.hasResult;
    state.activeAttemptId = me.activeAttemptId;
    return me;
  }

  async function loadBoard(topN) {
    const data = await api(`/api/leaderboard${topN ? `?top=${topN}` : ""}`);
    state.board = data;
    return data;
  }

  function boardRow(entry, youBoardRank) {
    const row = document.createElement("div");
    row.className = "board-row" + (youBoardRank && entry.rank === youBoardRank ? " is-you" : "");
    const rank = document.createElement("span");
    rank.className = "br-rank" + (entry.rank <= 3 ? ` top${entry.rank}` : "");
    rank.textContent = String(entry.rank);
    const name = document.createElement("span");
    name.className = "br-name";
    name.textContent = entry.nickname || "匿名玩家";
    name.textContent = entry.nickname || state.defaultNickname;
    const tier = document.createElement("span");
    tier.className = `br-tier ${tierClass(entry.tier)}`;
    tier.textContent = entry.tier;
    const score = document.createElement("span");
    score.className = "br-score";
    score.textContent = String(entry.abilityIndex);
    row.append(rank, name, tier, score);
    return row;
  }

  function renderStanding(panel, board) {
    const you = board.you;
    if (!you || !you.hasResult || you.abilityIndex == null) { panel.hidden = true; return; }
    panel.hidden = false;
    panel.innerHTML = "";
    const title = document.createElement("p");
    title.className = "standing-title";
    title.textContent = "我的成绩";
    const line = document.createElement("p");
    line.className = "standing-line";
    const tierSpan = document.createElement("span");
    tierSpan.className = `br-tier ${tierClass(you.tier)}`;
    tierSpan.textContent = you.tier || "见习";
    line.append("能力指数 ", strong(String(you.abilityIndex)), "　", tierSpan);
    panel.append(title, line);
    const rankLine = document.createElement("p");
    rankLine.className = "standing-sub";
    if (you.onBoard && you.boardRank) rankLine.textContent = `排行榜第 ${you.boardRank} 名` + (you.percentile != null ? ` · 超过约 ${you.percentile}% 的测试者` : "");
    else if (you.percentile != null) rankLine.textContent = `超过约 ${you.percentile}% 的测试者`;
    else rankLine.textContent = "有效作答不足，暂未进入排行榜";
    panel.append(rankLine);
  }

  function strong(t) { const s = document.createElement("strong"); s.textContent = t; return s; }

  function setAppealVisible(visible) {
    state.appealAvailable = Boolean(visible);
    if (!els.appealBtn) return;
    els.appealBtn.hidden = !state.appealAvailable;
    els.appealBtn.setAttribute("aria-hidden", state.appealAvailable ? "false" : "true");
    els.appealBtn.disabled = false;
  }

  async function renderHome() {
    setAppealVisible(state.appealAvailable);
    els.remainBadge.textContent = `共 ${state.maxAttempts} 次 · 剩 ${state.remainingAttempts} 次`;
    if (state.activeAttemptId) {
      els.startBtn.textContent = "继续未完成的测试";
      els.startBtn.disabled = false;
      els.homeNote.textContent = "你有一场未完成的测试，可继续作答。";
    } else if (state.remainingAttempts <= 0) {
      els.startBtn.textContent = "机会已用完";
      els.startBtn.disabled = true;
      els.homeNote.textContent = "你已用完全部作答机会，无法再作答，但可以查看排行榜与自己的成绩。";
    } else {
      els.startBtn.textContent = state.hasResult ? `再测一次（剩 ${state.remainingAttempts} 次）` : "开始测试";
      els.startBtn.disabled = false;
      els.homeNote.textContent = state.hasResult ? "再次作答不会降低你已计入排行榜的首次成绩。" : "";
    }

    try {
      const board = await loadBoard(10);
      renderStanding(els.homeStanding, board);
      els.homeBoard.innerHTML = "";
      if (!board.top.length) {
        const empty = document.createElement("p");
        empty.className = "muted-line";
        empty.textContent = "还没有人上榜，快来成为第一名！";
        els.homeBoard.appendChild(empty);
      } else {
        const yr = board.you && board.you.boardRank;
        board.top.forEach((e) => els.homeBoard.appendChild(boardRow(e, yr)));
      }
      els.homeBoardMeta.textContent = `已上榜 ${board.totalRanked} 人 · 累计参与 ${board.totalParticipants} 人`;
      renderDist(els.homeDist, board.distribution, -1);
    } catch { /* board is non-critical */ }
    show("homeView");
  }

  // ---------- sample ----------

  async function loadSample() {
    const sample = await api("/api/sample");
    state.sample = sample;
    state.sampleSelected = null;
    renderSample(sample.solution && sample.solution.available ? "solution" : "question");
    show("sampleView");
  }

  function renderSample(mode) {
    const sample = state.sample;
    const solutionAvailable = Boolean(sample.solution && sample.solution.available);
    const showingSolution = mode === "solution" && solutionAvailable;
    els.sampleTitle.textContent = showingSolution ? "样题解答" : "请先完成样题";
    els.sampleImage.src = showingSolution ? sample.solution.imageUrl : sample.question.imageUrl;
    els.sampleOptions.innerHTML = "";
    els.sampleFeedback.style.display = "none";

    if (!showingSolution) {
      sample.question.options.forEach((label, idx) => {
        const btn = document.createElement("button");
        btn.className = "option-btn";
        btn.type = "button";
        btn.textContent = label;
        btn.disabled = !sample.question.ready;
        btn.addEventListener("click", () => {
          state.sampleSelected = idx;
          for (const child of els.sampleOptions.children) child.classList.remove("is-selected");
          btn.classList.add("is-selected");
          els.sampleSubmitBtn.disabled = false;
        });
        els.sampleOptions.appendChild(btn);
      });
    }

    if (["answered", "solution_seen", "confirmed"].includes(sample.sampleStatus)) {
      els.sampleFeedback.style.display = "block";
      els.sampleFeedback.className = `feedback ${sample.isCorrect ? "is-good" : "is-bad"}`;
      els.sampleFeedback.textContent = sample.isCorrect
        ? `样题选择正确。正确答案：${sample.correctAnswer}`
        : `样题选择不正确。正确答案：${sample.correctAnswer}`;
    }

    els.sampleBackBtn.style.display = solutionAvailable ? "inline-flex" : "none";
    els.sampleSolutionBtn.style.display = solutionAvailable && !showingSolution ? "inline-flex" : "none";
    els.sampleConfirmBtn.style.display = solutionAvailable ? "inline-flex" : "none";
    els.sampleSubmitBtn.style.display = showingSolution ? "none" : "inline-flex";
    els.sampleSubmitBtn.disabled = state.sampleSelected == null;
  }

  async function submitSample() {
    if (state.sampleSelected == null) return;
    const result = await api("/api/sample/answer", { method: "POST", body: { selectedIndex: state.sampleSelected } });
    state.sample = result;
    renderSample("solution");
  }

  async function confirmSample() {
    await api("/api/sample/confirm", { method: "POST", body: {} });
    state.sampleStatus = "confirmed";
    openConfirm(startAttempt);
  }

  // ---------- confirm modal ----------

  function openConfirm(action) {
    state.pendingConfirm = action;
    els.confirmModal.hidden = false;
  }
  function closeConfirm() {
    els.confirmModal.hidden = true;
    state.pendingConfirm = null;
  }

  // ---------- attempt ----------

  async function onStartClick() {
    if (state.activeAttemptId) {
      const current = await api(`/api/attempts/${state.activeAttemptId}/current`);
      state.attemptId = state.activeAttemptId;
      handleAttemptResponse(current);
      return;
    }
    if (state.remainingAttempts <= 0) return;
    if (state.sampleStatus !== "confirmed") { await loadSample(); return; }
    openConfirm(startAttempt);
  }

  async function startAttempt() {
    closeConfirm();
    clearTimer();
    setAppealVisible(false);
    try {
      const res = await api("/api/attempts/start", { method: "POST", body: {} });
      handleAttemptResponse(res);
    } catch (err) {
      await refreshMe();
      await renderHome();
      els.homeNote.textContent = err.message || "无法开始测试。";
      if (err.data && err.data.appealAvailable) {
        setAppealVisible(true);
      }
    }
  }

  async function submitAppeal() {
    if (!state.appealAvailable) return;
    els.appealBtn.disabled = true;
    try {
      const res = await api("/api/appeals", { method: "POST", body: { message: "用户请求人工复核同一性拦截。" } });
      els.homeNote.textContent = res.message || "已提交复核请求。";
      setAppealVisible(false);
    } catch (err) {
      els.homeNote.textContent = err.message || "复核请求提交失败。";
      els.appealBtn.disabled = false;
    }
  }

  function renderOptions(container, options, enabled, onPick) {
    container.innerHTML = "";
    options.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-btn";
      btn.textContent = label;
      btn.disabled = !enabled;
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        for (const child of container.children) child.classList.remove("is-selected");
        btn.classList.add("is-selected");
        onPick(idx);
      });
      container.appendChild(btn);
    });
  }

  function setQuestionEnabled(enabled) {
    for (const btn of els.optionGrid.children) btn.disabled = !enabled;
    els.submitBtn.disabled = !enabled || state.selected == null || state.submitting;
    els.finishBtn.disabled = !enabled || state.submitting;
  }

  async function prepareQuestion(question) {
    clearTimer();
    state.question = question;
    state.selected = null;
    state.submitting = false;
    els.questionTitle.textContent = `第 ${question.sequence} 题`;
    els.timerValue.textContent = "--";
    els.timerBar.style.width = "0%";
    els.loadingMsg.textContent = "正在准备题目，计时尚未开始。";
    els.questionImage.removeAttribute("src");
    renderOptions(els.optionGrid, question.options, false, (idx) => {
      state.selected = idx;
      els.submitBtn.disabled = false;
    });
    setQuestionEnabled(false);
    show("testView");

    try {
      const loadedImageUrl = await preloadImage(question.imageUrl, true);
      els.questionImage.src = loadedImageUrl;
    } catch {
      els.loadingMsg.textContent = "题目图片加载失败，系统正在处理，本次技术问题不会消耗作答次数。";
      const failed = await api(`/api/attempts/${state.attemptId}/items/${question.attemptItemId}/load-failed`, { method: "POST", body: {} });
      handleAttemptResponse(failed);
      return;
    }

    let readyQuestion = question;
    if (!question.ready) {
      const ready = await api(`/api/attempts/${state.attemptId}/items/${question.attemptItemId}/ready`, { method: "POST", body: {} });
      readyQuestion = ready.question;
    }
    state.question = readyQuestion;
    els.loadingMsg.textContent = "";
    setQuestionEnabled(true);
    startTimer(readyQuestion.expiresAt);
  }

  function startTimer(expiresAt) {
    clearTimer();
    const end = new Date(expiresAt).getTime();
    const total = 70000;
    const tick = () => {
      const remainingMs = Math.max(0, end - Date.now());
      const remaining = Math.ceil(remainingMs / 1000);
      els.timerValue.textContent = String(remaining);
      if (els.timerBox) {
        els.timerBox.classList.toggle("is-warning", remaining <= 15 && remaining > 5);
        els.timerBox.classList.toggle("is-critical", remaining <= 5);
      }
      if (els.timerBar) els.timerBar.style.width = `${Math.max(0, Math.min(100, (remainingMs / total) * 100))}%`;
      if (els.timerRing) els.timerRing.style.strokeDashoffset = (276.46 * (1 - Math.max(0, Math.min(1, remainingMs / total)))).toFixed(2);
      if (remainingMs <= 0) { clearTimer(); submitTimeout(); }
    };
    tick();
    state.timer = setInterval(tick, 250);
  }

  async function submitAnswer() {
    if (state.selected == null || !state.question || state.submitting) return;
    state.submitting = true;
    setQuestionEnabled(false);
    clearTimer();
    els.loadingMsg.textContent = "正在提交并准备下一题，计时尚未开始。";
    const res = await api(`/api/attempts/${state.attemptId}/answer`, {
      method: "POST",
      body: { attemptItemId: state.question.attemptItemId, selectedIndex: state.selected },
    });
    handleAttemptResponse(res);
  }

  async function submitTimeout() {
    if (!state.question || state.submitting) return;
    state.submitting = true;
    setQuestionEnabled(false);
    els.loadingMsg.textContent = "时间到，正在进入下一题。";
    const res = await api(`/api/attempts/${state.attemptId}/timeout`, {
      method: "POST",
      body: { attemptItemId: state.question.attemptItemId },
    });
    handleAttemptResponse(res);
  }

  async function finishAttempt() {
    if (!state.attemptId) return;
    if (!window.confirm("确认提前交卷吗？提交后不能返回继续作答。")) return;
    clearTimer();
    const res = await api(`/api/attempts/${state.attemptId}/finish`, { method: "POST", body: {} });
    handleAttemptResponse(res);
  }

  // ---------- result ----------

  function animateScore(target) {
    const el = els.abilityIndex;
    if (typeof target !== "number") { el.textContent = String(target); return; }
    const start = performance.now();
    const dur = 800;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * eased));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = String(target);
    };
    requestAnimationFrame(step);
  }

  function fireConfetti() {
    try {
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const wrap = document.createElement("div");
      wrap.className = "confetti";
      const colors = ["#1f7a63", "#b8842e", "#a6433f", "#3aa183", "#e0b35a", "#6fd3b4", "#d98b5f"];
      for (let i = 0; i < 90; i++) {
        const p = document.createElement("i");
        const sz = (6 + Math.random() * 8).toFixed(0) + "px";
        p.style.left = (Math.random() * 100).toFixed(2) + "vw";
        p.style.width = sz; p.style.height = sz;
        p.style.background = colors[i % colors.length];
        p.style.animationDelay = (Math.random() * 0.5).toFixed(2) + "s";
        p.style.animationDuration = (2 + Math.random() * 1.6).toFixed(2) + "s";
        p.style.setProperty("--rot", (Math.random() * 720 - 360).toFixed(0) + "deg");
        wrap.appendChild(p);
      }
      document.body.appendChild(wrap);
      setTimeout(() => wrap.remove(), 4500);
    } catch (e) { /* noop */ }
  }

  async function renderResult(result) {
    clearTimer();
    state.lastResult = result;
    await refreshMe();

    const tier = result.tier || result.level || "见习";
    els.tierBadge.textContent = tier;
    els.tierBadge.className = `tier-badge ${tierClass(tier)}`;
    if (tier === "雀圣" || tier === "魂天") fireConfetti();
    animateScore(typeof result.abilityIndex === "number" ? result.abilityIndex : result.abilityIndex);
    els.rankLabel.textContent = result.rank || "";
    els.resultMessage.textContent = result.message || "";

    if (result.isPractice) {
      els.practiceNote.hidden = false;
      els.practiceNote.textContent = `本次为练习成绩（能力指数 ${result.practiceAbilityIndex} · ${result.practiceTier}），排行榜以你的首次成绩为准。`;
    } else {
      els.practiceNote.hidden = true;
    }

    // distribution with marker
    try {
      const board = state.board || await loadBoard(10);
      const idx = typeof result.abilityIndex === "number" ? result.abilityIndex : 0;
      renderDist(els.resultDist, board.distribution, Math.max(0, Math.min(9, Math.floor(idx / 10))));
    } catch { /* non-critical */ }

    // nickname
    els.nicknameInput.value = state.nickname || "";
    els.nicknameInput.disabled = state.nicknameReviewLocked;
    els.nicknameSaveBtn.disabled = state.nicknameReviewLocked;
    setMessage(els.nicknameMsg, "");

    // share
    if (state.shareObjectUrl) URL.revokeObjectURL(state.shareObjectUrl);
    state.shareObjectUrl = null;
    els.shareWrap.classList.remove("has-preview");
    els.shareImg.removeAttribute("src");
    els.shareImg.hidden = true;
    els.downloadShareBtn.removeAttribute("href");
    els.downloadShareBtn.hidden = true;

    // retake / note
    if (state.remainingAttempts > 0) {
      els.retakeBtn.disabled = false;
      els.retakeBtn.textContent = `再来一次（剩 ${state.remainingAttempts} 次）`;
      els.resultNote.textContent = "再次作答不会降低你已计入排行榜的首次成绩。";
    } else {
      els.retakeBtn.disabled = true;
      els.retakeBtn.textContent = "机会已用完";
      els.resultNote.textContent = "你已用完全部作答机会，只能查看排行榜与自己的成绩。";
    }

    show("resultView");
  }

  async function saveNickname() {
    const value = els.nicknameInput.value.trim();
    try {
      const res = await api("/api/user/nickname", { method: "POST", body: { nickname: value } });
      state.nickname = res.nickname;
      setMessage(els.nicknameMsg, res.nickname ? "已保存，排行榜将显示该昵称。" : "已设为匿名。", "ok");
      state.board = null; // force reload next time
    } catch (err) {
      setMessage(els.nicknameMsg, err.message, "error");
    }
  }

  async function saveNickname() {
    const value = els.nicknameInput.value.trim();
    if (state.nicknameReviewLocked) {
      setMessage(els.nicknameMsg, `名称暂时无法修改，已为你使用默认名称“${state.defaultNickname}”。`, "error");
      els.nicknameInput.disabled = true;
      els.nicknameSaveBtn.disabled = true;
      return;
    }
    els.nicknameInput.disabled = true;
    els.nicknameSaveBtn.disabled = true;
    const oldText = els.nicknameSaveBtn.textContent;
    els.nicknameSaveBtn.textContent = "名称保存中…";
    setMessage(els.nicknameMsg, "名称保存中…");
    try {
      const res = await api("/api/user/nickname", { method: "POST", body: { nickname: value } });
      state.nickname = res.nickname || null;
      state.defaultNickname = res.defaultNickname || state.defaultNickname;
      state.nicknameReviewRemaining = res.nicknameReviewRemaining == null ? state.nicknameReviewRemaining : res.nicknameReviewRemaining;
      state.nicknameReviewLocked = Boolean(res.nicknameReviewLocked || res.locked);
      if (res.ok && res.approved) {
        setMessage(els.nicknameMsg, "名称已保存，将显示在排行榜。", "ok");
      } else if (res.ok) {
        setMessage(els.nicknameMsg, "已设为匿名。", "ok");
      } else {
        setMessage(els.nicknameMsg, res.message || "哎呀，这个名字暂时用不了，换一个试试吧～", "error");
      }
      els.nicknameInput.value = state.nickname || "";
      state.board = null;
    } catch (err) {
      setMessage(els.nicknameMsg, err.message, "error");
    } finally {
      els.nicknameSaveBtn.textContent = oldText;
      if (state.nicknameReviewLocked) {
        els.nicknameInput.disabled = true;
        els.nicknameSaveBtn.disabled = true;
      } else {
        els.nicknameInput.disabled = false;
        els.nicknameSaveBtn.disabled = false;
      }
    }
  }

  function canvasToPngUrl(canvas) {
    return new Promise((resolve) => {
      if (!canvas.toBlob) {
        resolve(canvas.toDataURL("image/png"));
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          resolve(canvas.toDataURL("image/png"));
          return;
        }
        resolve(URL.createObjectURL(blob));
      }, "image/png");
    });
  }

  async function generateShareCard() {
    const r = state.lastResult || {};
    const size = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, "#0f5665");
    grad.addColorStop(1, "#187083");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(70, 70, size - 140, size - 140);

    const cx = size / 2;
    ctx.textAlign = "center";
    ctx.fillStyle = "#dff1f5";
    ctx.font = "600 40px system-ui, 'Microsoft YaHei', 'PingFang SC', sans-serif";
    ctx.fillText("立直麻将牌效率测试", cx, 220);

    const nick = state.nickname || state.defaultNickname;
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 64px system-ui, 'Microsoft YaHei', 'PingFang SC', sans-serif";
    ctx.fillText(nick, cx, 330);

    ctx.fillStyle = "#ffd66b";
    ctx.font = "900 140px system-ui, 'Microsoft YaHei', 'PingFang SC', sans-serif";
    ctx.fillText(r.tier || "见习", cx, 540);

    ctx.fillStyle = "#ffffff";
    ctx.font = "900 240px system-ui, sans-serif";
    ctx.fillText(String(typeof r.abilityIndex === "number" ? r.abilityIndex : 0), cx, 780);
    ctx.fillStyle = "#dff1f5";
    ctx.font = "600 40px system-ui, 'Microsoft YaHei', sans-serif";
    ctx.fillText("能力指数（0–100）", cx, 850);

    if (r.rank) {
      ctx.font = "500 38px system-ui, 'Microsoft YaHei', sans-serif";
      ctx.fillText(r.rank, cx, 930);
    }
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "500 32px system-ui, sans-serif";
    ctx.fillText(location.hostname || "adaptive-riichi", cx, 1010);

    if (state.shareObjectUrl) URL.revokeObjectURL(state.shareObjectUrl);
    const url = await canvasToPngUrl(canvas);
    state.shareObjectUrl = url;
    els.shareWrap.classList.add("has-preview");
    els.shareImg.hidden = false;
    els.shareImg.src = url;
    els.downloadShareBtn.href = url;
    els.downloadShareBtn.hidden = false;
  }

  // ---------- leaderboard view ----------

  async function showLeaderboard() {
    const board = await loadBoard(50);
    els.fullBoardMeta.textContent = `已上榜 ${board.totalRanked} 人 · 累计参与 ${board.totalParticipants} 人`;
    renderStanding(els.fullStanding, board);
    els.fullBoard.innerHTML = "";
    if (!board.top.length) {
      const empty = document.createElement("p");
      empty.className = "muted-line";
      empty.textContent = "还没有人上榜。";
      els.fullBoard.appendChild(empty);
    } else {
      const yr = board.you && board.you.boardRank;
      board.top.forEach((e) => els.fullBoard.appendChild(boardRow(e, yr)));
    }
    show("leaderboardView");
  }

  // ---------- response handling ----------

  function handleAttemptResponse(res) {
    if (res.csrf) state.csrf = res.csrf;
    if (res.attemptId) state.attemptId = res.attemptId;
    if (res.status === "finished") { renderResult(res.result); return; }
    if (res.status === "technical_aborted") {
      renderResult({
        abilityIndex: "—",
        tier: "技术中止",
        level: "技术中止",
        rank: "",
        message: "题目资源加载失败，本次测试不会消耗你的作答次数。请稍后重新进入。",
      });
      return;
    }
    if (res.status === "continue" && res.question) prepareQuestion(res.question);
  }

  // ---------- events ----------

  els.startBtn.addEventListener("click", () => onStartClick().catch((e) => { els.homeNote.textContent = e.message; }));
  els.toBoardBtn.addEventListener("click", () => showLeaderboard().catch(() => {}));
  els.appealBtn.addEventListener("click", () => submitAppeal());
  els.homeBoardMore.addEventListener("click", () => showLeaderboard().catch(() => {}));
  els.sampleSubmitBtn.addEventListener("click", () => submitSample().catch((e) => alert(e.message)));
  els.sampleBackBtn.addEventListener("click", () => renderSample("question"));
  els.sampleSolutionBtn.addEventListener("click", () => renderSample("solution"));
  els.sampleConfirmBtn.addEventListener("click", () => confirmSample().catch((e) => alert(e.message)));
  els.sampleHomeBtn.addEventListener("click", () => bootstrap());
  els.submitBtn.addEventListener("click", () => submitAnswer().catch((e) => { els.loadingMsg.textContent = e.message; }));
  els.finishBtn.addEventListener("click", () => finishAttempt().catch((e) => alert(e.message)));
  els.confirmStartBtn.addEventListener("click", () => { const a = state.pendingConfirm; closeConfirm(); if (a) a(); });
  els.confirmCancelBtn.addEventListener("click", () => { closeConfirm(); bootstrap(); });
  els.nicknameSaveBtn.addEventListener("click", () => saveNickname());
  els.genShareBtn.addEventListener("click", () => generateShareCard().catch(() => alert("成绩卡生成失败，请稍后重试。")));
  els.retakeBtn.addEventListener("click", () => { if (state.remainingAttempts > 0) openConfirm(startAttempt); });
  els.resultBoardBtn.addEventListener("click", () => showLeaderboard().catch(() => {}));
  els.boardBackBtn.addEventListener("click", () => bootstrap());

  // ---------- bootstrap ----------

  async function bootstrap() {
    try {
      await refreshMe();
      if (state.activeAttemptId) {
        state.attemptId = state.activeAttemptId;
        const current = await api(`/api/attempts/${state.activeAttemptId}/current`);
        if (current.status === "continue") { handleAttemptResponse(current); return; }
        if (current.status === "finished") { handleAttemptResponse(current); return; }
      }
      await renderHome();
    } catch {
      await renderHome().catch(() => {});
    }
  }

  if (isTencentMobileBrowser()) show("blockedBrowserView");
  else bootstrap();
})();
