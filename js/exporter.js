// 框線輸出：把框線範圍內的作品用原始解析度畫成 PNG（可選背景色或透明）
(function (OE) {
  'use strict';

  const MAX_SIDE = 16384;
  const MAX_PIXELS = 160e6;
  let frames = [];

  const $ = (id) => document.getElementById(id);

  function open(list) {
    frames = list.slice();
    if (!frames.length) return;
    $('export-info').textContent = frames.length === 1
      ? `「${frames[0].name}」`
      : `${frames.length} 個框線：` + frames.map((f) => f.name).join('、');
    $('export-panel').hidden = false;
    updateSize();
  }

  function close() {
    $('export-panel').hidden = true;
  }

  function scaleFor(f, want) {
    let s = want;
    s = Math.min(s, MAX_SIDE / f.w, MAX_SIDE / f.h, Math.sqrt(MAX_PIXELS / (f.w * f.h)));
    return s;
  }

  function updateSize() {
    const want = Number($('ex-scale').value);
    const f = frames[0];
    if (!f) return;
    const s = scaleFor(f, want);
    let txt = `${Math.round(f.w * s)} × ${Math.round(f.h * s)} px`;
    if (frames.length > 1) txt += ' 等';
    if (s < want) txt += '（已限制在最大尺寸）';
    $('ex-size').textContent = txt;
  }

  // 讀原始檔：有連接資料夾就直接從資料夾讀（file:// 下也不會有跨來源問題），否則用 fetch
  async function loadBitmap(path) {
    let blob = null;
    const mem = OE.store.blobUrls.get(path);
    try {
      if (mem) blob = await (await fetch(mem)).blob();
      else if (OE.store.dir) {
        const parts = path.split('/');
        let d = OE.store.dir;
        for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
        blob = await (await d.getFileHandle(parts[parts.length - 1])).getFile();
      } else {
        blob = await (await fetch(path)).blob();
      }
      return await createImageBitmap(blob);
    } catch (e) {
      try {
        const img = new Image();
        img.src = OE.store.url(path);
        await img.decode();
        return img;
      } catch (e2) {
        throw new Error('讀不到 ' + path + '（請先連接資料夾）');
      }
    }
  }

  function sourcePath(it) {
    if (it.type === 'video') return it.lods.length ? it.lods[it.lods.length - 1].p : null;
    return it.src;
  }

  async function renderFrame(f, want, bg) {
    const s = scaleFor(f, want);
    const W = Math.max(1, Math.round(f.w * s)), H = Math.max(1, Math.round(f.h * s));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, W, H); }
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const minX = f.x - f.w / 2, minY = f.y - f.h / 2;
    const maxX = minX + f.w, maxY = minY + f.h;
    const list = OE.store.items.filter((it) => {
      if (it.type === 'frame') return false;
      const b = OE.util.itemAABB(it);
      return b.maxX > minX && b.minX < maxX && b.maxY > minY && b.minY < maxY;
    });
    for (const it of list) {
      if (it.type === 'text') {
        const cos = Math.cos(it.rot) * s, sin = Math.sin(it.rot) * s;
        g.setTransform(cos, sin, -sin, cos, (it.x - minX) * s, (it.y - minY) * s);
        OE.util.drawText(g, it);
        continue;
      }
      const p = sourcePath(it);
      if (!p) continue;
      const bmp = await loadBitmap(p);
      const cos = Math.cos(it.rot) * s, sin = Math.sin(it.rot) * s;
      g.setTransform(cos, sin, -sin, cos, (it.x - minX) * s, (it.y - minY) * s);
      g.drawImage(bmp, -it.w / 2, -it.h / 2, it.w, it.h);
      if (bmp.close) bmp.close();
    }
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生 PNG'))), 'image/png'));
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function safeName(n) {
    return (n || '框線').replace(/[\\/:*?"<>|]/g, '_').trim() || '框線';
  }

  async function run() {
    const want = Number($('ex-scale').value);
    const transparent = document.querySelector('input[name=ex-bg]:checked').value === 'transparent';
    const bg = transparent ? null : $('ex-color').value;
    const btn = $('ex-go');
    const list = frames.slice();
    // 先問儲存位置（必須在點擊後立刻呼叫）：一個框線選檔名，多個框線選資料夾
    let target = null;
    try {
      if (list.length === 1 && window.showSaveFilePicker) {
        target = { file: await window.showSaveFilePicker({
          id: 'oneeye-export', suggestedName: safeName(list[0].name) + '.png',
          types: [{ description: 'PNG 圖片', accept: { 'image/png': ['.png'] } }],
        }) };
      } else if (list.length > 1 && window.showDirectoryPicker) {
        target = { dir: await window.showDirectoryPicker({ id: 'oneeye-export', mode: 'readwrite' }) };
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      target = null; // 不支援或被擋 → 改用瀏覽器下載
    }
    btn.disabled = true;
    try {
      const used = new Set();
      for (let i = 0; i < list.length; i++) {
        btn.textContent = `輸出中 ${i + 1} / ${list.length}…`;
        const blob = await renderFrame(list[i], want, bg);
        let name = safeName(list[i].name);
        while (used.has(name)) name += '_';
        used.add(name);
        if (target && target.file) {
          const w = await target.file.createWritable();
          await w.write(blob);
          await w.close();
        } else if (target && target.dir) {
          const fh = await target.dir.getFileHandle(name + '.png', { create: true });
          const w = await fh.createWritable();
          await w.write(blob);
          await w.close();
        } else {
          download(blob, name + '.png');
          if (list.length > 1) await new Promise((r) => setTimeout(r, 400));
        }
      }
      OE.util.toast(target ? `已輸出 ${list.length} 張 PNG` : `已輸出 ${list.length} 張 PNG（在瀏覽器的下載資料夾）`, 4000);
      close();
    } catch (e) {
      console.error(e);
      OE.util.toast('輸出失敗：' + e.message, 6000);
    }
    btn.disabled = false;
    btn.textContent = '輸出 PNG';
  }

  $('ex-cancel').addEventListener('click', close);
  $('ex-go').addEventListener('click', run);
  $('ex-scale').addEventListener('change', updateSize);
  $('ex-color').addEventListener('input', () => { document.querySelector('input[name=ex-bg][value=color]').checked = true; });
  $('export-panel').addEventListener('keydown', (e) => e.stopPropagation());

  OE.exporter = { open, close, renderFrame };
})(window.OE);
