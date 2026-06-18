/* SkyStore — local content edits for skythomasgidge.com explorations.
   Layers add/remove edits (kept in localStorage + IndexedDB for images)
   on top of the base content in assets/data.js.
   Load order: data.js → store.js → (lightbox.js) → page script.
   Page scripts should call SkyStore.load().then(init).
   NOTE: edits live in this browser only. Use Export on manage.html to
   hand the changes to Claude (or paste them in chat) to make them permanent. */
(function () {
  const LS_KEY = "skySiteEdits.v1";
  const DB_NAME = "sky-site-images", DB_STORE = "images";

  /* ---------- edits in localStorage ---------- */
  function blank() {
    return { removed: { photos: [], writing: [], ai: [] },
             added:   { photos: [], writing: [], ai: [] } };
  }
  function getEdits() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return blank();
      const e = JSON.parse(raw);
      const b = blank();
      ["removed", "added"].forEach(k => {
        ["photos", "writing", "ai"].forEach(s => {
          if (e[k] && Array.isArray(e[k][s])) b[k][s] = e[k][s];
        });
      });
      return b;
    } catch (err) { return blank(); }
  }
  function saveEdits(e) { localStorage.setItem(LS_KEY, JSON.stringify(e)); }

  /* ---------- images in IndexedDB ---------- */
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(DB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function idbPut(key, blob) {
    return db().then(d => new Promise((res, rej) => {
      const tx = d.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(blob, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }
  function idbGet(key) {
    return db().then(d => new Promise((res, rej) => {
      const tx = d.transaction(DB_STORE, "readonly");
      const rq = tx.objectStore(DB_STORE).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    }));
  }
  function idbDel(key) {
    return db().then(d => new Promise((res, rej) => {
      const tx = d.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    }));
  }

  /* ---------- identity helpers ---------- */
  function idOf(section, item) { return section === "photos" ? item.src : item.t; }

  /* base snapshots (taken before any merge) */
  const base = {
    photos: (window.SKY.photos || []).slice(),
    writing: (window.SKY.writing || []).slice(),
    ai: (window.SKY.ai || []).slice()
  };

  /* resolve "idb:" photo srcs to object URLs */
  function resolvePhoto(p) {
    if (!p.src || p.src.indexOf("idb:") !== 0) return Promise.resolve(p);
    return idbGet(p.src.slice(4)).then(blob => {
      const q = Object.assign({}, p);
      q.idbKey = p.src.slice(4);
      q.src = blob ? URL.createObjectURL(blob) : "";
      return q;
    });
  }

  /* merge edits into window.SKY arrays IN PLACE (keeps lightbox refs valid) */
  let loaded = null;
  function load() {
    if (loaded) return loaded;
    loaded = (function () {
      const e = getEdits();
      const sections = ["photos", "writing", "ai"];
      return Promise.all(
        (e.added.photos || []).map(resolvePhoto)
      ).then(addedPhotos => {
        sections.forEach(s => {
          const removed = new Set(e.removed[s]);
          const merged = base[s].filter(it => !removed.has(idOf(s, it)));
          const added = s === "photos" ? addedPhotos : e.added[s];
          added.forEach(it => { if (it && (s !== "photos" || it.src)) merged.push(Object.assign({ user: true }, it)); });
          const arr = window.SKY[s];
          arr.length = 0;
          merged.forEach(it => arr.push(it));
        });
        return window.SKY;
      });
    })();
    return loaded;
  }

  /* ---------- mutations (used by manage.html) ---------- */
  function addItem(section, item, imageBlob) {
    const e = getEdits();
    if (section === "photos" && imageBlob) {
      const key = "u" + Date.now() + Math.random().toString(36).slice(2, 7);
      item = Object.assign({}, item, { src: "idb:" + key });
      return idbPut(key, imageBlob).then(() => {
        e.added.photos.push(item); saveEdits(e); return item;
      });
    }
    e.added[section].push(item); saveEdits(e);
    return Promise.resolve(item);
  }
  function removeItem(section, id) {
    const e = getEdits();
    const ai = e.added[section].findIndex(it => idOf(section, it) === id);
    if (ai >= 0) {
      const it = e.added[section].splice(ai, 1)[0];
      saveEdits(e);
      if (section === "photos" && it.src && it.src.indexOf("idb:") === 0)
        return idbDel(it.src.slice(4));
      return Promise.resolve();
    }
    if (e.removed[section].indexOf(id) < 0) e.removed[section].push(id);
    saveEdits(e);
    return Promise.resolve();
  }
  function restoreItem(section, id) {
    const e = getEdits();
    e.removed[section] = e.removed[section].filter(x => x !== id);
    saveEdits(e);
  }
  function resetAll() {
    const e = getEdits();
    const dels = (e.added.photos || [])
      .filter(p => p.src && p.src.indexOf("idb:") === 0)
      .map(p => idbDel(p.src.slice(4)));
    localStorage.removeItem(LS_KEY);
    return Promise.all(dels);
  }
  function exportText() {
    const e = getEdits();
    return JSON.stringify(e, null, 2);
  }
  function hasEdits() {
    const e = getEdits();
    return ["photos", "writing", "ai"].some(s => e.removed[s].length || e.added[s].length);
  }

  window.SkyStore = { load, getEdits, saveEdits, addItem, removeItem,
    restoreItem, resetAll, exportText, hasEdits, idOf, base, resolvePhoto };
})();
