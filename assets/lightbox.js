/* Minimal shared lightbox. Call SkyLightbox.open(indexOrSrc).
   Reads window.SKY.photos for prev/next + captions. Injects its own styles. */
(function () {
  const photos = (window.SKY && window.SKY.photos) || [];
  let idx = 0, root;

  function ensure() {
    if (root) return;
    const css = document.createElement("style");
    css.textContent = `
      .slb{position:fixed;inset:0;z-index:9999;display:none;background:rgba(8,7,6,.97);
        align-items:center;justify-content:center;opacity:0;transition:opacity .28s ease;}
      .slb.on{display:flex;opacity:1;}
      .slb-img{max-width:88vw;max-height:84vh;object-fit:contain;box-shadow:0 40px 120px rgba(0,0,0,.6);
        transform:scale(.985);transition:transform .35s cubic-bezier(.2,.8,.2,1);}
      .slb.on .slb-img{transform:scale(1);}
      .slb-cap{position:fixed;left:0;right:0;bottom:26px;text-align:center;color:#cfc8bd;
        font:500 12px/1.4 ui-monospace,"JetBrains Mono",monospace;letter-spacing:.14em;text-transform:uppercase;}
      .slb-cap b{color:#fff;font-weight:600;}
      .slb-x,.slb-nav{position:fixed;top:50%;border:0;background:none;color:#fff;cursor:pointer;
        font:400 13px/1 ui-monospace,monospace;letter-spacing:.1em;opacity:.55;transition:opacity .2s;}
      .slb-nav:hover,.slb-x:hover{opacity:1;}
      .slb-prev{left:24px;transform:translateY(-50%);font-size:30px;}
      .slb-next{right:24px;transform:translateY(-50%);font-size:30px;}
      .slb-x{top:22px;right:26px;font-size:13px;letter-spacing:.16em;text-transform:uppercase;}
      .slb-count{position:fixed;top:24px;left:26px;color:#8a837a;
        font:500 12px/1 ui-monospace,monospace;letter-spacing:.18em;}
      @media(max-width:640px){.slb-img{max-width:94vw;}.slb-prev{left:8px;}.slb-next{right:8px;}}
    `;
    document.head.appendChild(css);
    root = document.createElement("div");
    root.className = "slb";
    root.innerHTML = `
      <button class="slb-x" aria-label="Close">Close ✕</button>
      <div class="slb-count"></div>
      <button class="slb-nav slb-prev" aria-label="Previous">‹</button>
      <img class="slb-img" alt="">
      <button class="slb-nav slb-next" aria-label="Next">›</button>
      <div class="slb-cap"></div>`;
    document.body.appendChild(root);
    root.querySelector(".slb-x").onclick = close;
    root.querySelector(".slb-prev").onclick = (e) => { e.stopPropagation(); go(-1); };
    root.querySelector(".slb-next").onclick = (e) => { e.stopPropagation(); go(1); };
    root.onclick = (e) => { if (e.target === root) close(); };
    document.addEventListener("keydown", (e) => {
      if (!root.classList.contains("on")) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    });
  }
  function render() {
    const p = photos[idx]; if (!p) return;
    root.querySelector(".slb-img").src = p.src;
    root.querySelector(".slb-count").textContent =
      String(idx + 1).padStart(2, "0") + " / " + String(photos.length).padStart(2, "0");
    root.querySelector(".slb-cap").innerHTML =
      "<b>" + (p.cap || "") + "</b>" + (p.loc ? "&nbsp;&nbsp;·&nbsp;&nbsp;" + p.loc : "");
  }
  function go(d) { idx = (idx + d + photos.length) % photos.length; render(); }
  function open(which) {
    ensure();
    if (typeof which === "number") idx = which;
    else { const i = photos.findIndex(p => p.src === which); idx = i < 0 ? 0 : i; }
    render();
    requestAnimationFrame(() => root.classList.add("on"));
    document.documentElement.style.overflow = "hidden";
  }
  function close() { root.classList.remove("on"); document.documentElement.style.overflow = ""; }
  window.SkyLightbox = { open, close };
})();
