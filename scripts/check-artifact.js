#!/usr/bin/env node
/* Guard: verify the packaged Pages artifact (_site/) contains no build-input
   or source files, and that nothing references assets/data.js. Run in CI after
   `npm run package`, before deploy. Exits non-zero on any violation.
   Pure Node, no dependencies. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_site");
const errors = [];

if (!fs.existsSync(OUT)) {
  console.error("check-artifact: _site/ not found — run 'npm run package' first.");
  process.exit(1);
}

// Paths that must never appear in the deployed artifact.
const FORBIDDEN = [
  "assets/data.js", "scripts", "package.json", "package-lock.json",
  "README.md", ".github", ".gitignore"
];
FORBIDDEN.forEach((rel) => {
  if (fs.existsSync(path.join(OUT, rel))) errors.push(`forbidden in artifact: ${rel}`);
});

// Walk the artifact: only allow .js under assets/ that are known runtime scripts.
const ALLOWED_JS = new Set(["assets/site.js", "assets/pdf-thumbs.js"]);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
  const abs = path.join(dir, d.name);
  const rel = path.relative(OUT, abs);
  if (d.isDirectory()) return walk(abs);
  if (/\.js$/i.test(rel) && !ALLOWED_JS.has(rel)) errors.push(`unexpected .js in artifact: ${rel}`);
});
walk(OUT);

// No deployed HTML may reference the build-input data.js.
fs.readdirSync(OUT).filter((f) => /\.html$/.test(f)).forEach((f) => {
  if (/assets\/data\.js/.test(fs.readFileSync(path.join(OUT, f), "utf8")))
    errors.push(`${f} references assets/data.js`);
});

// Every local URL advertised in the sitemap must exist inside the artifact.
const SITE = "https://skythomasgidge.com";
const smPath = path.join(OUT, "sitemap.xml");
if (!fs.existsSync(smPath)) errors.push("sitemap.xml missing from artifact");
else {
  const sm = fs.readFileSync(smPath, "utf8");
  (sm.match(/<loc>([^<]+)<\/loc>/g) || []).forEach((m) => {
    const loc = m.replace(/<\/?loc>/g, "").trim();
    if (loc.slice(0, SITE.length) !== SITE) return;
    let rel = loc.slice(SITE.length).replace(/^\//, "").split(/[#?]/)[0];
    if (rel === "") rel = "index.html";
    else if (rel.endsWith("/")) rel += "index.html";
    if (!fs.existsSync(path.join(OUT, rel))) errors.push("sitemap URL not in artifact: " + loc + " (expected _site/" + rel + ")");
  });
}

if (errors.length) {
  console.error(`\nArtifact check FAILED (${errors.length}):`);
  errors.forEach((e) => console.error("  ✗ " + e));
  process.exit(1);
}
console.log("Artifact check PASS — only runtime files, no data.js references.");
