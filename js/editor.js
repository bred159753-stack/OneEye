// 編輯模式（管理者）：選取、移動、等比縮放、旋轉、框選、對齊、復原、儲存
(function (OE) {
  'use strict';

  const U = OE.util;
  const HANDLE = 9;          // 控制點大小（螢幕 px）
  const ROT_OFFSET = 26;     // 旋轉把手距離外框（螢幕 px）
  const ACCENT = '#4c8dff';

  const selected = new Set(); // item id
  const undoStack = [];
  const redoStack = [];
  let drag = null;
  let hoverId = null;

  // ---- 選取 ----
  function selItems() {
    const out = [];
    for (const it of OE.store.items) if (selected.has(it.id)) out.push(it);
    return out;
  }

  function setSelection(ids) {
    selected.clear();
    for (const id of ids) selected.add(id);
    selectionChanged();
  }

  function selectionChanged() {
    for (const id of [...selected]) if (!OE.store.get(id)) selected.delete(id);
    const n = selected.size;
    document.getElementById('sel-tools').hidden = !OE.editor.active || n === 0;
    document.getElementById('sel-count').textContent = '已選 ' + n;
    document.querySelectorAll('#sel-tools button').forEach((b) => {
      const multi = /^(align|dist|same-h)/.test(b.dataset.act);
      const min = b.dataset.act.startsWith('dist') ? 3 : multi ? 2 : 1;
      b.disabled = b.dataset.act === 'arrange' ? OE.store.items.length < 2 : n < min;
    });
    OE.renderer.requestDraw();
  }

  // 選取外框：單選時跟著物件旋轉，多選時用整體 AABB
  function selectionFrame() {
    const list = selItems();
    if (!list.length) return null;
    if (list.length === 1) {
      const it = list[0];
      return { cx: it.x, cy: it.y, w: it.w, h: it.h, rot: it.rot };
    }
    const b = U.unionAABB(list);
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, w: b.maxX - b.minX, h: b.maxY - b.minY, rot: 0 };
  }

  function frameCorners(f) {
    const c = Math.cos(f.rot), s = Math.sin(f.rot);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
      const lx = (sx * f.w) / 2, ly = (sy * f.h) / 2;
      return { x: f.cx + lx * c - ly * s, y: f.cy + lx * s + ly * c, sx, sy };
    });
  }

  function rotHandle(f) {
    const s = Math.sin(f.rot), c = Math.cos(f.rot);
    const d = f.h / 2 + ROT_OFFSET / OE.cam.s;
    return { x: f.cx + d * s, y: f.cy - d * c };
  }

  // 判斷滑鼠是否在控制點上（螢幕座標）
  function hitHandle(sx, sy) {
    const f = drag && drag.frame0 ? drag.frame0 : selectionFrame();
    if (!f) return null;
    const R = OE.renderer;
    const near = (p) => {
      const q = R.toScreen(p.x, p.y);
      return Math.abs(q.x - sx) <= HANDLE && Math.abs(q.y - sy) <= HANDLE;
    };
    if (near(rotHandle(f))) return { type: 'rotate' };
    const corners = frameCorners(f);
    for (let i = 0; i < 4; i++) if (near(corners[i])) return { type: 'scale', corner: i };
    return null;
  }

  // ---- 復原 ----
  function pushUndo() {
    undoStack.push(OE.store.snapshot());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(OE.store.snapshot());
    OE.store.restore(undoStack.pop());
    selectionChanged();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(OE.store.snapshot());
    OE.store.restore(redoStack.pop());
    selectionChanged();
  }

  function commit() {
    OE.store.changed();
    scheduleSave();
  }

  // ---- 儲存 ----
  let saving = false;
  const autoSave = U.debounce(() => save(true), 1200);

  function scheduleSave() {
    updateStatus();
    if (OE.store.dir) autoSave();
  }

  async function save(auto) {
    if (!OE.store.dir) {
      if (auto) return;
      if (!(await OE.store.ensureFolder())) return;
    }
    if (saving) { autoSave(); return; }
    saving = true;
    updateStatus('儲存中…');
    try {
      await OE.store.save();
      if (!auto) U.toast('已儲存');
    } catch (e) {
      console.error(e);
      U.toast('儲存失敗：' + e.message, 5000);
    }
    saving = false;
    updateStatus();
  }

  function updateStatus(text) {
    const el = document.getElementById('save-status');
    const folderBtn = document.getElementById('btn-folder');
    const connected = !!OE.store.dir;
    folderBtn.textContent = connected ? '已連接資料夾' : '連接資料夾';
    folderBtn.classList.toggle('primary', !connected);
    el.classList.toggle('warn', !connected || OE.store.unsaved);
    el.textContent = text || (!connected ? '未連接' : OE.store.unsaved ? '未儲存' : '已儲存');
  }

  // ---- 物件操作 ----
  function addItems(list) {
    pushUndo();
    OE.store.items.push(...list);
    commit();
    setSelection(list.map((it) => it.id));
  }

  function deleteSelected() {
    if (!selected.size) return;
    pushUndo();
    for (const id of selected) OE.video.close(id);
    OE.store.items = OE.store.items.filter((it) => !selected.has(it.id));
    selected.clear();
    commit();
    selectionChanged();
  }

  function align(dir) {
    const list = selItems();
    if (list.length < 2) return;
    pushUndo();
    const boxes = list.map((it) => [it, U.itemAABB(it)]);
    const all = U.unionAABB(list);
    for (const [it, b] of boxes) {
      switch (dir) {
        case 'left': it.x += all.minX - b.minX; break;
        case 'right': it.x += all.maxX - b.maxX; break;
        case 'top': it.y += all.minY - b.minY; break;
        case 'bottom': it.y += all.maxY - b.maxY; break;
        case 'hcenter': it.x = (all.minX + all.maxX) / 2; break;
        case 'vcenter': it.y = (all.minY + all.maxY) / 2; break;
      }
    }
    commit();
  }

  function distribute(axis) {
    const list = selItems();
    if (list.length < 3) return;
    pushUndo();
    const lo = axis === 'h' ? 'minX' : 'minY', hi = axis === 'h' ? 'maxX' : 'maxY', key = axis === 'h' ? 'x' : 'y';
    const boxes = list.map((it) => [it, U.itemAABB(it)]).sort((a, b) => a[1][lo] + a[1][hi] - b[1][lo] - b[1][hi]);
    const start = boxes[0][1][lo];
    const end = Math.max(...boxes.map(([, b]) => b[hi]));
    const total = boxes.reduce((s, [, b]) => s + b[hi] - b[lo], 0);
    const gap = (end - start - total) / (boxes.length - 1);
    let pos = start;
    for (const [it, b] of boxes) {
      it[key] += pos - b[lo];
      pos += b[hi] - b[lo] + gap;
    }
    commit();
  }

  function arrange() {
    let list = selItems();
    if (list.length < 2) list = OE.store.items.slice();
    if (list.length < 2) return;
    pushUndo();
    const b = U.unionAABB(list);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    OE.importer.shelfLayout(list, cx, cy);
    commit();
  }

  function sameHeight() {
    const list = selItems();
    if (list.length < 2) return;
    pushUndo();
    const h = list[0].h;
    for (const it of list) {
      const k = h / it.h;
      it.w *= k;
      it.h = h;
    }
    commit();
  }

  function reorder(toFront) {
    if (!selected.size) return;
    pushUndo();
    const sel = OE.store.items.filter((it) => selected.has(it.id));
    const rest = OE.store.items.filter((it) => !selected.has(it.id));
    OE.store.items = toFront ? rest.concat(sel) : sel.concat(rest);
    commit();
  }

  function resetRotation() {
    const list = selItems();
    if (!list.length) return;
    pushUndo();
    for (const it of list) it.rot = 0;
    commit();
  }

  function nudge(dx, dy) {
    const list = selItems();
    if (!list.length) return;
    pushUndo();
    for (const it of list) { it.x += dx / OE.cam.s; it.y += dy / OE.cam.s; }
    commit();
  }

  // ---- 滑鼠操作 ----
  function pointerDown(e, sx, sy) {
    const R = OE.renderer;
    const w = R.toWorld(sx, sy);
    const h = selected.size ? hitHandle(sx, sy) : null;

    if (h) {
      const list = selItems();
      const f = selectionFrame();
      drag = {
        type: h.type, start: w, frame0: f, moved: false,
        items0: list.map((it) => ({ it, x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot })),
      };
      if (h.type === 'scale') {
        const cs = frameCorners(f);
        drag.corner = cs[h.corner];
        drag.anchor = cs[(h.corner + 2) % 4];
      }
      return;
    }

    const it = R.pick(w.x, w.y);
    if (it) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selected.has(it.id)) selected.delete(it.id);
        else selected.add(it.id);
        selectionChanged();
        drag = selected.has(it.id) ? startMove(w) : null;
        return;
      }
      const wasSelected = selected.has(it.id);
      if (!wasSelected) setSelection([it.id]);
      drag = startMove(w);
      drag.clickOnly = wasSelected ? it.id : null; // 放開時沒移動 → 只選它
      return;
    }

    // 空白處 → 框選
    drag = { type: 'marquee', start: w, cur: w, additive: e.shiftKey || e.ctrlKey || e.metaKey, base: new Set(selected) };
    if (!drag.additive) setSelection([]);
  }

  function startMove(w) {
    return {
      type: 'move', start: w, moved: false,
      items0: selItems().map((it) => ({ it, x: it.x, y: it.y })),
    };
  }

  function pointerMove(e, sx, sy) {
    const R = OE.renderer;
    const w = R.toWorld(sx, sy);
    if (!drag) {
      // 游標提示
      const h = selected.size ? hitHandle(sx, sy) : null;
      const stage = document.getElementById('stage');
      stage.style.cursor = h ? (h.type === 'rotate' ? 'crosshair' : 'nwse-resize') : '';
      const it = R.pick(w.x, w.y);
      const id = it ? it.id : null;
      if (id !== hoverId) { hoverId = id; R.requestDraw(); }
      return;
    }

    if (!drag.moved) {
      const s0 = R.toScreen(drag.start.x, drag.start.y);
      if (Math.hypot(s0.x - sx, s0.y - sy) < 3) return;
      drag.moved = true;
      if (drag.type !== 'marquee') pushUndo();
    }

    if (drag.type === 'move') {
      let dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      for (const o of drag.items0) { o.it.x = o.x + dx; o.it.y = o.y + dy; }
    } else if (drag.type === 'scale') {
      const anchor = e.altKey ? { x: drag.frame0.cx, y: drag.frame0.cy } : drag.anchor;
      const d0x = drag.corner.x - anchor.x, d0y = drag.corner.y - anchor.y;
      const len2 = d0x * d0x + d0y * d0y || 1;
      let k = ((w.x - anchor.x) * d0x + (w.y - anchor.y) * d0y) / len2;
      const minSide = Math.min(...drag.items0.map((o) => Math.min(o.w, o.h)));
      k = Math.max(k, 4 / OE.cam.s / minSide);
      for (const o of drag.items0) {
        o.it.x = anchor.x + (o.x - anchor.x) * k;
        o.it.y = anchor.y + (o.y - anchor.y) * k;
        o.it.w = o.w * k;
        o.it.h = o.h * k;
      }
    } else if (drag.type === 'rotate') {
      const f = drag.frame0;
      const a0 = Math.atan2(drag.start.y - f.cy, drag.start.x - f.cx);
      let da = Math.atan2(w.y - f.cy, w.x - f.cx) - a0;
      const snap = Math.PI / 12;
      if (e.shiftKey) {
        const base = drag.items0.length === 1 ? drag.items0[0].rot : 0;
        da = Math.round((base + da) / snap) * snap - base;
      }
      const c = Math.cos(da), s = Math.sin(da);
      for (const o of drag.items0) {
        const rx = o.x - f.cx, ry = o.y - f.cy;
        o.it.x = f.cx + rx * c - ry * s;
        o.it.y = f.cy + rx * s + ry * c;
        o.it.rot = normAngle(o.rot + da);
      }
      drag.rotDelta = da;
    } else if (drag.type === 'marquee') {
      drag.cur = w;
      const minX = Math.min(drag.start.x, w.x), maxX = Math.max(drag.start.x, w.x);
      const minY = Math.min(drag.start.y, w.y), maxY = Math.max(drag.start.y, w.y);
      const ids = new Set(drag.additive ? drag.base : []);
      for (const i of R.query(minX, minY, maxX, maxY)) ids.add(OE.store.items[i].id);
      setSelection(ids);
      return;
    }
    OE.store.changed();
  }

  function pointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved && d.type !== 'marquee') commit();
    if (!d.moved && d.clickOnly && selected.size > 1) setSelection([d.clickOnly]);
    OE.renderer.requestDraw();
  }

  function normAngle(a) {
    a = a % (Math.PI * 2);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  // ---- 覆蓋層繪製（螢幕座標，裝置像素） ----
  function drawOverlay(g, dpr) {
    const R = OE.renderer;
    const P = (x, y) => { const p = R.toScreen(x, y); return [p.x * dpr, p.y * dpr]; };
    const poly = (pts) => {
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
    };
    const itemPoly = (it) => poly(frameCorners({ cx: it.x, cy: it.y, w: it.w, h: it.h, rot: it.rot }).map((c) => P(c.x, c.y)));

    g.lineWidth = 1 * dpr;
    // 滑鼠移過的物件
    if (hoverId && !selected.has(hoverId) && !drag) {
      const it = OE.store.get(hoverId);
      if (it) { g.strokeStyle = 'rgba(76,141,255,0.6)'; itemPoly(it); g.stroke(); }
    }
    // 每個被選取物件的外框
    const list = selItems();
    g.strokeStyle = ACCENT;
    g.lineWidth = (list.length > 1 ? 1 : 1.5) * dpr;
    for (const it of list) { itemPoly(it); g.stroke(); }

    // 選取框與控制點
    let f = selectionFrame();
    if (f && drag && drag.type === 'rotate' && list.length > 1) {
      f = Object.assign({}, drag.frame0, { rot: drag.rotDelta || 0 });
    }
    if (f && !(drag && drag.type === 'marquee')) {
      const cs = frameCorners(f).map((c) => P(c.x, c.y));
      if (list.length > 1) {
        g.setLineDash([4 * dpr, 4 * dpr]);
        poly(cs); g.stroke();
        g.setLineDash([]);
      }
      const rh = P(rotHandle(f).x, rotHandle(f).y);
      const topMid = P(f.cx + (f.h / 2) * Math.sin(f.rot), f.cy - (f.h / 2) * Math.cos(f.rot));
      g.beginPath(); g.moveTo(topMid[0], topMid[1]); g.lineTo(rh[0], rh[1]); g.stroke();
      const hs = HANDLE * dpr;
      g.fillStyle = '#fff';
      for (const [x, y] of cs) {
        g.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        g.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
      }
      g.beginPath(); g.arc(rh[0], rh[1], hs / 2 + 1, 0, Math.PI * 2); g.fill(); g.stroke();

      if (drag && drag.moved && drag.type === 'rotate' && list.length === 1) {
        label(g, rh[0] + 14 * dpr, rh[1], Math.round((list[0].rot * 180) / Math.PI) + '°', dpr);
      }
    }

    // 框選矩形
    if (drag && drag.type === 'marquee' && drag.moved) {
      const a = P(drag.start.x, drag.start.y), b = P(drag.cur.x, drag.cur.y);
      g.fillStyle = 'rgba(76,141,255,0.12)';
      g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
      g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    }
  }

  function label(g, x, y, text, dpr) {
    g.font = `${12 * dpr}px sans-serif`;
    const w = g.measureText(text).width + 10 * dpr;
    g.fillStyle = ACCENT;
    g.fillRect(x, y - 10 * dpr, w, 20 * dpr);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(text, x + 5 * dpr, y);
  }

  // ---- 工具列與快捷鍵 ----
  function action(act) {
    switch (act) {
      case 'folder':
        OE.store.ensureFolder().then((ok) => {
          updateStatus();
          const pend = OE.importer.pending;
          if (ok && pend) {
            OE.importer.pending = null;
            OE.importer.importFiles(pend.files, pend.cx, pend.cy).then(() => OE.store.changed(false));
          } else if (ok && OE.store.unsaved) {
            save(true);
          }
        });
        break;
      case 'import': document.getElementById('file-input').click(); break;
      case 'save': save(false); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'align-left': align('left'); break;
      case 'align-right': align('right'); break;
      case 'align-top': align('top'); break;
      case 'align-bottom': align('bottom'); break;
      case 'align-hcenter': align('hcenter'); break;
      case 'align-vcenter': align('vcenter'); break;
      case 'dist-h': distribute('h'); break;
      case 'dist-v': distribute('v'); break;
      case 'arrange': arrange(); break;
      case 'same-h': sameHeight(); break;
      case 'front': reorder(true); break;
      case 'back': reorder(false); break;
      case 'reset-rot': resetRotation(); break;
      case 'delete': deleteSelected(); break;
      case 'help': document.getElementById('help').hidden = !document.getElementById('help').hidden; break;
      default: return false;
    }
    return true;
  }

  function keyDown(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && (k === 'z' || k === 'Z')) { e.shiftKey ? redo() : undo(); }
    else if (ctrl && (k === 'y' || k === 'Y')) redo();
    else if (ctrl && (k === 's' || k === 'S')) save(false);
    else if (ctrl && (k === 'a' || k === 'A')) setSelection(OE.store.items.map((it) => it.id));
    else if (ctrl && k === ']') reorder(true);
    else if (ctrl && k === '[') reorder(false);
    else if (k === 'Delete' || k === 'Backspace') deleteSelected();
    else if (k === 'Escape') setSelection([]);
    else if (k === 'f' || k === 'F') {
      const list = selItems();
      if (list.length) OE.renderer.fitBounds(U.unionAABB(list));
      else return false;
    } else if (k.startsWith('Arrow') && selected.size) {
      const st = e.shiftKey ? 10 : 1;
      nudge(k === 'ArrowLeft' ? -st : k === 'ArrowRight' ? st : 0, k === 'ArrowUp' ? -st : k === 'ArrowDown' ? st : 0);
    } else return false;
    return true;
  }

  OE.editor = {
    active: false,
    async init() {
      this.active = true;
      document.body.classList.add('edit');
      document.getElementById('toolbar').hidden = false;
      await OE.store.restoreFolder();
      updateStatus();
      selectionChanged();
      OE.store.onChange = () => updateStatus();
      window.addEventListener('beforeunload', (e) => {
        if (OE.store.unsaved) { e.preventDefault(); e.returnValue = ''; }
      });
      if (!OE.store.hasFS()) U.toast('編輯模式請使用 Chrome 或 Edge，才能匯入與儲存', 6000);
      else if (!OE.store.dir) U.toast('請先按「連接資料夾」選擇 OneEye 網站資料夾', 5000);
    },
    setActive(on) {
      this.active = on;
      document.body.classList.toggle('edit', on);
      document.getElementById('toolbar').hidden = !on;
      if (!on) { selected.clear(); hoverId = null; drag = null; }
      selectionChanged();
    },
    pointerDown,
    pointerMove,
    pointerUp,
    drawOverlay,
    keyDown,
    action,
    addItems,
    setSelection,
    get selection() { return selItems(); },
    get dragging() { return !!drag; },
  };
})(window.OE);
