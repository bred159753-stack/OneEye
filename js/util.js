// 共用工具與全域命名空間
window.OE = window.OE || {};

(function (OE) {
  'use strict';

  let toastTimer = 0;

  OE.util = {
    uid() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },

    clamp(v, a, b) {
      return v < a ? a : v > b ? b : v;
    },

    // 旋轉後物件在世界座標的外框 (axis-aligned bounding box)
    itemAABB(it) {
      const c = Math.abs(Math.cos(it.rot)), s = Math.abs(Math.sin(it.rot));
      const hw = (it.w * c + it.h * s) / 2, hh = (it.w * s + it.h * c) / 2;
      return { minX: it.x - hw, minY: it.y - hh, maxX: it.x + hw, maxY: it.y + hh };
    },

    unionAABB(list) {
      if (!list.length) return null;
      const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const it of list) {
        const a = OE.util.itemAABB(it);
        if (a.minX < b.minX) b.minX = a.minX;
        if (a.minY < b.minY) b.minY = a.minY;
        if (a.maxX > b.maxX) b.maxX = a.maxX;
        if (a.maxY > b.maxY) b.maxY = a.maxY;
      }
      return b;
    },

    // 世界座標轉成物件本地座標（以物件中心為原點、未旋轉）
    toLocal(it, wx, wy) {
      const dx = wx - it.x, dy = wy - it.y;
      const c = Math.cos(-it.rot), s = Math.sin(-it.rot);
      return { x: dx * c - dy * s, y: dx * s + dy * c };
    },

    hitItem(it, wx, wy) {
      const p = OE.util.toLocal(it, wx, wy);
      return Math.abs(p.x) <= it.w / 2 && Math.abs(p.y) <= it.h / 2;
    },

    debounce(fn, ms) {
      let t = 0;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
      };
    },

    toast(msg, ms = 2400) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('show'), ms);
    },

    formatTime(t) {
      if (!isFinite(t)) return '0:00';
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      return m + ':' + String(s).padStart(2, '0');
    },

    // 極簡 IndexedDB key/value，用來記住管理者連接過的資料夾
    idb(op, key, value) {
      return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open('oneeye', 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kv', op === 'get' ? 'readonly' : 'readwrite');
          const st = tx.objectStore('kv');
          const r = op === 'get' ? st.get(key) : st.put(value, key);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          tx.oncomplete = () => db.close();
        };
      });
    },
  };
})(window.OE);
