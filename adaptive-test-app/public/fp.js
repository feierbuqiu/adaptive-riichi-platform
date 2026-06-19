/*
 * Client fingerprint collector — Package B (REMEDIATION_PLAN.md §4.5).
 * Collects low-entropy device signals + WebGL vendor/renderer only.
 * Does NOT use canvas/audio/font enumeration (high-entropy, excluded by D3=B).
 * Self-contained, defensive, non-blocking; fails silently.
 */
(function () {
  "use strict";

  function getCsrf() {
    return fetch("/api/user/me", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.csrf ? d.csrf : null; })
      .catch(function () { return null; });
  }

  function webglInfo() {
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl") || c.getContext("experimental-webgl");
      if (!gl) return {};
      var out = {};
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      if (dbg) {
        out.vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || "");
        out.renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
      } else {
        out.vendor = String(gl.getParameter(gl.VENDOR) || "");
        out.renderer = String(gl.getParameter(gl.RENDERER) || "");
      }
      var parts = [
        out.vendor, out.renderer,
        String(gl.getParameter(gl.VERSION) || ""),
        String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || ""),
        String(gl.getParameter(gl.MAX_TEXTURE_SIZE) || ""),
        (gl.getSupportedExtensions() || []).join(",")
      ].join("|");
      var h = 5381;
      for (var i = 0; i < parts.length; i++) { h = ((h << 5) + h + parts.charCodeAt(i)) >>> 0; }
      out.hash = ("0000000" + h.toString(16)).slice(-8);
      return out;
    } catch (e) { return {}; }
  }

  function collect() {
    var s = window.screen || {};
    var nav = window.navigator || {};
    var wg = webglInfo();
    var tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {}
    var scheme = "";
    try { scheme = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"; } catch (e) {}
    return {
      timezone: tz,
      languages: nav.languages || (nav.language ? [nav.language] : []),
      screenW: s.width, screenH: s.height,
      dpr: window.devicePixelRatio,
      viewportW: window.innerWidth, viewportH: window.innerHeight,
      platform: nav.platform || "",
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      touch: ("ontouchstart" in window) || (nav.maxTouchPoints > 0),
      colorDepth: s.colorDepth,
      colorScheme: scheme,
      webglVendor: wg.vendor, webglRenderer: wg.renderer, webglHash: wg.hash
    };
  }

  function run() {
    getCsrf().then(function (csrf) {
      if (!csrf) return;
      try {
        fetch("/api/fp", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(collect()),
          keepalive: true
        }).catch(function () {});
      } catch (e) {}
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(run, 1200);
  } else {
    window.addEventListener("load", function () { setTimeout(run, 1200); });
  }
})();
