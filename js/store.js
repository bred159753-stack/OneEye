// 資料模型與檔案讀寫
//
// 每個物件 (item)：
//   id, type: 'image' | 'video'
//   x, y   中心點世界座標
//   w, h   顯示尺寸（世界單位）
//   rot    旋轉（弧度）
//   src    原始檔路徑（相對於網站根目錄）
//   nw, nh 原始像素尺寸
//   color  平均色，極度縮小時用色塊代替圖片
//   lods   [{ s: 最長邊像素, p: 路徑 }]，由小到大；影片則是封面圖
// 陣列順序即圖層順序（後面的在上層）。
(function (OE) {
  'use strict';

  const DATA_PATH = 'data/canvas-data.js';

  const store = {
    items: [],
    index: new Map(),   // id -> item
    version: 0,         // 物件有變動就 +1（渲染器據此重建空間索引）
    dir: null,          // FileSystemDirectoryHandle（編輯模式連接的網站資料夾）
    pendingDir: null,   // 記住過但尚未取得權限的資料夾
    blobUrls: new Map(),// 剛匯入的檔案先用記憶體中的 blob 顯示
    unsaved: false,

    load() {
      const d = window.ONEEYE_DATA || {};
      this.items = (d.items || []).map(normalize).filter(Boolean);
      this.changed(false);
    },

    changed(markUnsaved = true) {
      this.index = new Map(this.items.map((it) => [it.id, it]));
      this.version++;
      if (markUnsaved) this.unsaved = true;
      if (OE.renderer) OE.renderer.invalidate();
      if (this.onChange) this.onChange();
    },

    get(id) {
      return this.index.get(id);
    },

    snapshot() {
      return JSON.stringify(this.items, (k, v) => (k[0] === '_' ? undefined : v));
    },

    restore(json) {
      this.items = JSON.parse(json);
      this.changed();
    },

    url(path) {
      return this.blobUrls.get(path) || path;
    },

    hasFS() {
      return typeof window.showDirectoryPicker === 'function';
    },

    async connectFolder() {
      const h = await window.showDirectoryPicker({ id: 'oneeye-site', mode: 'readwrite' });
      let ok = true;
      try { await h.getFileHandle('index.html'); } catch (e) { ok = false; }
      if (!ok && !confirm('這個資料夾裡沒有 index.html，確定它是 OneEye 網站資料夾嗎？\n（匯入的檔案與畫布資料都會寫進這個資料夾）')) {
        return false;
      }
      this.dir = h;
      this.pendingDir = null;
      try { await OE.util.idb('put', 'dir', h); } catch (e) { /* 記不住也無妨 */ }
      return true;
    },

    // 開啟編輯模式時，嘗試取回上次連接的資料夾
    async restoreFolder() {
      if (!this.hasFS()) return false;
      let h;
      try { h = await OE.util.idb('get', 'dir'); } catch (e) { return false; }
      if (!h) return false;
      try {
        if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') {
          this.dir = h;
          return true;
        }
      } catch (e) { return false; }
      this.pendingDir = h;
      return false;
    },

    // 必須在使用者點擊時呼叫
    async ensureFolder() {
      if (this.dir) return true;
      if (!this.hasFS()) {
        OE.util.toast('編輯與儲存需要使用 Chrome 或 Edge 瀏覽器', 4000);
        return false;
      }
      try {
        if (this.pendingDir) {
          const p = await this.pendingDir.requestPermission({ mode: 'readwrite' });
          if (p === 'granted') {
            this.dir = this.pendingDir;
            this.pendingDir = null;
            return true;
          }
        }
        return await this.connectFolder();
      } catch (e) {
        if (e && e.name !== 'AbortError') OE.util.toast('無法連接資料夾：' + e.message, 4000);
        return false;
      }
    },

    async writeFile(path, blob) {
      if (!this.dir) throw new Error('尚未連接資料夾');
      const parts = path.split('/');
      let d = this.dir;
      for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i], { create: true });
      const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    },

    async save() {
      if (!this.dir) throw new Error('尚未連接資料夾');
      const data = { version: 1, savedAt: new Date().toISOString(), items: JSON.parse(this.snapshot()) };
      const text = '// 由 OneEye 編輯模式自動產生，請勿手動修改\nwindow.ONEEYE_DATA = ' + JSON.stringify(data) + ';\n';
      await this.writeFile(DATA_PATH, new Blob([text], { type: 'text/javascript' }));
      this.unsaved = false;
    },
  };

  function normalize(it) {
    if (!it || !it.src) return null;
    return {
      id: String(it.id || OE.util.uid()),
      type: it.type === 'video' ? 'video' : 'image',
      x: +it.x || 0,
      y: +it.y || 0,
      w: +it.w || 100,
      h: +it.h || 100,
      rot: +it.rot || 0,
      src: it.src,
      nw: +it.nw || +it.w || 100,
      nh: +it.nh || +it.h || 100,
      color: it.color || '#555',
      lods: Array.isArray(it.lods) ? it.lods.slice().sort((a, b) => a.s - b.s) : [],
      title: it.title || '',
    };
  }

  OE.store = store;
})(window.OE);
