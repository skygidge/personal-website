#!/usr/bin/env node
/* Optimize oversized JPEGs in uploads/ in place. Pure Node + macOS `sips`.
   Idempotent: images already within bounds are skipped.
   Run: npm run optimize
   (PNG->JPEG format migration is a one-time step done separately; this keeps
    the repeatable command focused on the common case of a large JPEG photo.) */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const UP = path.join(__dirname, "..", "uploads");
const DEFAULT_MAX = 1800;          // max long edge (px) for display images
const SIZE_FLOOR = 500 * 1024;     // recompress JPEGs above this even if dims ok
const QUALITY = 80;
// per-file overrides (filename -> {max, q})
const PER = {
  "hero-rooftop-v2.jpg": { max: 2200 },           // full-bleed hero, keep crisp
  "ai-newsletter-substack.jpg": { max: 1300, q: 85 } // screenshot with text
};

function dims(f) {
  const o = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", f]).toString();
  return { w: +o.match(/pixelWidth: (\d+)/)[1], h: +o.match(/pixelHeight: (\d+)/)[1] };
}

let changed = 0, before = 0, after = 0;
for (const f of fs.readdirSync(UP).sort()) {
  if (!/\.(jpe?g)$/i.test(f)) continue;
  const fp = path.join(UP, f);
  const sz = fs.statSync(fp).size;
  const cfg = PER[f] || {};
  const max = cfg.max || DEFAULT_MAX;
  const q = cfg.q || QUALITY;
  const { w, h } = dims(fp);
  const longEdge = Math.max(w, h);
  const tooBig = longEdge > max;
  const tooHeavy = sz > SIZE_FLOOR;
  if (!tooBig && !tooHeavy) continue;
  const args = ["-s", "format", "jpeg", "-s", "formatOptions", String(q)];
  if (tooBig) args.unshift("-Z", String(max)); // only downscale when oversized
  const tmp = fp + ".opt.jpg";
  execFileSync("sips", [...args, fp, "--out", tmp]);
  const nsz = fs.statSync(tmp).size;
  if (nsz >= sz) { fs.unlinkSync(tmp); continue; } // never grow an already-efficient file
  fs.renameSync(tmp, fp);
  before += sz; after += nsz; changed++;
  console.log(`  ${f}: ${(sz / 1024 | 0)}KB -> ${(nsz / 1024 | 0)}KB${tooBig ? ` (resized to ${max}px)` : ""}`);
}
if (!changed) console.log("  all JPEGs already within bounds.");
else console.log(`\n  optimized ${changed} file(s): ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
