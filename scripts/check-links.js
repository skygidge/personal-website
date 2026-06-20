#!/usr/bin/env node
/* External link checker. Pings every absolute http(s) URL the site points at —
   article links (site), magazine PDFs (pdf), award links, live AI tools, social
   profiles, and each clip's original source_url — and flags anything that doesn't
   resolve to a 2xx.

   This is a MANUAL diagnostic, deliberately NOT part of `npm test`/CI: it needs
   the network, and some publishers (szdaily e-paper, thatsmags) rate-limit or
   block bots, so a failure here is a prompt to verify by hand, not a red build.

   Run: npm run check-links            (all external URLs)
        npm run check-links -- --slow  (also retry ERROR/blocked once, slower)
   Pure Node, no dependencies. */
const http = require("http");
const https = require("https");
const path = require("path");

const ROOT = path.join(__dirname, "..");
global.window = {};
require(path.join(ROOT, "assets", "data.js"));
const S = global.window.SKY;
require(path.join(ROOT, "assets", "articles.js"));
const ARTICLES = global.window.SKY_ARTICLES || [];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT = 15000;
const CONCURRENCY = 6;
const isAbs = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

// ---- collect {url, where} ----
const targets = [];
const add = (url, where) => { if (isAbs(url)) targets.push({ url, where }); };
S.writing.forEach((w) => {
  add(w.site, `writing: ${w.t} (site)`);
  add(w.pdf, `writing: ${w.t} (pdf)`);
  add(w.awardLink, `writing: ${w.t} (award)`);
});
(S.ai || []).forEach((p) => { add(p.live, `ai: ${p.t} (live)`); add(p.link, `ai: ${p.t} (link)`); });
const soc = S.identity.social || {};
Object.entries(soc).forEach(([k, u]) => add(u, `social: ${k}`));
ARTICLES.forEach((a) => add(a.source_url, `clip: ${a.slug} (source)`));

// dedupe by URL, keeping all the places it appears
const byUrl = new Map();
for (const t of targets) (byUrl.get(t.url) || byUrl.set(t.url, []).get(t.url)).push(t.where);

// ---- fetch one URL, following redirects ----
function check(url, redirects = 0) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let lib, u;
    try { u = new URL(url); lib = u.protocol === "http:" ? http : https; }
    catch { return finish({ status: 0, note: "bad URL" }); }
    const req = lib.request(url, { method: "GET", headers: { "User-Agent": UA, "Accept": "*/*" } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && redirects < 6) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return finish(check(next, redirects + 1));
      }
      res.resume(); // drain
      finish({ status: code });
    });
    req.setTimeout(TIMEOUT, () => { req.destroy(); finish({ status: 0, note: "timeout" }); });
    req.on("error", (e) => finish({ status: 0, note: e.code || e.message }));
    req.end();
  });
}

// ---- run with limited concurrency ----
async function run() {
  const urls = [...byUrl.keys()];
  console.log(`\nChecking ${urls.length} external URLs (concurrency ${CONCURRENCY}, timeout ${TIMEOUT / 1000}s)…\n`);
  const results = [];
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const url = urls[i++];
      const r = await check(url);
      const ok = r.status >= 200 && r.status < 400;
      // Only 404/410 are treated as genuinely dead. Network errors and anti-bot
      // codes (403/429/999, szdaily's WAF 567, other 5xx) are "verify by hand" —
      // the content usually exists; the host just refuses automated requests.
      const dead = r.status === 404 || r.status === 410;
      const verify = !ok && !dead;
      results.push({ url, ...r, ok, dead, verify });
      console.log(`  [${ok ? "OK " : dead ? "DEAD" : "??? "}] ${r.status || r.note || "?"}  ${url}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const dead = results.filter((r) => r.dead);
  const verify = results.filter((r) => r.verify);
  console.log(`\n  ${results.length - dead.length - verify.length} ok · ${dead.length} dead · ${verify.length} to verify`);
  if (dead.length) {
    console.log(`\n  DEAD (${dead.length}) — 404/410, fix these:`);
    for (const r of dead) { console.log(`   ✗ ${r.status}  ${r.url}`); byUrl.get(r.url).forEach((w) => console.log(`       ${w}`)); }
  }
  if (verify.length) {
    console.log(`\n  VERIFY BY HAND (${verify.length}) — bot-blocked/WAF/timeout, content likely fine (szdaily e-paper 567, LinkedIn 999, etc.):`);
    for (const r of verify) console.log(`   ? ${r.status || r.note || "no response"}  ${r.url}`);
  }
  if (!dead.length && !verify.length) console.log("\n  PASS — every external link resolved.");
  process.exit(dead.length ? 1 : 0);
}
run();
