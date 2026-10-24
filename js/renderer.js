// 畫布渲染器
//
// 效能策略：
// 1. 空間索引 (uniform grid)：只查詢與畫面範圍相交的物件，畫面外的完全不處理。
// 2. LOD 金字塔：匯入時預先產生 64/256/1024/2048px 的縮圖，依物件在螢幕上的實際像素
//    大小挑選最接近的層級，鏡頭拉遠時只解碼小圖。
// 3. 極度縮小（螢幕上 < 6px）時直接畫平均色色塊，不載入任何圖片。
// 4. 尚未載入的層級先用已載入的其他層級或色塊代替，避免閃爍。
// 5. 解碼後的圖片放在 LRU 快取，超過記憶體預算就釋放最久沒用到的。
// 6. 只在畫面有變動時重畫（dirty flag + requestAnimationFrame）。
(function (OE) {
  'use strict';

  const CELL = 2048;            // 空間索引格子大小（世界單位）
  const MAX_LOADING = 6;        // 同時載入的圖片數
  const MEM_BUDGET = 512e6;     // 解碼後圖片的記憶體預算（bytes）
  const TINY_PX = 6;            // 小於此螢幕像素直接畫色塊
  const MIN_SCALE = 0.002, MAX_SCALE = 40;

  const cam = { x: 0, y: 0, s: 1 };
  OE.cam = cam;

  let canvas, ctx, overlay, octx;
  let W = 0, H = 0, dpr = 1;
  let scheduled = false;
  let frame = 0;

  // ---- 空間索引 ----
  let grid = new Map();
  let bigItems = [];
  let indexedVersion = -1;
  let queryStamp = 0;

  function rebuildIndex() {
    grid = new Map();
    bigItems = [];
    const items = OE.store.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const b = OE.util.itemAABB(it);
      it._b = b;
      const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
      const y0 = Math.floor(b.minY / CELL), y1 = Math.floor(b.maxY / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { bigItems.push(i); continue; }
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const k = gx + ',' + gy;
          let cell = grid.get(k);
          if (!cell) grid.set(k, (cell = []));
          cell.push(i);
        }
      }
    }
    indexedVersion = OE.store.version;
  }

  // 回傳與矩形相交的物件索引（依圖層順序排序）
  function query(minX, minY, maxX, maxY) {
    if (indexedVersion !== OE.store.version) rebuildIndex();
    const items = OE.store.items;
    const out = [];
    const hit = (i) => {
      const b = items[i]._b;
      return b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY;
    };
    const x0 = Math.floor(minX / CELL), x1 = Math.floor(maxX / CELL);
    const y0 = Math.floor(minY / CELL), y1 = Math.floor(maxY / CELL);
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cells > grid.size) {
      // 鏡頭拉很遠時格子數會爆量，直接掃全部比較快
      for (let i = 0; i < items.length; i++) if (hit(i)) out.push(i);
      return out;
    }
    const stamp = ++queryStamp;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const cell = grid.get(gx + ',' + gy);
        if (!cell) continue;
        for (const i of cell) {
          const it = items[i];
          if (it._q === stamp) continue;
          it._q = stamp;
          if (hit(i)) out.push(i);
        }
      }
    }
    for (const i of bigItems) if (hit(i)) out.push(i);
    out.sort((a, b) => a - b);
    return out;
  }

  // ---- 圖片快取與載入佇列 ----
  const cache = new Map(); // path -> { state, img, bytes, last }
  let memBytes = 0;
  let loading = 0;
  let wanted = [];

  function ready(path) {
    const e = cache.get(path);
    if (e && e.state === 'ready') { e.last = frame; return e.img; }
    return null;
  }

  function pump() {
    for (const path of wanted) {
      if (loading >= MAX_LOADING) break;
      if (cache.has(path)) continue;
      startLoad(path);
    }
  }

  function startLoad(path) {
    const e = { state: 'loading', img: null, bytes: 0, last: frame };
    cache.set(path, e);
    loading++;
    const img = new Image();
    img.decoding = 'async';
    img.src = OE.store.url(path);
    img.decode().then(() => {
      if (cache.get(path) !== e) return;
      e.img = img;
      e.state = 'ready';
      e.bytes = img.naturalWidth * img.naturalHeight * 4;
      memBytes += e.bytes;
    }).catch(() => {
      e.state = 'error';
    }).finally(() => {
      loading--;
      requestDraw();
      pump();
    });
  }

  function evict() {
    if (memBytes <= MEM_BUDGET) return;
    const list = [];
    for (const [k, e] of cache) if (e.state === 'ready' && e.last < frame) list.push([k, e]);
    list.sort((a, b) => a[1].last - b[1].last);
    for (const [k, e] of list) {
      if (memBytes <= MEM_BUDGET * 0.75) break;
      cache.delete(k);
      memBytes -= e.bytes;
      e.img.src = '';
    }
  }

  // 依螢幕像素挑選 LOD 路徑
  function pickPath(it, px) {
    const lods = it.lods;
    for (let i = 0; i < lods.length; i++) {
      if (lods[i].s >= px * 0.85) return lods[i].p;
    }
    if (it.type === 'video') return lods.length ? lods[lods.length - 1].p : null;
    return it.src;
  }

  // 目標層級還沒載入時，找一張已載入的替代圖
  function fallback(it, target) {
    const lods = it.lods;
    let best = null;
    for (let i = lods.length - 1; i >= 0; i--) {
      if (lods[i].p === target) continue;
      const img = ready(lods[i].p);
      if (img) { best = img; break; }
    }
    if (!best && it.type === 'image' && target !== it.src) best = ready(it.src);
    return best;
  }

  // ---- 繪製 ----
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    for (const c of [canvas, overlay]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    requestDraw();
  }

  function requestDraw() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(draw);
  }

  function drawDots() {
    // 背景點陣，依縮放自動調整間距
    let step = 40;
    while (step * cam.s < 18) step *= 4;
    while (step * cam.s > 120) step /= 4;
    const sp = step * cam.s * dpr;
    const ox = ((W / 2 - cam.x * cam.s) * dpr) % sp;
    const oy = ((H / 2 - cam.y * cam.s) * dpr) % sp;
    const r = Math.max(1, dpr);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let x = ox < 0 ? ox + sp : ox; x < canvas.width; x += sp) {
      for (let y = oy < 0 ? oy + sp : oy; y < canvas.height; y += sp) {
        ctx.fillRect(x, y, r, r);
      }
    }
  }

  function drawPlayBadge(it, s) {
    // 影片的播放圖示，固定螢幕大小
    const k = 1 / s;
    const r = Math.min(26 * dpr, (Math.min(it.w, it.h) * s) / 4) * k;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(-r * 0.32, -r * 0.45);
    ctx.lineTo(r * 0.5, 0);
    ctx.lineTo(-r * 0.32, r * 0.45);
    ctx.closePath();
    ctx.fill();
  }

  function drawFrames(frames, s, cw, ch) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${12 * dpr}px "Segoe UI", "Microsoft JhengHei", sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const f of frames) {
      const x = (f.x - f.w / 2 - cam.x) * s + cw / 2, y = (f.y - f.h / 2 - cam.y) * s + ch / 2;
      ctx.strokeStyle = f.color || '#ffb84c';
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.strokeRect(x, y, f.w * s, f.h * s);
      ctx.setLineDash([]);
      ctx.fillStyle = f.color || '#ffb84c';
      const label = (f.name || '框線') + '  ' + Math.round(f.w) + '×' + Math.round(f.h);
      ctx.fillText(label, x, y - 3 * dpr);
    }
  }

  // 框線只有邊框與名稱標籤可以點選，內部可以穿透點到圖片或開始框選
  function hitFrame(f, wx, wy) {
    const tol = 6 / cam.s;
    const minX = f.x - f.w / 2, minY = f.y - f.h / 2, maxX = f.x + f.w / 2, maxY = f.y + f.h / 2;
    if (wx >= minX && wx <= minX + 180 / cam.s && wy >= minY - 18 / cam.s && wy <= minY) return true;
    const inOuter = wx >= minX - tol && wx <= maxX + tol && wy >= minY - tol && wy <= maxY + tol;
    const inInner = wx > minX + tol && wx < maxX - tol && wy > minY + tol && wy < maxY - tol;
    return inOuter && !inInner;
  }

  const stats = { drawMs: 0, visible: 0, drawnImages: 0, colorBlocks: 0, cached: 0, memMB: 0 };

  function draw() {
    scheduled = false;
    frame++;
    const t0 = performance.now();
    const cw = canvas.width, ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b1c1f';
    ctx.fillRect(0, 0, cw, ch);
    drawDots();

    const s = cam.s * dpr;
    const hw = W / 2 / cam.s, hh = H / 2 / cam.s;
    const vis = query(cam.x - hw, cam.y - hh, cam.x + hw, cam.y + hh);
    const items = OE.store.items;
    const need = [];
    let drawnImages = 0, colorBlocks = 0;
    // 畫面內物件越多，就讓越大的物件改用色塊（避免拉遠時大量 drawImage 卡頓）
    const tiny = vis.length > 3000 ? 28 : vis.length > 1200 ? 14 : TINY_PX;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = cam.s < 1 ? 'medium' : 'high';

    const frames = [];
    for (const i of vis) {
      const it = items[i];
      if (it.type === 'frame') { frames.push(it); continue; }
      if (it.type === 'text') {
        if (it._editing) continue;
        const cos = Math.cos(it.rot) * s, sin = Math.sin(it.rot) * s;
        ctx.setTransform(cos, sin, -sin, cos, (it.x - cam.x) * s + cw / 2, (it.y - cam.y) * s + ch / 2);
        if (it.fs * s < 3) {
          // 太小看不清楚時畫成淡色條，省效能
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = it.color;
          ctx.fillRect(-it.w / 2, -it.h / 4, it.w, it.h / 2);
          ctx.globalAlpha = 1;
        } else {
          OE.util.drawText(ctx, it);
        }
        continue;
      }
      const px = Math.max(it.w, it.h) * s;
      if (px < tiny && it.rot === 0) {
        // 未旋轉的小色塊直接用螢幕座標畫，省去 setTransform
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = it.color;
        ctx.fillRect((it.x - it.w / 2 - cam.x) * s + cw / 2, (it.y - it.h / 2 - cam.y) * s + ch / 2, it.w * s, it.h * s);
        colorBlocks++;
        continue;
      }
      const cos = Math.cos(it.rot) * s, sin = Math.sin(it.rot) * s;
      ctx.setTransform(cos, sin, -sin, cos, (it.x - cam.x) * s + cw / 2, (it.y - cam.y) * s + ch / 2);
      const x0 = -it.w / 2, y0 = -it.h / 2;
      if (px < tiny) {
        ctx.fillStyle = it.color;
        ctx.fillRect(x0, y0, it.w, it.h);
        colorBlocks++;
        continue;
      }
      const path = pickPath(it, px);
      let img = path ? ready(path) : null;
      if (!img) {
        if (path) need.push({ p: path, d: (it.x - cam.x) ** 2 + (it.y - cam.y) ** 2 });
        img = fallback(it, path);
      }
      if (img) {
        ctx.drawImage(img, x0, y0, it.w, it.h);
        drawnImages++;
      } else {
        ctx.fillStyle = it.color;
        ctx.fillRect(x0, y0, it.w, it.h);
        colorBlocks++;
      }
      if (it.type === 'video' && px > 48 && !(OE.video && OE.video.isPlaying(it.id))) drawPlayBadge(it, s);
    }

    // 框線只在編輯模式顯示，畫在所有圖片之上
    if (frames.length && OE.editor && OE.editor.active) drawFrames(frames, s, cw, ch);

    // 越靠近畫面中心的越優先載入
    need.sort((a, b) => a.d - b.d);
    wanted = need.map((n) => n.p);
    pump();
    evict();

    stats.visible = vis.length;
    stats.drawnImages = drawnImages;
    stats.colorBlocks = colorBlocks;
    stats.cached = cache.size;
    stats.memMB = Math.round(memBytes / 1e6);
    stats.drawMs = +(performance.now() - t0).toFixed(2);

    // 編輯覆蓋層（選取框、控制點）
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (OE.editor && OE.editor.active) OE.editor.drawOverlay(octx, dpr);
    if (OE.video) OE.video.update();
    if (OE.onFrame) OE.onFrame();
  }

  // ---- 座標轉換與鏡頭 ----
  function toWorld(sx, sy) {
    return { x: (sx - W / 2) / cam.s + cam.x, y: (sy - H / 2) / cam.s + cam.y };
  }

  function toScreen(wx, wy) {
    return { x: (wx - cam.x) * cam.s + W / 2, y: (wy - cam.y) * cam.s + H / 2 };
  }

  function zoomAt(sx, sy, factor) {
    const before = toWorld(sx, sy);
    cam.s = OE.util.clamp(cam.s * factor, MIN_SCALE, MAX_SCALE);
    cam.x = before.x - (sx - W / 2) / cam.s;
    cam.y = before.y - (sy - H / 2) / cam.s;
    requestDraw();
  }

  function panBy(dx, dy) {
    cam.x -= dx / cam.s;
    cam.y -= dy / cam.s;
    requestDraw();
  }

  let anim = 0;
  function animateTo(target, ms = 450) {
    cancelAnimationFrame(anim);
    const from = { x: cam.x, y: cam.y, s: cam.s };
    const t0 = performance.now();
    const ls0 = Math.log(from.s), ls1 = Math.log(target.s);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      cam.s = Math.exp(ls0 + (ls1 - ls0) * e);
      cam.x = from.x + (target.x - from.x) * e;
      cam.y = from.y + (target.y - from.y) * e;
      requestDraw();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function stopAnimation() {
    cancelAnimationFrame(anim);
  }

  function fitBounds(b, animate = true, padding = 0.08) {
    if (!b) return;
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const s = OE.util.clamp(Math.min(W / bw, H / bh) * (1 - padding * 2), MIN_SCALE, MAX_SCALE);
    const target = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, s };
    if (animate) animateTo(target);
    else { Object.assign(cam, target); requestDraw(); }
  }

  function fitAll(animate = true) {
    const editing = OE.editor && OE.editor.active;
    const list = editing ? OE.store.items : OE.store.items.filter((it) => it.type !== 'frame');
    fitBounds(OE.util.unionAABB(list.length ? list : OE.store.items), animate);
  }

  // 由上往下找出點到的物件（編輯模式下框線優先）
  function pick(wx, wy) {
    const items = OE.store.items;
    const r = 200 / cam.s;
    const list = query(wx - r, wy - r, wx + r, wy + r);
    const editing = OE.editor && OE.editor.active;
    if (editing) {
      for (let k = list.length - 1; k >= 0; k--) {
        const it = items[list[k]];
        if (it.type === 'frame' && hitFrame(it, wx, wy)) return it;
      }
    }
    for (let k = list.length - 1; k >= 0; k--) {
      const it = items[list[k]];
      if (it.type !== 'frame' && OE.util.hitItem(it, wx, wy)) return it;
    }
    return null;
  }

  OE.renderer = {
    init() {
      canvas = document.getElementById('canvas');
      overlay = document.getElementById('overlay');
      ctx = canvas.getContext('2d', { alpha: false });
      octx = overlay.getContext('2d');
      window.addEventListener('resize', resize);
      resize();
    },
    invalidate: requestDraw,
    requestDraw,
    query,
    pick,
    toWorld,
    toScreen,
    zoomAt,
    panBy,
    animateTo,
    stopAnimation,
    fitAll,
    fitBounds,
    stats,
    get width() { return W; },
    get height() { return H; },
    get dpr() { return dpr; },
    MIN_SCALE,
    MAX_SCALE,
  };
})(window.OE);
