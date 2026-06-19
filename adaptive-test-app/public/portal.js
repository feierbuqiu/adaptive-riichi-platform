(function () {
  "use strict";
  const state = { csrf: "", me: null };
  const $ = (selector) => document.querySelector(selector);
  const els = {
    displayNickname: $("#displayNickname"), nicknameState: $("#nicknameState"),
    nicknameRow: $("#nicknameRow"), nicknameInput: $("#nicknameInput"),
    nicknameSaveBtn: $("#nicknameSaveBtn"), nicknameMsg: $("#nicknameMsg"),
    examLink: $("#examLink"), examStatus: $("#examStatus"), examCard: $("#examCard"),
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
    if (!response.ok) throw new Error(data.error || "请求失败");
    if (data.csrf) state.csrf = data.csrf;
    return data;
  }

  function message(text, error) {
    els.nicknameMsg.textContent = text || "";
    els.nicknameMsg.classList.toggle("is-error", Boolean(error));
    els.nicknameMsg.classList.toggle("is-ok", Boolean(text) && !error);
  }

  function renderMe(me) {
    state.me = me;
    els.displayNickname.textContent = me.displayNickname;
    const locked = Boolean(me.nicknameReviewLocked);
    els.nicknameState.textContent = locked ? "本轮已设定昵称" : "可设置昵称";
    els.nicknameInput.disabled = locked;
    els.nicknameSaveBtn.disabled = locked;
    els.nicknameRow.hidden = locked;
    if (me.examEnabled) {
      els.examLink.href = "/exam";
      els.examLink.textContent = "进入考试";
      els.examLink.classList.remove("is-disabled");
      els.examLink.removeAttribute("aria-disabled");
      els.examStatus.textContent = "考试模式已经开放。";
      els.examCard.classList.remove("mode-card-locked");
    }
  }

  els.nicknameSaveBtn.addEventListener("click", async function () {
    if (els.nicknameSaveBtn.disabled) return;
    els.nicknameSaveBtn.disabled = true;
    message("正在保存…");
    try {
      const result = await api("/api/user/nickname", { method: "POST", body: { nickname: els.nicknameInput.value } });
      state.me.nickname = result.nickname;
      state.me.displayNickname = result.displayNickname;
      state.me.nicknameReviewRemaining = result.nicknameReviewRemaining;
      state.me.nicknameReviewLocked = result.nicknameReviewLocked;
      renderMe(state.me);
      message(result.approved ? "昵称已保存 ✅" : (result.message || "已更新昵称。"), !result.ok);
    } catch (error) {
      message(error.message, true);
      els.nicknameSaveBtn.disabled = false;
    }
  });

  api("/api/user/me", { method: "GET" }).then((me) => {
    state.csrf = me.csrf;
    renderMe(me);
  }).catch((error) => {
    els.displayNickname.textContent = "身份载入失败";
    message(error.message, true);
  });
})();
