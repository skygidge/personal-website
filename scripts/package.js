#!/usr/bin/env node
/* Assemble the GitHub Pages deploy artifact in _site/.
   Copies ONLY runtime files the browser may fetch. Build-input and source
   files (assets/data.js, scripts/, package.json, README.md, .github/…) are
   intentionally excluded so they are never served publicly.
   Run after a build: npm run build && npm run package
   Pure Node, no dependencies. */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_site");

// Allowlist — exactly the files the deployed site needs at runtime.
const FILES = [
  "index.html", "writing.html", "photography.html", "shenzhen-daily.html", "ai-tools.html",
  "404.html", "robots.txt", "sitemap.xml", "og-image.jpg", "CNAME", ".nojekyll",
  "assets/site.js", "assets/pdf-thumbs.js"
];
const DIRS = ["uploads"];
// Subpaths inside copied DIRS that are local-only and must not ship.
const DIR_EXCLUDE = new Set(["uploads/used-on-site"]);

const copyFile = (rel) => {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error(`package: missing runtime file: ${rel}`);
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
};
const copyDir = (rel) => {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, path.join(OUT, rel), {
    recursive: true,
    filter: (s) => {
      const r = path.relative(ROOT, s);
      return !DIR_EXCLUDE.has(r) && path.basename(s) !== ".DS_Store";
    }
  });
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
FILES.forEach(copyFile);
DIRS.forEach(copyDir);

// Strip any macOS cruft that Finder may drop into the tree.
const sweep = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
  const abs = path.join(dir, d.name);
  if (d.isDirectory()) sweep(abs);
  else if (d.name === ".DS_Store") fs.rmSync(abs);
});
sweep(OUT);

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, d) => n + (d.isDirectory() ? count(path.join(dir, d.name)) : 1), 0);
console.log(`  packaged _site/ — ${count(OUT)} files (runtime allowlist only).`);
