(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const state = {
    csrf: "", attempts: [], attemptFilter: "", attemptPage: 0, loaded: {},
    selectedIdentityId: null, identityPage: 1, practiceUserPage: 1, practiceBank: null,
  };
  const PAGE = 25;

  // ---------- 基础工具 ----------
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMs(ms) { if (ms == null) return "—"; return ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }
  function fmtDate(value) { return value ? String(value).replace("T", " ").slice(0, 19) : "—"; }
  function shortId(value) { const text = String(value || ""); return text.length > 18 ? text.slice(0, 8) + "…" + text.slice(-6) : text; }
  function pct(correct, answered) { return Number(answered) ? (Number(correct) / Number(answered) * 100).toFixed(1) + "%" : "—"; }
  const JP_TERMS = [["アガリトップ", "和出即一位"], ["ダブルリーチ", "双立直"], ["リーチ", "立直"], ["メンゼンツモ", "门前清自摸"], ["ツモ", "自摸"], ["ドラ表示牌", "宝牌指示牌"], ["ドラ", "宝牌"], ["テンパイ", "听牌"], ["ノーテン", "未听牌"], ["メンゼン", "门清"], ["フリテン", "振听"], ["ダマ", "默听"], ["トップ", "首位"], ["ラス", "末位"], ["アガリ", "和了"], ["巡目", "巡"], ["本場", "本场"]];
  function localize(v) { let s = String(v == null ? "" : v); if (!s) return ""; for (const [a, b] of JP_TERMS) s = s.split(a).join(b); return /[぀-ゟ゠-ヿ]/.test(s) ? "" : s; }
  function tileName(code) {
    const n = Number(code[0]), s = code[1];
    if (s === "z") return ({ 1: "东", 2: "南", 3: "西", 4: "北", 5: "白", 6: "发", 7: "中" })[n] || code;
    return (n === 0 ? "赤5" : n) + ({ m: "万", p: "饼", s: "索" })[s];
  }
  function answerText(a) {
    if (!a) return "—";
    if (a.action === "ankan") return "暗杠 " + tileName(a.tile);
    return (a.riichi ? "立直 + 切 " : "切 ") + tileName(a.tile);
  }
  function fmtFp(fp) {
    if (!fp) return "<div>（暂无指纹）</div>";
    const rows = [["来源", fp.source], ["浏览器", fp.uaBrowser], ["系统", fp.uaOs], ["设备", (fp.uaDevice || "") + (fp.uaMobile ? " · mobile" : "")], ["IP段", fp.ipPrefix], ["语言", fp.acceptLanguage || fp.languages], ["时区", fp.timezone], ["屏幕", fp.screen], ["DPR", fp.dpr], ["视口", fp.viewport], ["平台", fp.platform || fp.uachPlatform], ["机型", fp.uachModel], ["CPU核", fp.hardwareConcurrency], ["内存GB", fp.deviceMemory], ["触摸", fp.touch == null ? null : (fp.touch ? "是" : "否")], ["色深", fp.colorDepth], ["配色", fp.colorScheme], ["GPU厂商", fp.webglVendor], ["GPU", fp.webglRenderer]].filter((kv) => kv[1] != null && kv[1] !== "");
    return rows.map((kv) => "<div>" + esc(kv[0]) + "：" + esc(kv[1]) + "</div>").join("");
  }
  function evidenceLabels(edge) {
    const m = edge && edge.evidence && Array.isArray(edge.evidence.matches) ? edge.evidence.matches : [];
    return m.map((x) => x.label || x.type).filter(Boolean).join("；") || "—";
  }

  let toastTimer;
  function toast(text, kind) {
    const t = $("#adminToast"); t.textContent = text; t.className = "admin-toast" + (kind ? " is-" + kind : ""); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function modal(opts) {
    return new Promise((resolve) => {
      const m = $("#adminModal"), ok = $("#adminModalOk"), cancel = $("#adminModalCancel"), input = $("#adminModalInput");
      $("#adminModalTitle").textContent = opts.title || "确认";
      $("#adminModalText").textContent = opts.text || "";
      $("#adminModalInputWrap").hidden = !opts.input;
      if (opts.input) { input.value = opts.value || ""; input.placeholder = opts.placeholder || ""; }
      ok.textContent = opts.okText || "确定";
      m.hidden = false;
      if (opts.input) setTimeout(() => input.focus(), 30);
      const done = (val) => { m.hidden = true; ok.removeEventListener("click", onOk); cancel.removeEventListener("click", onCancel); resolve(val); };
      const onOk = () => done(opts.input ? (input.value || "") : true);
      const onCancel = () => done(opts.input ? null : false);
      ok.addEventListener("click", onOk); cancel.addEventListener("click", onCancel);
    });
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (state.csrf && options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrf;
    const res = await fetch(path, { credentials: "same-origin", ...options, headers, body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body });
    const txt = await res.text();
    const data = txt ? JSON.parse(txt) : {};
    if (!res.ok) throw new Error(data.error || "请求失败");
    if (data.csrf) state.csrf = data.csrf;
    return data;
  }
  const guard = (fn) => (...a) => fn(...a).catch((e) => toast(e.message, "error"));

  // ---------- 牌面渲染（只读）----------
  function admTile(code, w) { return '<img class="adm-tile" src="' + PracticeTiles.src(code) + '" alt="' + esc(code) + '" style="width:' + (w || 40) + 'px">'; }
  function renderScene(scene) {
    const s = scene || {}; const desc = localize(s.description);
    return '<div class="situation-bar"><span class="sb-label">场况</span>'
      + '<span class="meta-chip"><span class="wind">' + esc(s.round_wind || "") + "</span>" + esc(s.round_number || "") + "局</span>"
      + '<span class="meta-chip"><span class="k">自风</span><span class="wind">' + esc(s.seat_wind || "") + "</span></span>"
      + '<span class="meta-chip"><span class="k">第</span>' + esc(s.turn || "") + " 巡</span>"
      + (desc ? '<span class="meta-chip extra">' + esc(desc) + "</span>" : "") + "</div>";
  }
  function renderHandStatic(render) {
    const concealed = PracticeTiles.parse(render.hand || ""), draw = PracticeTiles.parse(render.draw || ""), dora = PracticeTiles.parse(render.doraIndicators || "");
    const slots = dora.concat(new Array(Math.max(0, 5 - dora.length)).fill("back")).slice(0, 5);
    const doraHtml = '<div class="dora-wrap"><div class="dora-label">宝牌<br>指示牌</div><div class="dora-tiles">' + slots.map((c) => admTile(c, 30)).join("") + "</div></div>";
    const melds = (render.melds || []).map((m) => '<span class="adm-meld">' + PracticeTiles.parse(m.mpsz || "").map((c) => admTile(c, 33)).join("") + "</span>").join("");
    const hand = '<div class="mjhand-tray"><div class="adm-hand">'
      + '<div class="adm-set">' + concealed.map((c) => admTile(c, 40)).join("") + "</div>"
      + '<div class="adm-draw">' + draw.map((c) => admTile(c, 40)).join("") + "</div>"
      + (melds ? '<div class="adm-melds">' + melds + "</div>" : "") + "</div></div>";
    return renderScene(render.scene) + doraHtml + hand;
  }

  // ---------- Tab 切换 ----------
  function activateTab(name) {
    document.querySelectorAll(".admin-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    document.querySelectorAll(".admin-pane").forEach((p) => p.classList.toggle("is-active", p.dataset.pane === name));
    if (name === "anticheat" && !state.loaded.anticheat) { state.loaded.anticheat = true; guard(loadSuspicious)(); }
    if (name === "exam" && !state.loaded.exam) { state.loaded.exam = true; guard(loadAttempts)(); }
    if (name === "practice" && !state.loaded.practiceUsers) { state.loaded.practiceUsers = true; guard(loadPracticeUsers)(1); }
    if (name === "identities" && !state.loaded.identities) { state.loaded.identities = true; guard(searchIdentities)(1); }
  }

  // ---------- 总览 ----------
  function cardGrid(el, cards) { el.innerHTML = cards.map(([label, value]) => '<div class="stat-card"><strong>' + esc(value) + "</strong><span>" + esc(label) + "</span></div>").join(""); }
  async function loadOverview() {
    const d = await api("/api/admin/dashboard");
    state.attempts = d.attempts || [];
    cardGrid($("#dashboardCards"), [["完成尝试", d.stats.finishedAttempts], ["软身份数", d.stats.totalIdentities], ["上榜人数", d.stats.rankedIdentities], ["技术终止", d.stats.technicalAborted], ["平均能力指数", d.stats.averageAbilityIndex], ["今日展示题次", d.stats.todayExposures]]);
    renderAttempts();
    const p = await api("/api/admin/practice/summary");
    const s = p.summary;
    cardGrid($("#practiceDashboardCards"), [["练习身份", s.identities], ["练习作答", s.responses], ["考试分析有效", s.analysisEligible], ["完成首轮", s.completedFirstRounds], ["进行中轮次", s.activeRounds], ["题库版本", s.bank.version]]);
  }

  // ---------- 考试：作答记录（搜索 + 分页）----------
  function filteredAttempts() {
    const q = state.attemptFilter.trim().toLowerCase();
    if (!q) return state.attempts;
    return state.attempts.filter((a) => [a.nickname, a.identityId, a.status, a.stopReason].some((v) => String(v || "").toLowerCase().includes(q)));
  }
  function renderAttempts() {
    const rows = filteredAttempts();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (state.attemptPage >= pages) state.attemptPage = 0;
    const slice = rows.slice(state.attemptPage * PAGE, state.attemptPage * PAGE + PAGE);
    if (!slice.length) { $("#attemptTable").innerHTML = '<p class="message">无匹配记录。</p>'; $("#attemptPager").innerHTML = ""; return; }
    $("#attemptTable").innerHTML = "<table><thead><tr><th>时间</th><th>状态</th><th>昵称</th><th>能力</th><th>正确/题数</th><th>超时</th><th>上榜</th><th>停止原因</th><th>操作</th></tr></thead><tbody>"
      + slice.map((a) => "<tr><td>" + esc(a.startedAt || "") + "</td><td>" + esc(a.status) + "</td><td>" + esc(a.nickname || "匿名玩家") + "</td><td>" + esc(a.reportedAbilityIndex ?? "") + "</td><td>" + esc(a.correctCount) + "/" + esc(a.answerCount) + "</td><td>" + esc(a.timeoutCount) + "</td><td>" + (a.excluded ? "已剔除" : "允许") + "</td><td>" + esc(a.stopReason || "") + "</td><td><div class=\"table-actions\"><button class=\"mini-btn\" data-id=\"" + esc(a.id) + "\">详情</button></div></td></tr>").join("")
      + "</tbody></table>";
    $("#attemptPager").innerHTML = '<button class="mini-btn" data-pg="prev"' + (state.attemptPage === 0 ? " disabled" : "") + ">上一页</button><span>第 " + (state.attemptPage + 1) + " / " + pages + " 页 · 共 " + rows.length + " 条</span><button class=\"mini-btn\" data-pg=\"next\"" + (state.attemptPage >= pages - 1 ? " disabled" : "") + ">下一页</button>";
    $("#attemptTable").querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => guard(loadAttempt)(b.dataset.id)));
    $("#attemptPager").querySelectorAll("button[data-pg]").forEach((b) => b.addEventListener("click", () => { state.attemptPage += b.dataset.pg === "next" ? 1 : -1; renderAttempts(); }));
  }
  async function loadAttempts() { const d = await api("/api/admin/dashboard"); state.attempts = d.attempts || []; renderAttempts(); }

  async function loadAttempt(idv) {
    const detail = await api("/api/admin/attempts/" + idv);
    const a = detail.attempt;
    const items = detail.items.map((it) => '<div class="detail-item"><strong>' + esc(it.sequence) + ". " + esc(it.questionId) + " · " + (it.correct ? "正确" : "错误") + " · " + esc(fmtMs(it.responseTimeMs)) + "</strong><div>选择：" + esc(it.selectedLabel ?? "空") + " · 答案：" + esc(it.answerLabel) + "</div><div>b=" + esc(it.b) + " a=" + esc(it.a) + " " + esc(it.stage) + "/" + esc(it.difficulty) + "</div></div>").join("");
    $("#attemptDetail").innerHTML = '<div class="detail-item"><strong>' + esc(a.id) + '</strong><div>身份：' + esc(a.identityId) + " · 昵称：" + esc(a.nickname || "匿名玩家") + "</div><div>状态：" + esc(a.status) + " · 能力：" + esc(a.reportedAbilityIndex) + " · 题数：" + esc(a.answerCount) + " 正确：" + esc(a.correctCount) + " 超时：" + esc(a.timeoutCount) + "</div><div>开始：" + esc(a.startedAt || "—") + " · 结束：" + esc(a.finishedAt || "—") + "</div><div class=\"detail-actions\"><button id=\"detailViewId\" class=\"ghost-btn\" type=\"button\">查看该身份</button><button id=\"detailDelete\" class=\"danger-btn\" type=\"button\">删除此记录</button></div></div>"
      + '<div class="detail-item"><strong>指纹（本次）</strong>' + fmtFp(detail.fingerprint) + "</div>" + items;
    $("#detailViewId").addEventListener("click", () => { activateTab("identities"); guard(loadIdentity)(a.identityId); });
    $("#detailDelete").addEventListener("click", guard(() => deleteAttempt(a.id)));
  }
  async function deleteAttempt(idv) {
    if (!(await modal({ title: "删除作答记录", text: "确认永久删除这条作答记录？会重算该身份的首次成绩与排行榜位置。建议仅用于清理异常记录。", okText: "删除" }))) return;
    await api("/api/admin/attempts/" + idv, { method: "DELETE", body: {} });
    toast("记录已删除", "ok"); $("#attemptDetail").innerHTML = '<p class="message">记录已删除，统计与排行榜已刷新。</p>'; loadAttempts();
  }

  function renderServerPager(element, data, onPage) {
    if (!data.total) { element.innerHTML = ""; return; }
    element.innerHTML = '<button class="mini-btn" data-page="prev"' + (data.page <= 1 ? " disabled" : "") + '>上一页</button>'
      + '<span>第 ' + esc(data.page) + " / " + esc(data.pages) + " 页 · 共 " + esc(data.total) + " 人</span>"
      + '<button class="mini-btn" data-page="next"' + (data.page >= data.pages ? " disabled" : "") + '>下一页</button>';
    element.querySelectorAll("button[data-page]").forEach((button) => button.addEventListener("click", () => {
      const next = button.dataset.page === "next" ? data.page + 1 : data.page - 1;
      guard(onPage)(next);
    }));
  }

  async function setBoardStatus(identityId, excluded, refresh) {
    const verb = excluded ? "从排行榜剔除" : "恢复上榜资格";
    if (!(await modal({ title: verb, text: "确认" + verb + "？该设置同时作用于练习和考试排行榜。" }))) return;
    await api("/api/admin/identities/" + encodeURIComponent(identityId) + "/exclude", { method: "POST", body: { excluded } });
    toast("上榜状态已更新", "ok");
    if (refresh) await refresh();
  }

  async function refreshUserIndexes() {
    const tasks = [];
    if (state.loaded.practiceUsers) tasks.push(loadPracticeUsers(state.practiceUserPage));
    if (state.loaded.identities) tasks.push(searchIdentities(state.identityPage));
    await Promise.all(tasks);
  }

  async function loadPracticeUsers(page = 1) {
    state.practiceUserPage = Math.max(1, Number(page) || 1);
    const query = new URLSearchParams({
      page: String(state.practiceUserPage), pageSize: String(PAGE),
      q: $("#practiceUserSearch").value.trim(), status: $("#practiceUserStatus").value,
    });
    const data = await api("/api/admin/practice/users?" + query.toString());
    const box = $("#practiceUserTable");
    if (!data.users.length) {
      box.innerHTML = '<p class="message">暂无匹配的练习用户。</p>';
      $("#practiceUserPager").innerHTML = "";
      return;
    }
    box.innerHTML = '<table><thead><tr><th>用户</th><th>身份</th><th>当前轮次</th><th>累计正确</th><th>首轮有效</th><th>最近作答</th><th>上榜</th><th>操作</th></tr></thead><tbody>'
      + data.users.map((user) => '<tr><td><strong>' + esc(user.displayNickname) + '</strong></td>'
        + '<td><code title="' + esc(user.identityId) + '">' + esc(shortId(user.identityId)) + '</code></td>'
        + '<td>第 ' + esc(user.roundNumber) + " 轮 · " + esc(user.roundAnswered) + "/" + esc(user.totalQuestions) + '<br><span class="admin-subtext">' + esc(user.roundStatus === "completed" ? "已完成" : "进行中") + "</span></td>"
        + '<td>' + esc(user.correct) + "/" + esc(user.answered) + " · " + esc(user.accuracy.toFixed(1)) + "%</td>"
        + '<td>' + esc(user.analysisEligibleAnswers) + ' 题</td><td>' + esc(fmtDate(user.lastResponseAt || user.roundStartedAt)) + '</td>'
        + '<td><span class="status-pill ' + (user.excludedFromBoard ? "is-off" : "is-on") + '">' + (user.excludedFromBoard ? "已剔除" : "允许") + '</span></td>'
        + '<td><div class="table-actions"><button class="mini-btn" data-practice-open="' + esc(user.identityId) + '">记录</button>'
        + '<button class="mini-btn" data-practice-board="' + esc(user.identityId) + '" data-excluded="' + (user.excludedFromBoard ? "1" : "0") + '">' + (user.excludedFromBoard ? "恢复" : "剔除") + '</button></div></td></tr>').join("")
      + "</tbody></table>";
    box.querySelectorAll("button[data-practice-open]").forEach((button) => button.addEventListener("click", () => guard(loadIdentity)(button.dataset.practiceOpen, "#practiceUserDetail")));
    box.querySelectorAll("button[data-practice-board]").forEach((button) => button.addEventListener("click", () => guard(setBoardStatus)(button.dataset.practiceBoard, button.dataset.excluded !== "1", async () => {
      await loadPracticeUsers(state.practiceUserPage);
      if (state.selectedIdentityId === button.dataset.practiceBoard) await loadIdentity(button.dataset.practiceBoard, "#practiceUserDetail");
    })));
    renderServerPager($("#practiceUserPager"), data, loadPracticeUsers);
  }

  // ---------- 练习题库浏览 ----------
  async function loadPracticeQuestions() {
    const d = await api("/api/admin/practice/questions");
    state.practiceBank = d.bank || null;
    state.practiceQuestions = d.questions || [];
    renderPracticeList();
    toast("已加载 " + state.practiceQuestions.length + " 道练习题", "ok");
  }
  function renderPracticeList() {
    const f = $("#practiceQFilter").value.trim();
    const list = state.practiceQuestions.filter((q) => !f || String(q.sourceNumber).includes(f));
    $("#practiceQList").innerHTML = list.map((q) => '<button class="q-item" type="button" data-n="' + q.sourceNumber + '">#' + q.sourceNumber + (q.inCohort ? ' <span class="q-tag">研究</span>' : "") + "</button>").join("") || '<p class="message">无匹配题号。</p>';
    $("#practiceQList").querySelectorAll("button[data-n]").forEach((b) => b.addEventListener("click", () => showPracticeQuestion(Number(b.dataset.n))));
  }
  function showPracticeQuestion(n) {
    const q = state.practiceQuestions.find((x) => x.sourceNumber === n);
    if (!q) return;
    $("#practiceQList").querySelectorAll(".q-item").forEach((b) => b.classList.toggle("is-active", Number(b.dataset.n) === n));
    const bankName = state.practiceBank && state.practiceBank.displayName ? state.practiceBank.displayName : "练习题库";
    $("#practiceQDetail").innerHTML = '<div class="q-detail-head">' + esc(bankName) + " · 第 " + n + " 题" + (q.inCohort ? "（首轮研究集）" : "") + "</div>"
      + renderHandStatic(q.render)
      + '<div class="answer-line">正确答案：<b>' + esc(answerText(q.answer)) + "</b></div>";
  }

  // ---------- 自适应考试：题库浏览 ----------
  async function loadExamQuestions() {
    const d = await api("/api/admin/questions");
    state.examQuestions = d.questions || [];
    if (!state.examQuestions.length) { $("#examQList").innerHTML = '<p class="message">题库为空（考试题目尚未导入）。</p>'; $("#examQDetail").innerHTML = ""; return; }
    $("#examQList").innerHTML = state.examQuestions.map((q) => '<button class="q-item" type="button" data-id="' + esc(q.id) + '">' + esc(q.id) + (q.active ? "" : ' <span class="q-tag is-off">停用</span>') + "</button>").join("");
    $("#examQList").querySelectorAll("button[data-id]").forEach((b) => b.addEventListener("click", () => showExamQuestion(b.dataset.id)));
    toast("已加载 " + state.examQuestions.length + " 道考试题", "ok");
  }
  function showExamQuestion(qid) {
    const q = state.examQuestions.find((x) => x.id === qid);
    if (!q) return;
    $("#examQList").querySelectorAll(".q-item").forEach((b) => b.classList.toggle("is-active", b.dataset.id === qid));
    const img = q.hasImage ? '<figure class="adm-exam-img"><img src="/api/admin/questions/' + encodeURIComponent(qid) + '/image" alt="题图"></figure>' : "";
    const opts = (q.options || []).map((o, i) => '<span class="opt-chip' + (i === q.answerIndex ? " is-answer" : "") + '">' + esc(o) + "</span>").join("");
    $("#examQDetail").innerHTML = "<div class=\"q-detail-head\">" + esc(q.id) + " · " + esc(q.stage) + "/" + esc(q.difficulty) + " · b=" + esc(q.b) + " a=" + esc(q.a) + "</div>" + img
      + '<div class="answer-line">选项（绿色=正确）：</div><div class="opt-row">' + opts + "</div>"
      + '<div class="detail-actions"><button id="examToggle" class="' + (q.active ? "danger-btn" : "primary-btn") + '" type="button">' + (q.active ? "停用此题" : "启用此题") + "</button></div>";
    $("#examToggle").addEventListener("click", guard(async () => {
      const next = !q.active;
      await api("/api/admin/questions/" + encodeURIComponent(qid) + "/active", { method: "POST", body: { active: next } });
      q.active = next; toast(next ? "已启用" : "已停用", "ok"); loadExamQuestions().then(() => showExamQuestion(qid));
    }));
  }

  // ---------- 用户索引、身份操作与练习记录 ----------
  function practiceSummaryHtml(practice) {
    if (!practice || !practice.rounds || !practice.rounds.length) return '<div class="detail-item"><strong>练习记录</strong><p class="message">该用户尚未开始练习。</p></div>';
    const summary = practice.summary;
    const rounds = practice.rounds.map((round) => '<tr><td>第 ' + esc(round.roundNumber) + ' 轮</td><td>' + esc(round.status === "completed" ? "已完成" : "进行中") + '</td><td>' + esc(round.answered) + "/" + esc(round.totalQuestions) + '</td><td>' + esc(round.correct) + " · " + esc(round.accuracy.toFixed(1)) + '%</td><td>' + (round.analysisEligible ? "是" : "否") + '</td><td>' + esc(fmtDate(round.lastResponseAt || round.startedAt)) + '</td></tr>').join("");
    return '<div class="detail-item"><strong>练习概览</strong>'
      + '<div class="user-stat-grid"><span><b>' + esc(summary.answered) + '</b>累计作答</span><span><b>' + esc(summary.correct) + '</b>累计正确</span><span><b>' + esc(summary.accuracy.toFixed(1)) + '%</b>正确率</span><span><b>' + esc(summary.analysisEligibleAnswers) + '</b>首轮有效</span></div>'
      + '<div class="table-wrap compact-table"><table><thead><tr><th>轮次</th><th>状态</th><th>进度</th><th>正确</th><th>考试分析</th><th>最近</th></tr></thead><tbody>' + rounds + '</tbody></table></div></div>'
      + '<div class="detail-item"><div class="panel-head"><strong>逐题练习记录</strong><div class="action-row admin-filter-row">'
      + '<select class="admin-input admin-select" data-practice-round><option value="">全部轮次</option>' + practice.rounds.map((round) => '<option value="' + esc(round.roundNumber) + '">第 ' + esc(round.roundNumber) + ' 轮</option>').join("") + '</select>'
      + '<select class="admin-input admin-select" data-practice-correct><option value="">全部判定</option><option value="correct">仅正确</option><option value="wrong">仅错误</option></select>'
      + '<input class="admin-input source-filter" data-practice-source inputmode="numeric" placeholder="题号" />'
      + '<button class="mini-btn" data-practice-refresh type="button">筛选</button></div></div>'
      + '<div class="table-wrap" data-practice-records><p class="message">正在加载逐题记录…</p></div><div class="pager" data-practice-record-pager></div></div>';
  }

  async function loadPracticeResponses(container, identityId, page = 1) {
    const round = container.querySelector("[data-practice-round]")?.value || "";
    const correct = container.querySelector("[data-practice-correct]")?.value || "";
    const source = container.querySelector("[data-practice-source]")?.value.trim() || "";
    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE) });
    if (round) query.set("round", round);
    if (correct) query.set("correct", correct);
    if (source) query.set("source", source);
    const data = await api("/api/admin/practice/users/" + encodeURIComponent(identityId) + "/responses?" + query.toString());
    const records = container.querySelector("[data-practice-records]");
    const pager = container.querySelector("[data-practice-record-pager]");
    if (!records || !pager) return;
    if (!data.responses.length) {
      records.innerHTML = '<p class="message">当前筛选条件下没有练习记录。</p>';
      pager.innerHTML = "";
      return;
    }
    records.innerHTML = '<table><thead><tr><th>轮/序</th><th>题号</th><th>用户选择</th><th>正确答案</th><th>判定</th><th>用时</th><th>页面状态</th><th>提交时间</th></tr></thead><tbody>'
      + data.responses.map((row) => '<tr><td>' + esc(row.roundNumber) + "/" + esc(row.sequence) + '</td><td><strong>#' + esc(row.sourceNumber) + '</strong>' + (row.cohortSeedItem ? ' <span class="q-tag">研究</span>' : "") + '</td>'
        + '<td>' + esc(answerText(row.selectedAnswer)) + '</td><td>' + esc(answerText(row.correctAnswer)) + '</td>'
        + '<td><span class="status-pill ' + (row.correct ? "is-on" : "is-error") + '">' + (row.correct ? "正确" : "错误") + '</span></td>'
        + '<td>有效 ' + esc(fmtMs(row.activeThinkingTimeMs)) + '<br><span class="admin-subtext">自然 ' + esc(fmtMs(row.serverWallTimeMs)) + " · 可见 " + esc(fmtMs(row.visibleTimeMs)) + '</span></td>'
        + '<td>隐藏 ' + esc(row.hiddenCount) + " · 失焦 " + esc(row.blurCount) + " · 恢复 " + esc(row.resumeCount) + '</td><td>' + esc(fmtDate(row.submittedAt)) + '</td></tr>').join("")
      + "</tbody></table>";
    pager.innerHTML = '<button class="mini-btn" data-record-page="prev"' + (data.page <= 1 ? " disabled" : "") + '>上一页</button><span>第 ' + esc(data.page) + " / " + esc(data.pages) + " 页 · 共 " + esc(data.total) + ' 条</span><button class="mini-btn" data-record-page="next"' + (data.page >= data.pages ? " disabled" : "") + '>下一页</button>';
    pager.querySelectorAll("button[data-record-page]").forEach((button) => button.addEventListener("click", () => guard(loadPracticeResponses)(container, identityId, button.dataset.recordPage === "next" ? data.page + 1 : data.page - 1)));
  }

  async function searchIdentities(page = 1) {
    state.identityPage = Math.max(1, Number(page) || 1);
    const query = new URLSearchParams({
      page: String(state.identityPage), pageSize: String(PAGE), q: $("#identitySearch").value.trim(),
      activity: $("#identityActivityFilter").value, board: $("#identityBoardFilter").value,
    });
    const data = await api("/api/admin/identities?" + query.toString());
    const box = $("#identityResults");
    if (!data.identities.length) {
      box.innerHTML = '<p class="message">暂无匹配用户。</p>';
      $("#identityPager").innerHTML = "";
      return;
    }
    box.innerHTML = '<table><thead><tr><th>用户</th><th>身份</th><th>练习</th><th>考试</th><th>上榜</th><th>最近活跃</th><th>操作</th></tr></thead><tbody>'
      + data.identities.map((user) => {
        const practice = user.practice;
        const practiceText = practice ? "第 " + practice.roundNumber + " 轮 " + practice.roundAnswered + "/" + practice.totalQuestions + '<br><span class="admin-subtext">累计 ' + practice.correct + "/" + practice.answered + " · " + practice.accuracy.toFixed(1) + "%</span>" : "—";
        const examText = user.examAttempts ? user.finishedExamAttempts + "/" + user.examAttempts + ' 次完成<br><span class="admin-subtext">最新指数 ' + esc(user.latestAbilityIndex ?? "—") + "</span>" : "—";
        return '<tr><td><strong>' + esc(user.displayNickname) + '</strong>' + (user.nicknameLocked ? ' <span title="昵称已锁定">🔒</span>' : "") + '</td><td><code title="' + esc(user.id) + '">' + esc(shortId(user.id)) + '</code></td><td>' + practiceText + '</td><td>' + examText + '</td>'
          + '<td><span class="status-pill ' + (user.excludedFromBoard ? "is-off" : "is-on") + '">' + (user.excludedFromBoard ? "已剔除" : "允许") + '</span></td><td>' + esc(fmtDate(user.lastActivityAt)) + '</td>'
          + '<td><div class="table-actions"><button class="mini-btn" data-user-open="' + esc(user.id) + '">管理</button><button class="mini-btn" data-user-board="' + esc(user.id) + '" data-excluded="' + (user.excludedFromBoard ? "1" : "0") + '">' + (user.excludedFromBoard ? "恢复" : "剔除") + '</button></div></td></tr>';
      }).join("") + "</tbody></table>";
    box.querySelectorAll("button[data-user-open]").forEach((button) => button.addEventListener("click", () => guard(loadIdentity)(button.dataset.userOpen)));
    box.querySelectorAll("button[data-user-board]").forEach((button) => button.addEventListener("click", () => guard(setBoardStatus)(button.dataset.userBoard, button.dataset.excluded !== "1", async () => {
      await searchIdentities(state.identityPage);
      if (state.selectedIdentityId === button.dataset.userBoard) await loadIdentity(button.dataset.userBoard);
    })));
    renderServerPager($("#identityPager"), data, searchIdentities);
  }

  async function loadIdentity(idv, targetSelector = "#identityDetail") {
    const d = await api("/api/admin/identities/" + encodeURIComponent(idv));
    const i = d.identity;
    state.selectedIdentityId = i.id;
    const container = $(targetSelector);
    const attempts = d.attempts.map((attempt) => '<button class="record-link" type="button" data-attempt="' + esc(attempt.id) + '"><span>' + esc(fmtDate(attempt.startedAt)) + " · " + esc(attempt.status) + '</span><strong>指数 ' + esc(attempt.reportedAbilityIndex ?? "—") + " · " + esc(attempt.correctCount) + "/" + esc(attempt.answerCount) + '</strong></button>').join("") || '<p class="message">无考试记录。</p>';
    container.innerHTML = '<div class="detail-item identity-head"><div><span class="admin-kicker">用户</span><h3>' + esc(i.displayNickname) + '</h3><div><code>' + esc(i.id) + '</code></div></div><div class="detail-actions"><button class="mini-btn" data-action="copy-id" type="button">复制身份ID</button>'
      + (targetSelector !== "#identityDetail" ? '<button class="primary-btn" data-action="full-manage" type="button">打开完整管理</button>' : "") + '</div></div>'
      + '<div class="user-stat-grid"><span><b>' + esc(d.practice?.summary?.answered || 0) + '</b>练习题数</span><span><b>' + esc(d.practice?.summary?.accuracy?.toFixed?.(1) || "0.0") + '%</b>练习正确率</span><span><b>' + esc(d.attempts.length) + '</b>考试记录</span><span><b>' + (i.excludedFromBoard ? "否" : "是") + '</b>允许上榜</span></div>'
      + '<div class="detail-item"><strong>昵称与权限</strong><div class="muted-line">审核状态：' + esc(i.nicknameReviewStatus || "—") + " · 锁定：" + (i.nicknameReviewLocked ? "是" : "否") + " · 失败次数：" + esc(i.nicknameReviewFailures) + " · 考试次数：" + esc(i.usedAttempts) + "/" + esc(i.maxAttempts) + '</div>'
      + '<div class="nickname-row"><input class="admin-input" data-nickname-input maxlength="16" placeholder="输入新昵称（2–16 字）" value="' + esc(i.nickname || "") + '"><button class="primary-btn" data-action="nickname-set" type="button">保存昵称</button></div>'
      + '<div class="detail-actions"><button class="ghost-btn" data-action="nickname-clear" type="button">恢复默认昵称</button><button class="ghost-btn" data-action="nickname-unlock" type="button">允许再次改名</button><button class="ghost-btn" data-action="reset-attempts" type="button">重置考试次数</button><button class="' + (i.excludedFromBoard ? "primary-btn" : "danger-btn") + '" data-action="toggle-board" type="button">' + (i.excludedFromBoard ? "恢复上榜" : "从排行榜剔除") + '</button></div></div>'
      + practiceSummaryHtml(d.practice)
      + '<div class="detail-item"><strong>考试记录</strong><div class="record-links">' + attempts + '</div></div>'
      + '<details class="detail-item"><summary><strong>设备与指纹（' + esc((d.fingerprints || []).length) + '）</strong></summary>' + ((d.fingerprints || []).map((fp) => '<div class="fingerprint-card"><div>' + esc(fmtDate(fp.capturedAt)) + '</div>' + fmtFp(fp) + '</div>').join("") || '<p class="message">暂无指纹。</p>') + '</details>';

    const reload = () => loadIdentity(i.id, targetSelector);
    container.querySelector('[data-action="copy-id"]').addEventListener("click", guard(async () => { await navigator.clipboard.writeText(i.id); toast("身份 ID 已复制", "ok"); }));
    const fullManage = container.querySelector('[data-action="full-manage"]');
    if (fullManage) fullManage.addEventListener("click", () => { activateTab("identities"); guard(loadIdentity)(i.id); });
    container.querySelector('[data-action="nickname-set"]').addEventListener("click", guard(async () => {
      const value = container.querySelector("[data-nickname-input]").value.trim();
      if (value && value.length < 2) return toast("昵称至少 2 个字符", "error");
      await api("/api/admin/identities/" + encodeURIComponent(i.id) + "/nickname", { method: "POST", body: { nickname: value } });
      toast("昵称已更新", "ok"); await reload(); await refreshUserIndexes();
    }));
    container.querySelector('[data-action="nickname-clear"]').addEventListener("click", guard(async () => {
      if (!(await modal({ title: "恢复默认昵称", text: "确认清除自定义昵称并恢复稳定的默认昵称？" }))) return;
      await api("/api/admin/identities/" + encodeURIComponent(i.id) + "/nickname", { method: "POST", body: { nickname: "" } });
      toast("已恢复默认昵称", "ok"); await reload(); await refreshUserIndexes();
    }));
    container.querySelector('[data-action="nickname-unlock"]').addEventListener("click", guard(async () => {
      await api("/api/admin/identities/" + encodeURIComponent(i.id) + "/nickname/unlock", { method: "POST", body: {} });
      toast("用户本轮可再次改名", "ok"); await reload(); await refreshUserIndexes();
    }));
    container.querySelector('[data-action="reset-attempts"]').addEventListener("click", guard(async () => {
      if (!(await modal({ title: "重置考试次数", text: "确认清零该用户的考试已用次数？练习进度不会受影响。" }))) return;
      await api("/api/admin/identities/" + encodeURIComponent(i.id) + "/reset-attempts", { method: "POST", body: {} });
      toast("考试次数已重置", "ok"); await reload(); await refreshUserIndexes();
    }));
    container.querySelector('[data-action="toggle-board"]').addEventListener("click", guard(async () => {
      await setBoardStatus(i.id, !i.excludedFromBoard);
      await reload();
      await refreshUserIndexes();
    }));
    container.querySelectorAll("button[data-attempt]").forEach((button) => button.addEventListener("click", () => { activateTab("exam"); guard(loadAttempt)(button.dataset.attempt); }));
    const refreshRecords = container.querySelector("[data-practice-refresh]");
    if (refreshRecords) {
      refreshRecords.addEventListener("click", () => guard(loadPracticeResponses)(container, i.id, 1));
      container.querySelector("[data-practice-round]").addEventListener("change", () => guard(loadPracticeResponses)(container, i.id, 1));
      container.querySelector("[data-practice-correct]").addEventListener("change", () => guard(loadPracticeResponses)(container, i.id, 1));
      container.querySelector("[data-practice-source]").addEventListener("keydown", (event) => { if (event.key === "Enter") guard(loadPracticeResponses)(container, i.id, 1); });
      await loadPracticeResponses(container, i.id, 1);
    }
  }

  // ---------- 反作弊 ----------
  function statusLabel(s, auto) { if (s === "auto_high" && auto) return "高置信 · 自动生效"; if (s === "review") return "中置信 · 待复核"; return s || "未知"; }
  async function loadSuspicious() {
    const d = await api("/api/admin/suspicious");
    const clusters = d.clusters || [], appeals = d.appeals || [];
    let html = "";
    if (appeals.length) {
      html += '<h3 class="mini-title">待处理申诉</h3><table><thead><tr><th>时间</th><th>身份</th><th>说明</th><th></th></tr></thead><tbody>'
        + appeals.map((a) => "<tr><td>" + esc(a.createdAt || "") + "</td><td>" + esc(a.identityId) + "</td><td>" + esc(a.message || "") + "</td><td><button class=\"mini-btn\" data-appeal=\"" + esc(a.id) + "\">标记已处理</button></td></tr>").join("") + "</tbody></table>";
    }
    if (!clusters.length && !appeals.length) { $("#suspiciousTable").innerHTML = '<p class="message">暂无明显重复聚类。</p>'; return; }
    html += clusters.map((c) => '<section class="cluster-block"><div class="cluster-head"><div><strong>' + esc(c.clusterId) + '</strong><div class="muted-line">' + esc(statusLabel(c.status, c.autoEnforced)) + " · 置信度 " + esc(c.confidence) + " · " + esc(c.memberCount) + ' 个身份</div></div></div>'
      + '<div class="cluster-summary">' + esc(c.summary || "") + '</div>'
      + '<div class="muted-line">核心证据：' + esc((c.topMatches || []).join("；") || "—") + '</div>'
      + '<h3 class="mini-title">成员</h3><table><thead><tr><th>身份</th><th>昵称</th><th>尝试/完成</th><th></th></tr></thead><tbody>'
      + (c.members || []).map((m) => '<tr><td>' + esc(m.identityId) + '</td><td>' + esc(m.nickname || "") + '</td><td>' + esc(m.usedAttempts ?? "") + "/" + esc(m.completedAttempts || 0) + '</td><td><button class="mini-btn" data-sep-c="' + esc(c.clusterId) + '" data-sep-i="' + esc(m.identityId) + '">解除</button></td></tr>').join("") + '</tbody></table>'
      + ((c.edges || []).length ? '<h3 class="mini-title">命中边</h3><table><thead><tr><th>A</th><th>B</th><th>分数</th><th>强/中/弱</th><th>证据</th></tr></thead><tbody>' + c.edges.map((e) => '<tr><td>' + esc(e.identityA) + '</td><td>' + esc(e.identityB) + '</td><td>' + esc(e.score) + '</td><td>' + esc(e.strongHits || 0) + "/" + esc(e.mediumHits || 0) + "/" + esc(e.weakHits || 0) + '</td><td>' + esc(evidenceLabels(e)) + '</td></tr>').join("") + '</tbody></table>' : "")
      + '</section>').join("");
    $("#suspiciousTable").innerHTML = html;
    $("#suspiciousTable").querySelectorAll("button[data-appeal]").forEach((b) => b.addEventListener("click", guard(async () => { await api("/api/admin/appeals/" + encodeURIComponent(b.dataset.appeal) + "/resolve", { method: "POST", body: {} }); toast("已处理", "ok"); loadSuspicious(); })));
    $("#suspiciousTable").querySelectorAll("button[data-sep-c]").forEach((b) => b.addEventListener("click", guard(async () => {
      if (!(await modal({ title: "解除聚类", text: "确认将该身份从聚类中解除？会记录管理员覆盖规则。" }))) return;
      await api("/api/admin/clusters/" + encodeURIComponent(b.dataset.sepC) + "/members/" + encodeURIComponent(b.dataset.sepI) + "/separate", { method: "POST", body: { reason: "管理员手动解除" } });
      toast("已解除", "ok"); loadSuspicious();
    })));
  }
  async function manualMerge() {
    const raw = await modal({ title: "强制合并身份", text: "输入要合并的身份 ID，用逗号分隔（≥2 个）。", input: true, placeholder: "id1, id2" });
    if (!raw) return;
    const ids = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (ids.length < 2) return toast("至少需要 2 个身份 ID", "error");
    await api("/api/admin/clusters/merge", { method: "POST", body: { identityIds: ids, reason: "管理员手动强制合并" } });
    toast("已合并", "ok"); loadSuspicious();
  }

  // ---------- 登录 / 启动 ----------
  async function afterLogin() { await loadOverview(); $("#adminLoginView").classList.remove("is-active"); $("#adminView").classList.add("is-active"); }
  async function login(e) {
    e.preventDefault();
    try {
      const r = await api("/api/admin/login", { method: "POST", body: { username: $("#adminUsername").value.trim(), password: $("#adminPassword").value, totp: $("#adminTotp").value.trim() } });
      state.csrf = r.csrf; await afterLogin();
    } catch (err) { $("#adminLoginMsg").textContent = err.message; $("#adminLoginMsg").className = "message is-error"; }
  }

  document.querySelectorAll(".admin-tab").forEach((b) => b.addEventListener("click", () => activateTab(b.dataset.tab)));
  $("#adminLoginForm").addEventListener("submit", login);
  $("#adminLogoutBtn").addEventListener("click", guard(async () => { await api("/api/admin/logout", { method: "POST", body: {} }); location.reload(); }));
  $("#refreshAdminBtn").addEventListener("click", guard(loadAttempts));
  $("#attemptSearch").addEventListener("input", (e) => { state.attemptFilter = e.target.value; state.attemptPage = 0; renderAttempts(); });
  let practiceUserSearchTimer;
  $("#refreshPracticeUsersBtn").addEventListener("click", () => guard(loadPracticeUsers)(1));
  $("#practiceUserSearch").addEventListener("input", () => { clearTimeout(practiceUserSearchTimer); practiceUserSearchTimer = setTimeout(() => guard(loadPracticeUsers)(1), 250); });
  $("#practiceUserStatus").addEventListener("change", () => guard(loadPracticeUsers)(1));
  $("#loadPracticeQBtn").addEventListener("click", guard(loadPracticeQuestions));
  $("#practiceQFilter").addEventListener("input", () => { if (state.practiceQuestions) renderPracticeList(); });
  $("#loadExamQBtn").addEventListener("click", guard(loadExamQuestions));
  let identitySearchTimer;
  $("#identitySearchBtn").addEventListener("click", () => guard(searchIdentities)(1));
  $("#identitySearch").addEventListener("input", () => { clearTimeout(identitySearchTimer); identitySearchTimer = setTimeout(() => guard(searchIdentities)(1), 250); });
  $("#identitySearch").addEventListener("keydown", (e) => { if (e.key === "Enter") guard(searchIdentities)(1); });
  $("#identityActivityFilter").addEventListener("change", () => guard(searchIdentities)(1));
  $("#identityBoardFilter").addEventListener("change", () => guard(searchIdentities)(1));
  $("#refreshSuspiciousBtn").addEventListener("click", guard(loadSuspicious));
  $("#manualMergeBtn").addEventListener("click", guard(manualMerge));

  api("/api/admin/me").then((me) => { if (me.loggedIn) { state.csrf = me.csrf; afterLogin().catch((e) => toast(e.message, "error")); } }).catch(() => {});
})();
