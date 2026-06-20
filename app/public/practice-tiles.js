(function (global) {
  "use strict";
  var SUIT = { m: "man", p: "pin", s: "sou" };
  var RED = { m: "akaman", p: "akapin", s: "akasou" };
  var HONOR = { 1: "tan", 2: "nan", 3: "xia", 4: "pei", 5: "haku", 6: "hatsu", 7: "chun" };
  function file(code) {
    code = String(code || "").trim().toLowerCase();
    if (code === "back") return "back";
    var match = code.match(/^([0-9])([mpsz])$/);
    if (!match) return null;
    var number = Number(match[1]), suit = match[2];
    if (suit === "z") return HONOR[number] || null;
    if (number === 0) return RED[suit] || null;
    return number + SUIT[suit];
  }
  function src(code) {
    var name = file(code);
    return name ? "/practice-tiles/" + name + ".svg?v=vb1" : null;
  }
  function parse(value) {
    var out = [], expression = /([0-9]+)([mpsz])/g, match;
    while ((match = expression.exec(String(value || "")))) {
      for (var i = 0; i < match[1].length; i += 1) out.push(match[1][i] + match[2]);
    }
    return out;
  }
  global.PracticeTiles = { file: file, src: src, parse: parse };
})(window);
