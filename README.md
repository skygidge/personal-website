# Sky Thomas Gidge — Personal Website

A static personal site — photography, journalism, and AI tools. No build step, no framework, no dependencies. Open `index.html` in a browser, or serve the folder.

## Run locally

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

## Structure

- `index.html` — homepage: hero, photography, writing, AI tools
- `photography.html` — full photo grid (click to enlarge)
- `writing.html` — full writing list, grouped, with PDF thumbnails
- `shenzhen-daily.html` — Shenzhen Daily news archive by year
- `ai-tools.html` — full AI projects page
- `assets/data.js` — all content lives here (photos, writing, AI projects)
- `assets/store.js` · `lightbox.js` · `pdf-thumbs.js` — runtime helpers
- `uploads/` — images and article PDFs

To add or edit a photo, article, or AI project, edit the relevant array in `assets/data.js` — you rarely touch the HTML.

## Hosting

GitHub Pages–ready. Enable Pages on the `main` branch (root folder). `.nojekyll` is included so assets with spaces and Unicode filenames serve correctly.
