# Sky Thomas Gidge — Personal Website

A static personal site — photography, journalism, and AI tools. Hosted on GitHub Pages at **[skythomasgidge.com](https://skythomasgidge.com)**. No framework and no runtime dependencies; the deployed pages are plain pre-rendered HTML plus a little progressive-enhancement JS.

## How it works

**Content lives in one file: [`assets/data.js`](assets/data.js)** — arrays for `photos`, `writing`, and `ai`, plus `award`, `identity`, `introLine`. You edit data, then run the build, which writes the content **statically into the HTML** between `<!--BUILD:name-->` markers. This means the portfolio is real HTML in the page source (good for indexing and no-JS fallback), not rendered at runtime.

```
assets/data.js        ← the single content source (build input; not deployed — see Hosting)
scripts/build.js      ← generates static HTML + SEO meta into the pages, writes sitemap.xml
scripts/package.js    ← assembles _site/ — the deploy artifact, runtime files only
scripts/check-artifact.js ← guard: _site/ contains no build-input/source files
scripts/optimize-images.js ← resizes/recompresses oversized JPEGs in uploads/ (sips)
scripts/validate.js   ← checks refs, asset budget, metadata, internal links
scripts/render-pdf-thumbs.js ← pre-renders page-1 PDF thumbnails to uploads/thumbs/ (sips)

assets/site.js        ← shipped: reveal-on-scroll, header chrome, DOM-based lightbox

index.html · writing.html · photography.html · shenzhen-daily.html · ai-tools.html
404.html · robots.txt · sitemap.xml · og-image.jpg
uploads/              ← images, article PDFs, and pre-rendered PDF thumbnails (thumbs/)
```

The browser loads only `site.js`. There is **no** client-side data/templating layer and no browser-local editing tool — content changes go through `data.js` + a rebuild.

## Common tasks

```bash
npm run build          # regenerate static HTML + sitemap from data.js  (run after any data.js edit)
npm run validate       # check asset refs, size budget, metadata, internal links
npm test               # alias for validate
npm run package        # assemble _site/ — the deploy artifact (runtime files only)
npm run check-artifact # assert _site/ has no build-input/source files
npm run optimize       # shrink any oversized JPEGs in uploads/ (macOS `sips`)
npm run render-thumbs  # re-render page-1 PDF thumbnails after adding/replacing a PDF
```

**To add a photo / article / AI project:** edit the relevant array in `assets/data.js`, then `npm run build` and `npm run validate`. Drop image files in `uploads/` (run `npm run optimize` for large ones). Captions and text are HTML-escaped at build time, so content is safe to treat as untrusted.

> Edit `data.js`, not the HTML body — the marked regions are overwritten by the build.

## Asset budget

Display images are kept small (≤ ~700 KB; long edge 1800 px, hero 2200 px, JPEG q80). `npm run validate` fails if a referenced image exceeds the budget. Original full-resolution masters are **not** kept in the working tree (they remain in git history and in Sky's local archives); only web-ready derivatives ship.

## Hosting

GitHub Pages, custom domain `skythomasgidge.com` (apex A-records to GitHub + `www` CNAME; `CNAME` file in repo; HTTPS enforced). `.nojekyll` is committed so assets with spaces / Unicode names serve correctly.

**The repo root is not served.** Pages deploys an allowlisted artifact built by [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): `npm run package` copies only runtime files into `_site/` — the HTML pages, `404.html`, `robots.txt`, `sitemap.xml`, `og-image.jpg`, `CNAME`, `.nojekyll`, `uploads/`, and `assets/site.js`. Build inputs and source — `assets/data.js`, `scripts/`, `package.json`, `README.md` — are **excluded from the artifact and never reach the browser**. `npm run check-artifact` enforces this, and `https://skythomasgidge.com/assets/data.js` returns 404.

## CI

[`.github/workflows/validate.yml`](.github/workflows/validate.yml) runs `npm test` on every push and pull request, and verifies the committed static HTML is up to date with `data.js`.

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) (push to `main`) validates, rebuilds, checks for build drift, packages the runtime artifact, asserts it carries no build-input/source files (`npm run check-artifact`), then publishes it to GitHub Pages.
