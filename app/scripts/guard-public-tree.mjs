// Public-tree secret/artifact guard (P0 repository integrity / CI).
//
// Fails if git is tracking any file that must never be published: secrets, credentials,
// keys, databases, backups, private workspace content, or the private question banks. The
// repository .gitignore already uses an allowlist; this is defense in depth that runs in CI
// and can be run locally before a release.

import { execSync } from "node:child_process";

const FORBIDDEN = [
  { label: "secrets directory", re: /(^|\/)secrets?\//i },
  { label: "private workspace", re: /(^|\/)private-workspace\//i },
  { label: "backups directory", re: /(^|\/)backups?\//i },
  { label: "dotenv file", re: /(^|\/)\.env(\.|$)/i },
  { label: "key or certificate", re: /\.(pem|key|p12|pfx)$/i },
  { label: "database file", re: /\.(sqlite|sqlite3|db|db-wal|db-shm)$/i },
  { label: "archive", re: /\.(tgz|tar|zip|gz)$/i },
  { label: "ssh key material", re: /id_ed25519|id_rsa|allowed_signers|known_hosts/i },
  { label: "credential/token file", re: /(^|\/)[^/]*(credential|access[-_.]?key|api[-_.]?token)[^/]*$/i },
  { label: "non-ascii (private bank) path", re: /[^\x00-\x7f]/ },
];

const ALLOW = [/(^|\/)\.env\.example$/i];

// core.quotepath=off keeps non-ASCII paths as raw UTF-8 instead of octal escapes, so the
// non-ascii rule can actually see the private bank directories.
const tracked = execSync("git -c core.quotepath=off ls-files", { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const violations = [];
for (const file of tracked) {
  if (ALLOW.some((re) => re.test(file))) continue;
  for (const rule of FORBIDDEN) {
    if (rule.re.test(file)) {
      violations.push({ file, reason: rule.label });
      break;
    }
  }
}

if (violations.length) {
  console.error(`Public-tree guard FAILED: ${violations.length} forbidden file(s) tracked:`);
  for (const violation of violations) console.error(`  - ${violation.file}  (${violation.reason})`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, tracked: tracked.length }));
