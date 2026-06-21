// Client network identity and user-agent parsing (ENG-002 extraction from server.js).
//
// clientIp trusts CF-Connecting-IP because the origin security group only admits
// Cloudflare's address ranges (the public cannot reach the origin directly). createNet
// binds the secret used to salt the soft device hash.

function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).trim();
  const real = req.headers["x-real-ip"];
  if (real) return String(real).trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket.remoteAddress || "";
}

function ipPrefixOf(ip) {
  if (!ip) return "";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip.split(".").slice(0, 3).join(".");
}

function parseUserAgent(ua) {
  const s = String(ua || "");
  const low = s.toLowerCase();
  const mobile = /android|iphone|ipad|ipod|mobile|micromessenger/.test(low);
  let os = "Unknown";
  if (/windows nt/.test(low)) os = "Windows";
  else if (/iphone|ipad|ipod/.test(low)) os = "iOS";
  else if (/mac os x/.test(low)) os = "macOS";
  else if (/android/.test(low)) os = "Android";
  else if (/linux/.test(low)) os = "Linux";
  let browser = "Unknown";
  if (low.includes("micromessenger")) browser = "WeChat";
  else if (low.includes("mqqbrowser") || low.includes("qqbrowser")) browser = "QQBrowser";
  else if (low.includes("ucbrowser")) browser = "UC";
  else if (low.includes("quark")) browser = "Quark";
  else if (low.includes("edg/") || low.includes("edgios/")) browser = "Edge";
  else if (low.includes("crios/")) browser = "Chrome";
  else if (low.includes("fxios/") || low.includes("firefox/")) browser = "Firefox";
  else if (low.includes("chrome/")) browser = "Chrome";
  else if (low.includes("safari/")) browser = "Safari";
  const device = mobile ? (/ipad|tablet/.test(low) ? "tablet" : "phone") : "desktop";
  return { browser, os, device, mobile };
}

function createNet({ sha, secret }) {
  function deviceHash(req) {
    const ua = req.headers["user-agent"] || "";
    const lang = req.headers["accept-language"] || "";
    const ch = req.headers["sec-ch-ua"] || "";
    const ipPrefix = ipPrefixOf(clientIp(req));
    return sha(`${ua}|${lang}|${ch}|${ipPrefix}|${secret}`);
  }
  return { clientIp, ipPrefixOf, parseUserAgent, deviceHash };
}

module.exports = { createNet, clientIp, ipPrefixOf, parseUserAgent };
