#!/usr/bin/env node
/* Pre-render the first page of each writing PDF to a static JPEG thumbnail.
   The site then shows magazine covers instantly as plain <img> — no client-side
   PDF.js, no per-PDF download, no blank boxes. Output mirrors the PDF name:
     uploads/Foo.pdf  ->  uploads/thumbs/Foo.jpg
   Re-run after adding/replacing a PDF:  npm run render-thumbs
   Requires macOS `sips`. Pure Node otherwise. */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "uploads");
const OUT = path.join(SRC, "thumbs");
const MAX = "440";      // long edge px — display is 100-130px, this covers retina
const QUALITY = "78";

fs.mkdirSync(OUT, { recursive: true });
const pdfs = fs.readdirSync(SRC).filter((f) => /\.pdf$/i.test(f)).sort();
let made = 0, fresh = 0, failed = 0;

for (const pdf of pdfs) {
  const src = path.join(SRC, pdf);
  const out = path.join(OUT, pdf.replace(/\.pdf$/i, ".jpg"));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) { fresh++; continue; }
  try {
    execFileSync("sips", ["-s", "format", "jpeg", "-Z", MAX, "-s", "formatOptions", QUALITY, src, "--out", out], { stdio: "ignore" });
    made++;
  } catch (e) {
    console.error("  ! failed: " + pdf);
    failed++;
  }
}
console.log(`pdf thumbs: ${made} rendered, ${fresh} up-to-date, ${failed} failed -> uploads/thumbs/ (${pdfs.length} PDFs)`);
if (failed) process.exit(1);
