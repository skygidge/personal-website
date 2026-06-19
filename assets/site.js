/* Client-side enhancement for the (statically pre-rendered) site.
   No data dependency: reads everything from the DOM. Captions are set with
   textContent, never innerHTML. Replaces the old data.js/store.js/lightbox.js
   runtime stack. */
(function () {
  "use strict";

  // ---------- reveal on scroll ----------
  function initReveal() {
    var els = document.querySelectorAll(".rv");
    if (!els.length) return;
    if (!("IntersectionObserver" in window)) { els.forEach(function (e) { e.classList.add("seen"); }); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("seen"); io.unobserve(e.target); } });
    }, { threshold: 0.12 });
    els.forEach(function (el) { io.observe(el); });
  }

  // ---------- top bar chrome (homepage) ----------
  function initChrome() {
    var top = document.getElementById("top");
    if (!top) return;
    var on = function () { top.classList.toggle("solid", window.scrollY > 40); };
    on(); window.addEventListener("scroll", on, { passive: true });
  }

  // ---------- lightbox (built from [data-lb] elements) ----------
  var root, groups = {}, cur = [], idx = 0;
  function ensure() {
    if (root) return;
    var css = document.createElement("style");
    css.textContent = [
      ".slb{position:fixed;inset:0;z-index:9999;display:none;background:rgba(8,7,6,.97);align-items:center;justify-content:center;opacity:0;transition:opacity .28s ease}",
      ".slb.on{display:flex;opacity:1}",
      ".slb-img{max-width:88vw;max-height:84vh;object-fit:contain;box-shadow:0 40px 120px rgba(0,0,0,.6);transform:scale(.985);transition:transform .35s cubic-bezier(.2,.8,.2,1)}",
      ".slb.on .slb-img{transform:scale(1)}",
      ".slb-cap{position:fixed;left:0;right:0;bottom:26px;text-align:center;color:#cfc8bd;font:500 12px/1.4 ui-monospace,'JetBrains Mono',monospace;letter-spacing:.14em;text-transform:uppercase}",
      ".slb-cap b{color:#fff;font-weight:600}",
      ".slb-x,.slb-nav{position:fixed;top:50%;border:0;background:none;color:#fff;cursor:pointer;font:400 13px/1 ui-monospace,monospace;letter-spacing:.1em;opacity:.55;transition:opacity .2s}",
      ".slb-nav:hover,.slb-x:hover{opacity:1}",
      ".slb-prev{left:24px;transform:translateY(-50%);font-size:30px}",
      ".slb-next{right:24px;transform:translateY(-50%);font-size:30px}",
      ".slb-x{top:22px;right:26px;font-size:13px;letter-spacing:.16em;text-transform:uppercase}",
      ".slb-count{position:fixed;top:24px;left:26px;color:#8a837a;font:500 12px/1 ui-monospace,monospace;letter-spacing:.18em}",
      "@media(max-width:640px){.slb-img{max-width:94vw}.slb-prev{left:8px}.slb-next{right:8px}}"
    ].join("");
    document.head.appendChild(css);
    root = document.createElement("div");
    root.className = "slb";
    var mk = function (tag, cls, txt) { var n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
    var x = mk("button", "slb-x", "Close ✕"); x.setAttribute("aria-label", "Close");
    var count = mk("div", "slb-count");
    var prev = mk("button", "slb-nav slb-prev", "‹"); prev.setAttribute("aria-label", "Previous");
    var img = mk("img", "slb-img"); img.alt = "";
    var next = mk("button", "slb-nav slb-next", "›"); next.setAttribute("aria-label", "Next");
    var cap = mk("div", "slb-cap");
    root.append(x, count, prev, img, next, cap);
    document.body.appendChild(root);
    x.onclick = close;
    prev.onclick = function (e) { e.stopPropagation(); go(-1); };
    next.onclick = function (e) { e.stopPropagation(); go(1); };
    root.onclick = function (e) { if (e.target === root) close(); };
    document.addEventListener("keydown", function (e) {
      if (!root.classList.contains("on")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    });
  }
  function render() {
    var p = cur[idx]; if (!p) return;
    var img = root.querySelector(".slb-img");
    img.src = p.src; img.alt = p.cap || "";
    var multi = cur.length > 1;
    root.querySelector(".slb-count").textContent = multi ? (pad(idx + 1) + " / " + pad(cur.length)) : "";
    root.querySelector(".slb-prev").style.display = multi ? "" : "none";
    root.querySelector(".slb-next").style.display = multi ? "" : "none";
    var cap = root.querySelector(".slb-cap");
    cap.textContent = "";
    if (p.cap) { var b = document.createElement("b"); b.textContent = p.cap; cap.appendChild(b); }
    if (p.loc) cap.appendChild(document.createTextNode((p.cap ? "  ·  " : "") + p.loc));
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function go(d) { idx = (idx + d + cur.length) % cur.length; render(); }
  function open(group, i) {
    ensure(); cur = groups[group] || []; idx = i || 0; render();
    requestAnimationFrame(function () { root.classList.add("on"); });
    document.documentElement.style.overflow = "hidden";
  }
  function close() { root.classList.remove("on"); document.documentElement.style.overflow = ""; }

  function initLightbox() {
    groups = {};
    document.querySelectorAll("[data-lb]").forEach(function (el) {
      var g = el.getAttribute("data-lb");
      var list = (groups[g] = groups[g] || []);
      list.push({ src: el.getAttribute("data-full") || el.getAttribute("src") || "",
                  cap: el.getAttribute("data-cap") || "", loc: el.getAttribute("data-loc") || "" });
      var gi = list.length - 1;
      el.style.cursor = "pointer";
      el.addEventListener("click", function (e) { e.preventDefault(); open(g, gi); });
    });
  }

  function init() { initReveal(); initChrome(); initLightbox(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
