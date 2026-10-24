// 匯入：把圖片／影片複製進網站資料夾，並預先產生 LOD 縮圖金字塔
(function (OE) {
  'use strict';

  const LEVELS = [2048, 1024, 256, 64];        // 由大到小產生，每層由上一層縮小而來
  const IMAGE_EXT = /^(jpe?g|png|gif|webp|avif|bmp|svg|ico|jfif)$/;
  const VIDEO_EXT = /^(mp4|webm|mov|m4v|ogv|ogg)$/;
  const MAX_WORLD_SIDE = 1600;                  // 匯入時的預設最大顯示尺寸
  const CONCURRENCY = 3;

  function extOf(name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function kindOf(file) {
    const ext = extOf(file.name);
    if ((file.type || '').startsWith('video/') || VIDEO_EXT.test(ext)) return 'video';
    if ((file.type || '').startsWith('image/') || IMAGE_EXT.test(ext)) return 'image';
    return null;
  }

  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取圖片')); };
      img.src = url;
    });
  }

  async function decodeImage(file) {
    try {
      return await createImageBitmap(file);
    } catch (e) {
      // SVG 等格式 createImageBitmap 不支援，退回 <img>
      const img = await loadImageElement(file);
      if (!img.naturalWidth) {
        img.width = img.height = 1024;
      }
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || 1024;
      c.height = img.naturalHeight || 1024;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    }
  }

  function videoFrame(file) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeAttribute('src');
        v.load();
        URL.revokeObjectURL(url);
        err ? reject(err) : resolve(val);
      };
      const timer = setTimeout(() => finish(new Error('讀取影片逾時')), 30000);
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadedmetadata = () => {
        const d = isFinite(v.duration) ? v.duration : 0;
        v.currentTime = Math.min(1, d * 0.1);
      };
      v.onseeked = () => {
        if (!v.videoWidth) { finish(new Error('影片沒有畫面')); return; }
        const c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        finish(null, c);
      };
      v.onerror = () => finish(new Error('瀏覽器無法讀取此影片格式'));
      v.src = url;
    });
  }

  function resizeTo(source, sw, sh, tw, th) {
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(source, 0, 0, sw, sh, 0, 0, tw, th);
    return c;
  }

  // 一次縮小不超過 2 倍，畫質比較好
  function downscale(source, sw, sh, tw, th) {
    let cur = source, cw = sw, ch = sh;
    while (cw / 2 > tw && ch / 2 > th) {
      const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
      cur = resizeTo(cur, cw, ch, nw, nh);
      cw = nw;
      ch = nh;
    }
    return resizeTo(cur, cw, ch, tw, th);
  }

  function toBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('無法產生縮圖'))), 'image/webp', 0.85);
    });
  }

  function averageColor(canvas) {
    const c = resizeTo(canvas, canvas.width, canvas.height, 4, 4);
    const d = c.getContext('2d').getImageData(0, 0, 4, 4).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      r += d[i] * a; g += d[i + 1] * a; b += d[i + 2] * a; n += a;
    }
    if (!n) return '#444444';
    const hex = (v) => Math.round(v / n).toString(16).padStart(2, '0');
    return '#' + hex(r) + hex(g) + hex(b);
  }

  async function importOne(file) {
    const kind = kindOf(file);
    if (!kind) throw new Error('不支援的檔案類型');
    const id = OE.util.uid();
    const ext = extOf(file.name) || (kind === 'video' ? 'mp4' : 'png');

    const source = kind === 'video' ? await videoFrame(file) : await decodeImage(file);
    const nw = source.width, nh = source.height;
    const maxSide = Math.max(nw, nh);

    const srcPath = (kind === 'video' ? 'assets/video/' : 'assets/original/') + id + '.' + ext;
    await OE.store.writeFile(srcPath, file);
    OE.store.blobUrls.set(srcPath, URL.createObjectURL(file));

    // 產生 LOD：圖片只產生比原圖小的層級；影片封面至少要有一張
    let levels = LEVELS.filter((L) => L < maxSide);
    if (kind === 'video' && maxSide <= 2048) levels = [maxSide, ...levels];
    const lods = [];
    let prev = source, pw = nw, ph = nh;
    let smallest = null;
    for (const L of levels) {
      const k = L / maxSide;
      const tw = Math.max(1, Math.round(nw * k)), th = Math.max(1, Math.round(nh * k));
      const c = downscale(prev, pw, ph, tw, th);
      const blob = await toBlob(c);
      const p = 'assets/lod/' + id + '_' + L + '.webp';
      await OE.store.writeFile(p, blob);
      OE.store.blobUrls.set(p, URL.createObjectURL(blob));
      lods.push({ s: L, p });
      prev = c; pw = tw; ph = th;
      smallest = c;
    }
    const color = averageColor(smallest || source);
    if (source.close) source.close();

    const k = Math.min(1, MAX_WORLD_SIDE / maxSide);
    return {
      id, type: kind,
      x: 0, y: 0, w: nw * k, h: nh * k, rot: 0,
      src: srcPath, nw, nh, color,
      lods: lods.sort((a, b) => a.s - b.s),
      title: file.name.replace(/\.[^.]+$/, ''),
    };
  }

  // 書架式排列（由左到右、自動換行），整組以 (cx, cy) 為中心
  function shelfLayout(items, cx, cy, gap = 40) {
    if (!items.length) return;
    let area = 0, maxW = 0;
    for (const it of items) {
      const b = OE.util.itemAABB(it);
      area += (b.maxX - b.minX + gap) * (b.maxY - b.minY + gap);
      maxW = Math.max(maxW, b.maxX - b.minX);
    }
    const rowW = Math.max(maxW, Math.sqrt(area) * 1.4);
    let x = 0, y = 0, rowH = 0;
    const placed = [];
    for (const it of items) {
      const b = OE.util.itemAABB(it);
      const w = b.maxX - b.minX, h = b.maxY - b.minY;
      if (x > 0 && x + w > rowW) { x = 0; y += rowH + gap; rowH = 0; }
      placed.push([it, x + w / 2, y + h / 2]);
      x += w + gap;
      rowH = Math.max(rowH, h);
    }
    let totalW = 0;
    for (const [it, px] of placed) totalW = Math.max(totalW, px + OE.util.itemAABB(it).maxX - it.x);
    const totalH = y + rowH;
    for (const [it, px, py] of placed) {
      it.x = cx - totalW / 2 + px;
      it.y = cy - totalH / 2 + py;
    }
  }

  async function importFiles(fileList, cx, cy) {
    const files = [...fileList].filter((f) => kindOf(f));
    const skipped = fileList.length - files.length;
    if (!files.length) {
      OE.util.toast('沒有可匯入的圖片或影片');
      return [];
    }
    if (!OE.store.dir) {
      // 開啟資料夾選擇器需要使用者剛點擊過；拖曳放開不算，所以先暫存，連接後自動匯入
      const activeGesture = !navigator.userActivation || navigator.userActivation.isActive;
      if (!activeGesture || !(await OE.store.ensureFolder())) {
        OE.importer.pending = { files: fileList, cx, cy };
        OE.util.toast(`請先按上方「連接資料夾」選擇 OneEye 網站資料夾，連接後會自動匯入這 ${files.length} 個檔案`, 6000);
        return [];
      }
    }

    const progress = document.getElementById('progress');
    const ptext = document.getElementById('progress-text');
    const pbar = document.getElementById('progress-bar');
    progress.hidden = false;
    let done = 0;
    const results = new Array(files.length);
    const errors = [];
    const report = () => {
      ptext.textContent = `匯入中 ${done} / ${files.length}（產生縮圖）`;
      pbar.style.width = (done / files.length) * 100 + '%';
    };
    report();

    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const i = next++;
        try {
          results[i] = await importOne(files[i]);
        } catch (e) {
          console.error(files[i].name, e);
          errors.push(files[i].name + '：' + e.message);
        }
        done++;
        report();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    progress.hidden = true;

    const created = results.filter(Boolean);
    if (created.length) {
      shelfLayout(created, cx, cy);
      OE.editor.addItems(created);
    }
    let msg = `已匯入 ${created.length} 個檔案`;
    if (errors.length) msg += `，${errors.length} 個失敗（${errors[0]}${errors.length > 1 ? ' 等' : ''}）`;
    if (skipped) msg += `，略過 ${skipped} 個不支援的檔案`;
    OE.util.toast(msg, errors.length ? 6000 : 2500);
    return created;
  }

  OE.importer = { importFiles, importOne, shelfLayout, kindOf };
})(window.OE);
