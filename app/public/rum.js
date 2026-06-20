/* OPS-005 real-user monitoring beacon. Same-origin, asynchronous, and failure-tolerant:
   it is wrapped in try/catch end to end, never blocks page load or answer submission, and
   degrades to a no-telemetry no-op when the APIs are unavailable. Collects coarse Web
   Vitals and an optional failure stage, then sends once on the first page-hide. */
(function () {
  "use strict";
  try {
    if (!window.PerformanceObserver || !window.performance) return;
  } catch (e) { return; }

  var data = { page: location.pathname.slice(0, 80), navType: "", ttfbMs: null, loadMs: null, lcpMs: null, inpMs: null, cls: 0, failureStage: "" };

  try {
    var nav = (performance.getEntriesByType("navigation") || [])[0];
    if (nav) {
      data.navType = String(nav.type || "");
      data.ttfbMs = Math.round(nav.responseStart || 0);
      data.loadMs = Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd || 0);
    }
  } catch (e) { /* navigation timing unavailable */ }

  function observe(type, handler) {
    try {
      var obs = new PerformanceObserver(handler);
      obs.observe({ type: type, buffered: true });
      return obs;
    } catch (e) { return null; }
  }
  observe("largest-contentful-paint", function (list) {
    var entries = list.getEntries();
    if (entries.length) data.lcpMs = Math.round(entries[entries.length - 1].startTime);
  });
  observe("layout-shift", function (list) {
    list.getEntries().forEach(function (s) { if (!s.hadRecentInput) data.cls += s.value; });
  });
  observe("event", function (list) {
    list.getEntries().forEach(function (ev) {
      if (ev.interactionId) {
        var d = Math.round(ev.duration);
        if (data.inpMs == null || d > data.inpMs) data.inpMs = d;
      }
    });
  });

  // Lets the app annotate where a user flow failed, e.g. PracticeRUM.fail("answer-submit").
  window.PracticeRUM = { fail: function (stage) { try { data.failureStage = String(stage || "").slice(0, 40); } catch (e) {} } };

  var sent = false;
  function send() {
    if (sent) return;
    sent = true;
    try {
      var body = JSON.stringify(data);
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/rum", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/api/rum", { method: "POST", body: body, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(function () {});
      }
    } catch (e) { /* telemetry must never break the page */ }
  }
  try {
    addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") send(); });
    addEventListener("pagehide", send);
  } catch (e) { /* event wiring unavailable */ }
})();
