/*
 * 立直麻将牌面 —— 基于第三方开源 SVG 素材（CC0/公有领域）的映射层。
 * 素材目录默认 ./simple_tiles （完整牌：含牌框/白板/牌背）。
 * 编码：m=万子 p=筒子 s=索子 z=字牌；0m/0p/0s=赤五万/赤⑤饼/赤5索；back=牌背。
 *   1-7z = 东 南 西 北 白 发 中
 * 用法：
 *   MJTiles.file("1z")      -> "tan"            （素材文件名，无扩展名）
 *   MJTiles.src("0m")       -> "simple_tiles/akaman.svg"
 *   MJTiles.img("5p",{width:60}) -> '<img ...>'
 *   MJTiles.parseHand("123m0p77z") -> ["1m","2m","3m","0p","7z","7z"]
 *
 * tan=东 / xia=西 已通过渲染截图确认；如需对调，仅改 HONOR 一行即可。
 */
(function (global) {
  "use strict";

  var BASE = "simple_tiles";
  var SUIT = { m: "man", p: "pin", s: "sou" };
  var RED = { m: "akaman", p: "akapin", s: "akasou" };
  // 1东 2南 3西 4北 5白 6发 7中  —— tan=东 / xia=西（已确认）
  var HONOR = { 1: "tan", 2: "nan", 3: "xia", 4: "pei", 5: "haku", 6: "hatsu", 7: "chun" };
  var ASPECT_W = 320, ASPECT_H = 446;

  function file(code) {
    code = String(code).trim().toLowerCase();
    if (code === "back") return "back";
    var m = code.match(/^([0-9])([mpsz])$/);
    if (!m) return null;
    var n = +m[1], suit = m[2];
    if (suit === "z") return HONOR[n] || null;
    if (n === 0) return RED[suit] || null;
    return n + SUIT[suit];
  }

  function src(code, base) {
    var f = file(code);
    return f ? ((base || BASE) + "/" + f + ".svg") : null;
  }

  function img(code, opts) {
    opts = opts || {};
    var s = src(code, opts.base);
    if (!s) return "";
    var w = opts.width || 60;
    return '<img class="mjtile" alt="' + code + '" src="' + s +
      '" style="width:' + w + 'px;aspect-ratio:' + ASPECT_W + '/' + ASPECT_H + ';display:block">';
  }

  // 渲染整副手牌：opts.tsumo = 末尾"分隔出来"的自摸新牌张数（默认 0=不分隔）。
  // 左侧自有牌紧密相接（无空隙），自摸牌用 .mjhand-draw 拉开间距。
  // 配套 CSS：.mjhand{display:flex} .mjhand-set{display:flex} .mjhand-draw{display:flex;margin-left:<间距>}
  function hand(codes, opts) {
    opts = opts || {};
    var w = opts.width || 56;
    var draw = opts.tsumo | 0;
    var n = codes.length;
    var keep = draw > 0 ? codes.slice(0, n - draw) : codes;
    var drawn = draw > 0 ? codes.slice(n - draw) : [];
    var set = '<span class="mjhand-set">' + keep.map(function (c) { return img(c, { width: w }); }).join("") + "</span>";
    var tail = drawn.length ? '<span class="mjhand-draw">' + drawn.map(function (c) { return img(c, { width: w }); }).join("") + "</span>" : "";
    return '<div class="mjhand">' + set + tail + "</div>";
  }

  function parseHand(str) {
    var out = [], re = /([0-9]+)([mpsz])/g, m;
    while ((m = re.exec(String(str).toLowerCase()))) {
      for (var i = 0; i < m[1].length; i++) out.push(m[1][i] + m[2]);
    }
    return out;
  }

  var API = { file: file, src: src, img: img, hand: hand, parseHand: parseHand, BASE: BASE, ASPECT_W: ASPECT_W, ASPECT_H: ASPECT_H };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (global) global.MJTiles = API;
})(typeof window !== "undefined" ? window : this);
