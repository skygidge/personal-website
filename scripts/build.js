#!/usr/bin/env node
/* Static site generator for skythomasgidge.com.
   Reads assets/data.js (the single content source) and injects escaped,
   pre-rendered HTML + SEO/social meta into each page between BUILD markers.
   The deployed pages therefore contain real content in source HTML; the
   browser only runs small enhancement scripts (site.js, pdf-thumbs.js).
   Pure Node, no dependencies. Run: npm run build */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SITE = "https://skythomasgidge.com";

// ---- load content ----
global.window = {};
require(path.join(ROOT, "assets", "data.js"));
const S = global.window.SKY;

// ---- escaping (treat data as untrusted) ----
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// attribute value; also neutralise javascript: in url-ish attrs
const attr = (s) => esc(s);
const url = (s) => {
  const v = String(s == null ? "" : s).trim();
  return /^\s*javascript:/i.test(v) ? "#" : esc(v);
};

// ---- per-page SEO config ----
const META = {
  "index.html": { path: "/", title: "Sky Thomas Gidge — video editor, photographer, journalist",
    desc: "Sky Thomas Gidge — video editor, photographer and journalist between Shenzhen and Los Angeles. Night photography, investigative writing, and a kit of small AI tools." },
  "writing.html": { path: "/writing.html", title: "Writing — Sky Thomas Gidge",
    desc: "Journalism by Sky Thomas Gidge — features, investigations, breaking news and street portraits from Shenzhen, published in Shenzhen Daily and That's Magazines, 2015–2018." },
  "photography.html": { path: "/photography.html", title: "Photography — Sky Thomas Gidge",
    desc: "Night photography and street work by Sky Thomas Gidge, shot mostly in Shenzhen with some Los Angeles." },
  "shenzhen-daily.html": { path: "/shenzhen-daily.html", title: "Shenzhen Daily Archive — Sky Thomas Gidge",
    desc: "Sky Thomas Gidge's Shenzhen Daily byline archive — staff reporting from Shenzhen, 2015–2016: breaking news, business and expat-life features." },
  "ai-tools.html": { path: "/ai-tools.html", title: "AI Tools — Sky Thomas Gidge",
    desc: "AI tools and experiments by Sky Thomas Gidge — autonomous agents, a bilingual newsletter, and Claude-assisted video and writing workflows." }
};
const OG_IMAGE = SITE + "/og-image.jpg";

function headMeta(file) {
  const m = META[file];
  const canonical = SITE + m.path;
  return [
    `<meta name="description" content="${attr(m.desc)}">`,
    `<link rel="canonical" href="${url(canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Sky Thomas Gidge">`,
    `<meta property="og:title" content="${attr(m.title)}">`,
    `<meta property="og:description" content="${attr(m.desc)}">`,
    `<meta property="og:url" content="${url(canonical)}">`,
    `<meta property="og:image" content="${url(OG_IMAGE)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attr(m.title)}">`,
    `<meta name="twitter:description" content="${attr(m.desc)}">`,
    `<meta name="twitter:image" content="${url(OG_IMAGE)}">`,
    `<noscript><style>.rv{opacity:1 !important;transform:none !important}</style></noscript>`
  ].map(l => "  " + l).join("\n");
}

// ---- renderers (markup mirrors the former runtime templates) ----
function photoCell(p, i, withLand) {
  const cls = "cell" + (withLand && p.o === "l" ? " land" : "") + (p.fit === "contain" ? " contain" : "");
  const cap = esc(p.cap) + (p.loc ? " · " + esc(p.loc) : "");
  return `<div class="${cls}" data-lb="photos" data-full="${url(p.src)}" data-cap="${attr(p.cap)}" data-loc="${attr(p.loc || "")}">`
    + `<img src="${url(p.src)}" alt="${attr(p.cap)}" loading="lazy"><div class="ov"></div>`
    + `<span class="n">${String(i + 1).padStart(2, "0")}</span>`
    + `<span class="cp">${cap}</span></div>`;
}
const photoGrid = (photos, withLand) => photos.map((p, i) => photoCell(p, i, withLand)).join("\n");

function thumbHtml(w) {
  if (w.img) return `<div class="w-thumb thumb-loaded"><img src="${url(w.img)}" alt="" loading="lazy"></div>`;
  if (w.pdf) return `<div class="w-thumb" data-pdf-thumb="${url(w.pdf)}"></div>`;
  return "";
}
function writingActs(w) {
  let a = "";
  if (w.site) a += `<a href="${url(w.site)}" target="_blank" rel="noopener">Read it <span class="ar">↗</span></a>`;
  if (w.pdf) a += `<a href="${url(w.pdf)}" target="_blank" rel="noopener">Magazine PDF <span class="ar">↗</span></a>`;
  if (w.censored) a += `<span class="censored">Censored — print only</span>`;
  return a;
}
function writingTitle(w) {
  const href = w.site || w.pdf || "";
  return href
    ? `<a class="wt" href="${url(href)}" target="_blank" rel="noopener">${esc(w.t)}</a>`
    : `<div class="wt">${esc(w.t)}</div>`;
}
// homepage writing row (body is an unclassed div)
function homeWritingRow(w) {
  const hasThumb = !!(w.pdf || w.img);
  const cls = "w" + (w.feat ? " feat" : "") + (hasThumb ? " has-thumb" : "");
  return `<div class="${cls}">${thumbHtml(w)}
  <div><div class="wk">${esc(w.kicker)}</div>
  ${writingTitle(w)}
  <div class="wd">${esc(w.d || "")}</div>${w.note ? `<div class="wn">${esc(w.note)}</div>` : ""}</div>
  <div class="wside"><div class="wp">${esc(w.pub || "")}</div><div class="wacts">${writingActs(w)}</div></div>
</div>`;
}
// writing-page row (body is .w-body, includes date; .rv for reveal)
function fullWritingRow(w) {
  const hasThumb = !!(w.pdf || w.img);
  const cls = "w rv" + (w.feat ? " feat" : "") + (hasThumb ? " has-thumb" : "");
  return `<div class="${cls}">${thumbHtml(w)}
  <div class="w-body">
    <div class="wk">${esc(w.kicker)}</div>
    ${writingTitle(w)}
    <div class="wd">${esc(w.d || "")}</div>
    ${w.note ? `<div class="wn">${esc(w.note)}</div>` : ""}
    ${w.date ? `<div class="wdate">${esc(w.date)}</div>` : ""}
  </div>
  <div class="wside"><div class="wp">${esc(w.pub || "")}</div><div class="wacts">${writingActs(w)}</div></div>
</div>`;
}
function aiButton(p, liveLabel) {
  if (p.live) return `<a class="live" href="${url(p.live)}" target="_blank" rel="noopener"><span class="dot"></span>${liveLabel}</a>`;
  if (p.link) return `<a class="go" href="${url(p.link)}" target="_blank" rel="noopener">${esc(p.linkText || "Read it")}</a>`;
  return "";
}
const aiShot = (p) => p.img ? `<div class="shot"><img src="${url(p.img)}" alt="${attr(p.t)}" loading="lazy"></div>` : "";
const aiGallery = (p, grp) => p.gallery
  ? `<div class="gallery">${p.gallery.map(g => `<img src="${url(g)}" alt="" loading="lazy" data-lb="${grp}" data-full="${url(g)}">`).join("")}</div>`
  : "";
const aiTags = (p) => `<div class="tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join("")}</div>`;
// homepage AI card (.aic)
function homeAiCard(p, i) {
  const cls = "aic" + (p.live ? " live-card" : "") + (p.span2 ? " span2" : "");
  return `<div class="${cls}">
  <div class="aic-top"><span class="st">${esc(p.status)}</span>${p.metric ? `<span class="mt">${esc(p.metric)}</span>` : ""}</div>
  <h3>${esc(p.t)}</h3><p>${esc(p.d)}</p>
  ${aiShot(p)}${aiGallery(p, "ai-home-" + i)}
  ${aiTags(p)}
  ${aiButton(p, "It's live — have a look ↗")}</div>`;
}
// ai-tools page card (.mcard)
function toolsAiCard(p, i) {
  const cls = "mcard rv" + (p.live ? " live-card" : "") + (p.span2 ? " span2" : "");
  return `<div class="${cls}"><div class="metric"><small>${p.cadence ? "Cadence" : "Result"}</small>${esc(p.metric)}</div>
  <div><div class="st">${esc(p.status)}</div><h3>${esc(p.t)}</h3></div>
  <p>${esc(p.d)}</p>
  ${aiShot(p)}${aiGallery(p, "ai-tools-" + i)}
  <div class="foot"><div class="tags">${p.tags.map(t => `<span>${esc(t)}</span>`).join("")}</div>${aiButton(p, "It's live ↗")}</div></div>`;
}
function archiveRow(w) {
  const year = (w.date || "").slice(0, 4) || "Undated";
  const isAward = /excellence|prize|award/i.test(w.note || "");
  const tag = w.site ? `<span class="go">Read on szdaily ↗</span>` : `<span class="printonly">Print only</span>`;
  const awardTag = isAward ? `<span class="award">★ Prize-winning</span>` : "";
  const open = w.site ? `<a class="arow rv" href="${url(w.site)}" target="_blank" rel="noopener">` : `<div class="arow rv">`;
  const close = w.site ? `</a>` : `</div>`;
  return { year, html: `${open}
  <div class="date">${esc(w.date || "")}</div>
  <div class="main"><div class="k">${esc(w.kicker || "News")}</div><h3>${esc(w.t)}</h3>${w.note ? `<div class="by">${esc(w.note)}</div>` : ""}${w.d ? `<div class="desc">${esc(w.d)}</div>` : ""}</div>
  <div class="side">${awardTag}${tag}</div>${close}` };
}

// ---- build sections per page ----
function groupedWriting(rowFn) {
  let out = "", last = null;
  S.writing.forEach(w => {
    const g = w.group || "More";
    if (g !== last) { out += `<div class="wgroup">${esc(g)}</div>\n`; last = g; }
    out += rowFn(w) + "\n";
  });
  return out;
}
function sections(file) {
  if (file === "index.html") {
    const intro = esc(S.introLine).replace("usually do.", `<span class='q'>usually do.</span>`);
    const home = S.writing.filter(w => w.home).sort((a, b) => (a.homeOrder || 99) - (b.homeOrder || 99));
    const restGroups = [...new Set(S.writing.filter(w => !w.home).map(w => w.group))].length;
    const wfoot = S.writing.length > home.length
      ? `<div class="wlist-foot"><a class="more" href="writing.html"><span>See all ${S.writing.length} articles</span><span class="ar">→</span></a><span class="lab">${S.writing.length - home.length} more across ${restGroups} sections</span></div>`
      : "";
    return {
      introLine: intro,
      pgCount: esc(S.photos.length + " frames · night · Shenzhen / LA"),
      pg: photoGrid(S.photos.slice(0, 8), false),
      moreLabel: "See all " + S.photos.length,
      award: `<span class="dot"></span><div><div class="k">${esc(S.award.kicker)} · ${esc(S.award.pub)}</div><div class="t">${esc(S.award.t)}</div></div>`,
      wlist: home.map(homeWritingRow).join("\n") + (wfoot ? "\n" + wfoot : ""),
      aigrid: S.ai.map(homeAiCard).join("\n"),
      clients: S.identity.clients.map(c => `<li>${esc(c)}</li>`).join("")
    };
  }
  if (file === "photography.html") return {
    count: esc(S.photos.length + " frames · night · Shenzhen / LA"),
    pg: photoGrid(S.photos, true)
  };
  if (file === "writing.html") return {
    articleCount: `${S.writing.length} articles`,
    award: `<span class="dot"></span><div><div class="k">${esc(S.award.kicker)} · ${esc(S.award.pub)}</div><div class="t">${esc(S.award.t)}</div></div>`,
    wlist: groupedWriting(fullWritingRow)
  };
  if (file === "ai-tools.html") return { mgrid: S.ai.map(toolsAiCard).join("\n") };
  if (file === "shenzhen-daily.html") {
    const sd = S.writing.filter(w => w.source === "sd").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    let out = "", last = null;
    sd.forEach(w => { const r = archiveRow(w); if (r.year !== last) { out += `<div class="yr">${esc(r.year)}</div>\n`; last = r.year; } out += r.html + "\n"; });
    return { archive: out };
  }
  return {};
}

// ---- inject between <!--BUILD:name-->...<!--/BUILD:name--> markers ----
function inject(html, name, content) {
  const re = new RegExp(`(<!--BUILD:${name}-->)[\\s\\S]*?(<!--/BUILD:${name}-->)`);
  if (!re.test(html)) { console.warn(`  ! marker BUILD:${name} not found`); return html; }
  return html.replace(re, `$1\n${content}\n$2`);
}

let built = 0;
for (const file of Object.keys(META)) {
  const fp = path.join(ROOT, file);
  let html = fs.readFileSync(fp, "utf8");
  html = inject(html, "head", headMeta(file));
  const secs = sections(file);
  for (const [name, content] of Object.entries(secs)) html = inject(html, name, content);
  fs.writeFileSync(fp, html);
  built++;
  console.log(`  built ${file}`);
}

// ---- sitemap.xml ----
const today = process.env.BUILD_DATE || ""; // optional; omit lastmod if unset
const urls = Object.values(META).map(m =>
  `  <url><loc>${SITE}${m.path}</loc>${today ? `<lastmod>${today}</lastmod>` : ""}</url>`).join("\n");
fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
console.log("  wrote sitemap.xml");
console.log(`\n  build complete: ${built} pages.`);
