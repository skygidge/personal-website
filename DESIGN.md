# DESIGN.md — skythomasgidge.com

Design rules and decisions for this site. Read before changing any page.
Written June–July 2026, during the AI Projects section redesign.

---

## Tokens

Defined in `:root` in each page's `<style>`. Use the variables, never raw values.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#121110` | page background |
| `--panel` | `#1a1816` | card background |
| `--panel-2` | `#211e1b` | nested panel (srcline, shot frame) |
| `--ink` | `#ece7dc` | primary text |
| `--soft` | `#9a9286` | body text |
| `--faint` | `#8c8275` | labels, tags, metadata |
| `--line` | `rgba(236,231,220,.12)` | hover borders |
| `--line-2` | `rgba(236,231,220,.07)` | resting borders, rules |
| `--accent` | `#d4663a` | orange — metrics, links, emphasis |
| `--mono` | JetBrains Mono | labels, metrics, tags, nav |
| `--serif` | Newsreader | headings, editorial voice |
| `--sans` | system stack | body copy |
| `--cjk` | Noto Serif SC | Chinese text (loaded on pages that need it) |

E-ink tokens, local to `.epub-feature`: `--paper #e7e3d9`, `--paper-2 #ded9cc`,
`--e-ink #2a2723`, `--e-soft #6b655c`, `--e-line rgba(42,39,35,.16)`.

## Type system

- **Section headings**: serif, `clamp()`-sized, weight 400. Never bold display type.
- **Labels** (status, tags, nav, stat captions): mono, 9–11px, uppercase, tracked
  (`letter-spacing .08–.18em`), `--faint`.
- **Card titles** (`h3`): serif 22–23px, weight 400, `--ink`.
- **Body**: 14–15px, line-height ~1.6, `--soft`. Bold spans (`<b>`) flip to `--ink`
  for emphasis — used sparingly, one idea per paragraph.
- **Italic serif**: subtitles, hooks, asides. The site's "voice" register.

## Card system (AI Projects grid)

Every card follows one skeleton. Do not invent new headers.

```
.aic-top    status (mono label, left) · metric (mono 13px, ACCENT, right)
h3          project name (white serif)
p           body copy
media       optional: .shot (full-width) | .shot.portrait (300px, centered) | .gallery
.tags       bordered mono chips
button      .live (orange, pulsing dot) or a.go (bordered) — pinned to bottom
```

- **Metrics are results, not specs.** Uppercase, short, outcome-first:
  "SALES INSIGHT", "COWORKERS SAVE TIME WITH AI", "TALES FROM THE FRONTIER YEARS".
  Write the user's benefit, not the mechanism.
- **Status is the project's state**: "Live · Weekly", "Experiment", "Case study",
  "Pipeline · 21+ creative nonfiction articles".
- Cards with a live URL get `.live-card` (accent-tinted border) and the orange
  "It's live" button.
- **Grid**: 2 columns, 14px gap. `span2` cards take a full row. Keep the count of
  single cards even and put full-width features **last** so no holes appear.

## Card media

- **Uniform frame: every `.shot` is 2:3** (`aspect-ratio:2/3`), full card width,
  media cover-fitted from the top (`object-fit:cover; object-position:center top`).
  Modeled on the Edit Bay infographic (853×1280). Capture screenshots and record
  videos at 854×1280 so nothing meaningful gets cropped.
- Video: muted, autoplay, looped, playsinline, no controls. Record real product
  UI (Playwright), convert to h264 mp4, `-crf 26`, faststart. Keep under ~500KB.
- Screenshots of live tools should show **real results** (e.g. the Insta360
  finder framed on an actual week's stories), not empty states.

## The EPUB feature card (`.epub-feature`)

Full-width (span2) card, self-contained CSS namespace. Structure:
header (standard `.aic-top`) → srcline (中文长文 → explanation) → two columns:
numbered pipeline steps left, Kindle mockup right → download list below.

- **Kindle mockup**: e-ink paper tones, serif English with drop cap, bordered
  Chinese blockquote, source note, photo fading into the page via mask gradient.
  Excerpt text is verbatim from the real book.
- **Column balance rule**: the Kindle's height must land within ~30px of the left
  column's bottom. If a copy change unbalances it, adjust e-ink type sizes and the
  photo height (currently 140px) — not the card layout.
- **Downloads**: real files in `/uploads`, real sizes, the literal word "Download".

## Motion

- `.rv` elements reveal on scroll (`site.js` adds `.seen`). `noscript` and
  `prefers-reduced-motion` fallbacks force visible.
- Hovers: border-color shifts, ≤3px translates, 0.2–0.3s. Nothing bounces.
- The only persistent animations: hero slow-zoom, live-dot pulse, card videos.

## Honesty rules

These are content rules with the force of design rules:

1. Numbers on the page are real and verified against source files
   (EPUB sizes come from `ls`, not memory).
2. Metrics never overclaim — "(ALMOST) UBER-LOW-COST", "~HALF MY LEADS".
   The hedge is part of the voice.
3. Illustrative stand-in images are labeled "illustrative".
4. Counts ("8+ built · 3 live", "21+ creative nonfiction articles") get updated,
   not rounded up in advance.

## Architecture

- **`assets/data.js` is the single content source.** `scripts/build.js` renders
  cards into `<!--BUILD:name-->` markers at build time. There is **no runtime
  rendering** — don't add client-side templating.
- All data is escaped (`esc`). The one exception: authored `<b>` tags in long-form
  fields pass through `richB()`. Nothing else survives.
- **CSS lives in each page's own `<style>` block**, outside BUILD markers.
  Shared components (e.g. `.epub-feature`) are duplicated per page by design;
  keep the copies in sync.
- `npm run validate` must PASS before showing work; pages are visually verified
  (Playwright screenshot, `.rv` forced to `.seen`) before they're shared.

## Decisions log

- **2026-06** — Homepage hero: full-bleed rooftop photo, editorial caption.
- **2026-07** — EPUB project expanded from a text card to the full-width
  "Tales from the Frontier Years" feature. Headline iterations:
  中文 → BILINGUAL → Crimes of the Frontier Years → **Tales from the Frontier
  Years** (as metric; the h3 stays "Shenzhen True-Crime EPUB Generator").
- **2026-07** — Excerpt photo: mass-trial courtroom image from the Six Demoness
  book (replaces a generic Longgang street photo — "a building is not
  interesting").
- **2026-07** — Feature cards must reuse the published card skeleton; an earlier
  variant with an oversized custom header was rejected.
- **2026-07** — Section renamed **AI Projects**; stats strip moved from
  ai-tools.html onto the homepage.
- **2026-07** — **ai-tools.html retired**: now a noindex meta-refresh stub
  redirecting to `/#ai`. Kept in the deploy package so the old URL resolves;
  dropped from META, sitemap, and validation. All nav points at `/#ai`.
- **2026-07** — Card media policy set: every card `.shot` is a uniform 2:3
  frame (Edit Bay is the model); product UIs may be looping videos.
- **2026-07** — `card-arranger.html` added: local-only drag-and-drop tool for
  reordering the AI cards (not deployed, not in the sitemap).
