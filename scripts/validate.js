#!/usr/bin/env node
/* Validation pipeline for the static site. Pure Node, no dependencies.
   Checks: local asset references exist, asset-size budget, required per-page
   metadata, internal link/anchor resolution; reports unused uploads.
   Run: npm run validate  (alias: npm test) */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PAGES = ["index.html", "writing.html", "photography.html", "shenzhen-daily.html", "ai-tools.html"];
const IMAGE_BUDGET = 700 * 1024;   // max bytes for a referenced display image
const PDF_BUDGET = 2 * 1024 * 1024; // article PDFs are linked downloads; looser cap
const errors = [], warnings = [];
const E = (m) => errors.push(m);
const W = (m) => warnings.push(m);
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
// HTML attribute values are entity-escaped by the build; decode before FS checks
const decode = (s) => s.replace(/&#x27;/gi, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ---------- collect references ----------
global.window = {};
require(path.join(ROOT, "assets", "data.js"));
const S = global.window.SKY;

const dataRefs = new Set();
const addRef = (p) => { if (p && /^uploads\//.test(p)) dataRefs.add(p); };
S.photos.forEach((p) => addRef(p.src));
S.writing.forEach((w) => { addRef(w.pdf); addRef(w.img); });
S.ai.forEach((p) => { addRef(p.img); (p.gallery || []).forEach(addRef); });

// references inside the HTML (src/href/data-* to local paths)
const htmlLocalRefs = new Map(); // ref -> page
for (const page of PAGES.concat(["404.html"])) {
  if (!exists(page)) continue;
  const html = read(page);
  const m = html.match(/(?:src|href|data-full|data-pdf-thumb)="([^"]+)"/g) || [];
  m.forEach((raw) => {
    const v = decode(raw.replace(/^[^"]+"/, "").replace(/"$/, ""));
    if (/^(https?:|mailto:|tel:|#|data:)/.test(v)) return;
    const clean = v.split("#")[0].split("?")[0];
    if (!clean || clean === "/") return;
    if (!htmlLocalRefs.has(clean)) htmlLocalRefs.set(clean, page);
  });
}

// ---------- 1. referenced assets exist ----------
[...dataRefs].forEach((r) => { if (!exists(r)) E(`missing asset (data.js): ${r}`); });
htmlLocalRefs.forEach((page, r) => { if (!exists(r)) E(`missing local ref in ${page}: ${r}`); });
// og-image referenced via absolute URL in meta
if (!exists("og-image.jpg")) E("missing og-image.jpg (referenced by og:image)");

// ---------- 2. asset-size budget ----------
const allRefs = new Set([...dataRefs, ...htmlLocalRefs.keys()]);
[...allRefs].forEach((r) => {
  if (!exists(r)) return;
  const sz = fs.statSync(path.join(ROOT, r)).size;
  if (/\.(jpe?g|png|webp|gif)$/i.test(r) && sz > IMAGE_BUDGET)
    E(`over image budget (${(sz / 1024 | 0)}KB > ${IMAGE_BUDGET / 1024}KB): ${r}`);
  if (/\.pdf$/i.test(r) && sz > PDF_BUDGET)
    W(`large PDF (${(sz / 1024 | 0)}KB): ${r}`);
});

// ---------- 3. unused uploads (report only) ----------
if (exists("uploads")) {
  for (const f of fs.readdirSync(path.join(ROOT, "uploads"))) {
    const rel = "uploads/" + f;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) continue;
    if (!allRefs.has(rel)) W(`unused upload: ${rel}`);
  }
}

// ---------- 4. required per-page metadata ----------
const REQUIRED = [
  [/<title>[^<]+<\/title>/, "title"],
  [/<meta name="description" content="[^"]+">/, "meta description"],
  [/<link rel="canonical" href="https:\/\/skythomasgidge\.com[^"]*">/, "canonical (skythomasgidge.com)"],
  [/<meta property="og:title" content="[^"]+">/, "og:title"],
  [/<meta property="og:image" content="[^"]+">/, "og:image"],
  [/<meta name="twitter:card" content="[^"]+">/, "twitter:card"]
];
PAGES.forEach((page) => {
  if (!exists(page)) { E(`missing page: ${page}`); return; }
  const html = read(page);
  REQUIRED.forEach(([re, label]) => { if (!re.test(html)) E(`${page}: missing ${label}`); });
});

// ---------- 5. internal links / anchors resolve ----------
const idCache = {};
const idsOf = (page) => (idCache[page] ||= new Set((read(page).match(/id="([^"]+)"/g) || []).map((s) => s.slice(4, -1))));
PAGES.concat(["404.html"]).forEach((page) => {
  if (!exists(page)) return;
  const html = read(page);
  (html.match(/href="([^"]+)"/g) || []).forEach((raw) => {
    const v = decode(raw.slice(6, -1));
    if (/^(https?:|mailto:|tel:|data:)/.test(v)) return;
    const [p, anchor] = v.split("#");
    let target = p;
    if (p === "" ) target = page;          // same-page anchor
    else if (p === "/") target = "index.html";
    if (/\.html$/.test(target) || target === page) {
      if (!exists(target)) { E(`${page}: link to missing page ${v}`); return; }
      if (anchor && !idsOf(target).has(anchor)) E(`${page}: broken anchor #${anchor} -> ${target}`);
    }
  });
});

// ---------- report ----------
console.log(`\nValidate: ${PAGES.length} pages, ${allRefs.size} asset refs checked.`);
if (warnings.length) { console.log(`\n${warnings.length} warning(s):`); warnings.forEach((w) => console.log("  ⚠ " + w)); }
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  errors.forEach((e) => console.log("  ✗ " + e));
  console.log("\nFAIL");
  process.exit(1);
}
console.log("\nPASS — all checks green.");
