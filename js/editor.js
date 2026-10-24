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
    const list = selItems();
    const frames = list.filter((it) => it.type === 'frame').length;
    document.querySelectorAll('#sel-tools button').forEach((b) => {
      const act = b.dataset.act;
      if (!act) return;
      const multi = /^(align|same-h)/.test(act);
      const min = multi ? 2 : 1;
      b.disabled = act === 'arrange' ? OE.store.items.length < 2 : act === 'export' ? frames === 0 : n < min;
    });
    const texts = list.filter((it) => it.type === 'text');
    document.getElementById('text-color-field').hidden = !texts.length;
    if (texts.length) document.getElementById('text-color').value = texts[0].color;
    document.getElementById('btn-export').textContent = frames > 1 ? `輸出 ${frames} 個框線` : '輸出框線';
    updateSpacingUI();
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
    if (canRotate() && near(rotHandle(f))) return { type: 'rotate' };
    const corners = frameCorners(f);
    for (let i = 0; i < 4; i++) if (near(corners[i])) return { type: 'scale', corner: i };
    return null;
  }

  function canRotate() {
    return selItems().some((it) => it.type !== 'frame');
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

  // 匯入過程：整批只算一個復原步驟，每完成一張就先顯示
  function beginImport() {
    pushUndo();
  }

  function appendImported(it) {
    OE.store.items.push(it);
    OE.store.changed();
  }

  function endImport(list) {
    commit();
    setSelection(list.map((it) => it.id));
    OE.renderer.fitBounds(U.unionAABB(list));
    save(true);
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

  const DEFAULT_GAP = 40;

  // 對齊：先把邊緣對齊，再沿另一個方向把重疊的推開（保留原本的前後順序）
  function align(dir) {
    const list = selItems();
    if (list.length < 2) return;
    pushUndo();
    const horizontal = dir === 'left' || dir === 'right';
    // 推開時沿用目前一致的間距，沒有的話用預設值
    const sp = measureSpacing(list);
    const gap = horizontal ? (isFinite(sp.v) ? sp.v : DEFAULT_GAP) : (isFinite(sp.h) ? sp.h : DEFAULT_GAP);
    const all = U.unionAABB(list);
    for (const it of list) {
      const b = U.itemAABB(it);
      if (dir === 'left') it.x += all.minX - b.minX;
      else if (dir === 'right') it.x += all.maxX - b.maxX;
      else if (dir === 'top') it.y += all.minY - b.minY;
      else it.y += all.maxY - b.maxY;
    }
    const lo = horizontal ? 'minY' : 'minX', hi = horizontal ? 'maxY' : 'maxX', key = horizontal ? 'y' : 'x';
    const other = horizontal ? 'minX' : 'minY';
    const sorted = list
      .map((it) => ({ it, b: U.itemAABB(it) }))
      .sort((a, b) => a.b[lo] - b.b[lo] || a.b[other] - b.b[other]);
    let cursor = -Infinity;
    for (const { it, b } of sorted) {
      if (b[lo] < cursor + gap) it[key] += cursor + gap - b[lo];
      cursor = U.itemAABB(it)[hi];
    }
    commit();
  }

  // ---- 間距 ----
  // 先依縱向重疊分成「列」：橫向間距 = 同一列中相鄰物件的距離；直向間距 = 相鄰兩列的距離
  function rowsOf(list) {
    const boxes = list.map((it) => ({ it, b: U.itemAABB(it) })).sort((a, b) => a.b.minY - b.b.minY);
    const rows = [];
    let cur = null;
    for (const e of boxes) {
      if (cur && e.b.minY < cur.maxY - 0.5) {
        cur.items.push(e);
        cur.maxY = Math.max(cur.maxY, e.b.maxY);
      } else {
        cur = { items: [e], minY: e.b.minY, maxY: e.b.maxY };
        rows.push(cur);
      }
    }
    for (const r of rows) r.items.sort((a, b) => a.b.minX - b.b.minX);
    return rows;
  }

  // 回傳 { h, v }：數值 = 一致的間距；NaN = 不一致；null = 沒有可量的間距
  function measureSpacing(list) {
    const rows = rowsOf(list);
    const hs = [], vs = [];
    for (const r of rows) for (let i = 1; i < r.items.length; i++) hs.push(r.items[i].b.minX - r.items[i - 1].b.maxX);
    for (let i = 1; i < rows.length; i++) vs.push(rows[i].minY - rows[i - 1].maxY);
    const uniform = (arr) => {
      if (!arr.length) return null;
      const lo = Math.min(...arr), hi = Math.max(...arr);
      return hi - lo <= 1 ? (lo + hi) / 2 : NaN;
    };
    return { h: uniform(hs), v: uniform(vs) };
  }

  function setSpacing(axis, gap) {
    const list = selItems();
    if (list.length < 2 || !isFinite(gap)) return;
    const rows = rowsOf(list);
    pushUndo();
    if (axis === 'h') {
      for (const r of rows) {
        let cursor = r.items[0].b.maxX;
        for (let i = 1; i < r.items.length; i++) {
          const { it, b } = r.items[i];
          const dx = cursor + gap - b.minX;
          it.x += dx;
          cursor = b.maxX + dx;
        }
      }
    } else {
      let cursor = rows[0].maxY;
      for (let i = 1; i < rows.length; i++) {
        const dy = cursor + gap - rows[i].minY;
        for (const { it } of rows[i].items) it.y += dy;
        cursor = rows[i].maxY + dy;
      }
    }
    commit();
    updateSpacingUI();
  }

  function updateSpacingUI() {
    const list = selItems();
    const sp = list.length >= 2 ? measureSpacing(list) : { h: null, v: null };
    for (const [axis, val] of [['h', sp.h], ['v', sp.v]]) {
      const input = document.getElementById('gap-' + axis);
      if (document.activeElement === input) continue;
      input.disabled = val === null;
      input.value = val === null ? '' : isNaN(val) ? '' : String(Math.round(val));
      input.placeholder = val === null ? '—' : '?';
    }
  }

  // ---- 複製 / 貼上 ----
  let clipboard = null;

  function cloneItems(list, dx, dy) {
    return list.map((it) => Object.assign(JSON.parse(JSON.stringify(it, (k, v) => (k[0] === '_' ? undefined : v))), {
      id: U.uid(), x: it.x + dx, y: it.y + dy,
    }));
  }

  function duplicate() {
    const list = selItems();
    if (!list.length) return;
    const off = 30 / OE.cam.s;
    const copies = cloneItems(list, off, off);
    for (const c of copies) if (c.type === 'frame') c.name = nextFrameName(c.name);
    addItems(copies);
  }

  function copySelection() {
    const list = selItems();
    if (!list.length) return;
    clipboard = JSON.parse(OE.store.snapshot()).filter((it) => selected.has(it.id));
    U.toast(`已複製 ${clipboard.length} 個物件`);
  }

  function paste() {
    if (!clipboard || !clipboard.length) return;
    const b = U.unionAABB(clipboard);
    const target = OE.editor.lastPointer || { x: OE.cam.x, y: OE.cam.y };
    const copies = cloneItems(clipboard, target.x - (b.minX + b.maxX) / 2, target.y - (b.minY + b.maxY) / 2);
    for (const c of copies) if (c.type === 'frame') c.name = nextFrameName(c.name);
    addItems(copies);
  }

  // ---- 框線 ----
  let tool = null; // null | 'frame' | 'text'

  function nextFrameName(base) {
    const names = new Set(OE.store.items.filter((it) => it.type === 'frame').map((it) => it.name));
    const stem = (base || '框線').replace(/\s*\d+$/, '') || '框線';
    let n = 1;
    while (names.has(stem + ' ' + n)) n++;
    return stem + ' ' + n;
  }

  function makeFrame(minX, minY, maxX, maxY) {
    return {
      id: U.uid(), type: 'frame', name: nextFrameName('框線'), color: '#ffb84c',
      x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, rot: 0,
    };
  }

  function setTool(t) {
    tool = t;
    document.getElementById('btn-frame').classList.toggle('primary', t === 'frame');
    document.getElementById('btn-text').classList.toggle('primary', t === 'text');
    document.getElementById('stage').style.cursor = t === 'frame' ? 'crosshair' : t === 'text' ? 'text' : '';
  }

  // 有選取圖片時：直接建立包住選取範圍的框線；否則進入「拉框」工具
  function frameAction() {
    const list = selItems().filter((it) => it.type !== 'frame');
    if (list.length) {
      const b = U.unionAABB(list);
      const pad = 40;
      addItems([makeFrame(b.minX - pad, b.minY - pad, b.maxX + pad, b.maxY + pad)]);
      return;
    }
    setTool(tool === 'frame' ? null : 'frame');
    if (tool) U.toast('在畫布上拖曳拉出框線範圍（Esc 取消）');
  }

  // ---- 文字 ----
  let textColor = '#ffffff';
  let editor = null; // 正在編輯的 { it, ta, isNew }

  function textAction() {
    setTool(tool === 'text' ? null : 'text');
    if (tool) U.toast('在畫布上點一下輸入文字（Esc 取消）');
  }

  function createText(w) {
    const it = {
      id: U.uid(), type: 'text', text: '', fs: Math.max(12, Math.round(36 / OE.cam.s)),
      color: textColor, weight: 400, rot: 0, x: 0, y: 0, w: 0, h: 0,
    };
    U.measureText(it);
    it.x = w.x + it.w / 2;
    it.y = w.y + it.h / 2;
    addItems([it]);
    editText(it, true);
  }

  // 在文字位置疊一個 textarea 直接輸入；Enter 換行，Ctrl+Enter / Esc / 點別處 完成
  function editText(it, isNew) {
    finishEdit();
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.value = it.text;
    ta.spellcheck = false;
    document.body.appendChild(ta);
    editor = { it, ta, isNew: !!isNew, before: OE.store.snapshot() };
    it._editing = true;
    const place = () => {
      const s = OE.cam.s;
      const p = OE.renderer.toScreen(it.x - it.w / 2, it.y - it.h / 2);
      Object.assign(ta.style, {
        left: p.x + 'px', top: p.y + 'px',
        width: Math.max(40, it.w * s + it.fs * s) + 'px', height: Math.max(20, it.h * s + 4) + 'px',
        fontSize: it.fs * s + 'px', lineHeight: U.TEXT_LINE, color: it.color, fontWeight: it.weight || 400,
        fontFamily: U.TEXT_FONT,
      });
    };
    editor.place = place;
    place();
    ta.addEventListener('input', () => {
      it.text = ta.value;
      U.measureText(it);
      it.x = it.x; // 左上角固定
      place();
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishEdit(); }
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => setTimeout(() => { if (editor && editor.ta === ta) finishEdit(); }, 0));
    // 固定左上角：記下編輯前的左上
    const left = it.x - it.w / 2, top = it.y - it.h / 2;
    ta.addEventListener('input', () => { it.x = left + it.w / 2; it.y = top + it.h / 2; place(); OE.renderer.requestDraw(); });
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
    OE.renderer.requestDraw();
  }

  function finishEdit() {
    if (!editor) return;
    const { it, ta, isNew, before } = editor;
    editor = null;
    ta.remove();
    delete it._editing;
    it.text = it.text.replace(/\s+$/, '');
    if (!it.text.trim()) {
      // 空白文字直接移除
      OE.store.items = OE.store.items.filter((x) => x !== it);
      if (isNew) undoStack.pop();
      selected.delete(it.id);
    } else {
      U.measureText(it);
      if (!isNew && before !== OE.store.snapshot()) { undoStack.push(before); redoStack.length = 0; }
    }
    commit();
    selectionChanged();
  }

  function setTextColor(color, record) {
    const list = selItems().filter((it) => it.type === 'text');
    textColor = color;
    if (!list.length) return;
    if (record) pushUndo();
    for (const it of list) it.color = color;
    if (editor) editor.ta.style.color = color;
    OE.store.changed();
  }

  function renameFrame(it) {
    const name = prompt('框線名稱（也會用在輸出的檔名）', it.name || '');
    if (name === null || !name.trim()) return;
    pushUndo();
    it.name = name.trim();
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
    document.getElementById('align-menu').hidden = true;
    if (tool === 'frame') {
      drag = { type: 'newframe', start: w, cur: w, moved: false };
      return;
    }
    if (tool === 'text') {
      setTool(null);
      createText(w);
      return;
    }
    if (editor) finishEdit();
    const h = selected.size ? hitHandle(sx, sy) : null;

    if (h) {
      const list = selItems();
      const f = selectionFrame();
      drag = {
        type: h.type, start: w, frame0: f, moved: false,
        items0: list.map((it) => ({ it, x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot, fs: it.fs })),
      };
      if (h.type === 'scale') {
        drag.freeResize = list.length === 1 && list[0].type === 'frame';
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
    OE.editor.lastPointer = w;
    if (!drag) {
      if (tool) return;
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
      if (drag.type !== 'marquee' && drag.type !== 'newframe') pushUndo();
    }

    if (drag.type === 'move') {
      let dx = w.x - drag.start.x, dy = w.y - drag.start.y;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      for (const o of drag.items0) { o.it.x = o.x + dx; o.it.y = o.y + dy; }
    } else if (drag.type === 'newframe') {
      drag.cur = w;
      R.requestDraw();
      return;
    } else if (drag.type === 'scale' && drag.freeResize) {
      // 框線可以自由調整長寬（Shift 維持比例）
      const o = drag.items0[0];
      const a = e.altKey ? { x: drag.frame0.cx, y: drag.frame0.cy } : drag.anchor;
      let fw = Math.abs(w.x - a.x) * (e.altKey ? 2 : 1), fh = Math.abs(w.y - a.y) * (e.altKey ? 2 : 1);
      if (e.shiftKey) { const k = Math.max(fw / o.w, fh / o.h); fw = o.w * k; fh = o.h * k; }
      fw = Math.max(fw, 4 / OE.cam.s);
      fh = Math.max(fh, 4 / OE.cam.s);
      o.it.w = fw;
      o.it.h = fh;
      if (e.altKey) { o.it.x = a.x; o.it.y = a.y; }
      else {
        o.it.x = a.x + Math.sign(w.x - a.x || 1) * fw / 2;
        o.it.y = a.y + Math.sign(w.y - a.y || 1) * fh / 2;
      }
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
        if (o.it.type === 'text') o.it.fs = o.fs * k;
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
        if (o.it.type !== 'frame') o.it.rot = normAngle(o.rot + da);
      }
      drag.rotDelta = da;
    } else if (drag.type === 'marquee') {
      drag.cur = w;
      const minX = Math.min(drag.start.x, w.x), maxX = Math.max(drag.start.x, w.x);
      const minY = Math.min(drag.start.y, w.y), maxY = Math.max(drag.start.y, w.y);
      const ids = new Set(drag.additive ? drag.base : []);
      for (const i of R.query(minX, minY, maxX, maxY)) {
        const it = OE.store.items[i];
        if (it.type === 'frame') {
          const b = U.itemAABB(it);
          if (b.minX < minX || b.maxX > maxX || b.minY < minY || b.maxY > maxY) continue;
        }
        ids.add(it.id);
      }
      setSelection(ids);
      return;
    }
    OE.store.changed();
  }

  function pointerUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.type === 'newframe') {
      setTool(null);
      const minX = Math.min(d.start.x, d.cur.x), maxX = Math.max(d.start.x, d.cur.x);
      const minY = Math.min(d.start.y, d.cur.y), maxY = Math.max(d.start.y, d.cur.y);
      if ((maxX - minX) * OE.cam.s > 6 && (maxY - minY) * OE.cam.s > 6) addItems([makeFrame(minX, minY, maxX, maxY)]);
      OE.renderer.requestDraw();
      return;
    }
    if (d.moved && d.type !== 'marquee') commit();
    updateSpacingUI();
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
    if (editor) editor.place();
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
      const rotOK = canRotate();
      const rh = P(rotHandle(f).x, rotHandle(f).y);
      const topMid = P(f.cx + (f.h / 2) * Math.sin(f.rot), f.cy - (f.h / 2) * Math.cos(f.rot));
      if (rotOK) { g.beginPath(); g.moveTo(topMid[0], topMid[1]); g.lineTo(rh[0], rh[1]); g.stroke(); }
      const hs = HANDLE * dpr;
      g.fillStyle = '#fff';
      for (const [x, y] of cs) {
        g.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        g.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
      }
      if (rotOK) { g.beginPath(); g.arc(rh[0], rh[1], hs / 2 + 1, 0, Math.PI * 2); g.fill(); g.stroke(); }

      if (drag && drag.moved && drag.type === 'rotate' && list.length === 1) {
        label(g, rh[0] + 14 * dpr, rh[1], Math.round((list[0].rot * 180) / Math.PI) + '°', dpr);
      }
    }

    // 正在拉的新框線
    if (drag && drag.type === 'newframe' && drag.moved) {
      const a = P(drag.start.x, drag.start.y), b = P(drag.cur.x, drag.cur.y);
      g.strokeStyle = '#ffb84c';
      g.setLineDash([6 * dpr, 4 * dpr]);
      g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
      g.setLineDash([]);
      label(g, Math.min(a[0], b[0]), Math.min(a[1], b[1]) - 14 * dpr,
        Math.round(Math.abs(drag.cur.x - drag.start.x)) + '×' + Math.round(Math.abs(drag.cur.y - drag.start.y)), dpr);
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
      case 'align-menu': {
        const m = document.getElementById('align-menu');
        m.hidden = !m.hidden;
        return true;
      }
      case 'align-left': align('left'); break;
      case 'align-right': align('right'); break;
      case 'align-top': align('top'); break;
      case 'align-bottom': align('bottom'); break;
      case 'frame': frameAction(); break;
      case 'text': textAction(); break;
      case 'duplicate': duplicate(); break;
      case 'export': OE.exporter.open(selItems().filter((it) => it.type === 'frame')); break;
      case 'arrange': arrange(); break;
      case 'same-h': sameHeight(); break;
      case 'front': reorder(true); break;
      case 'back': reorder(false); break;
      case 'reset-rot': resetRotation(); break;
      case 'delete': deleteSelected(); break;
      case 'help': document.getElementById('help').hidden = !document.getElementById('help').hidden; break;
      default: return false;
    }
    document.getElementById('align-menu').hidden = true;
    return true;
  }

  function keyDown(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (ctrl && (k === 'z' || k === 'Z')) { e.shiftKey ? redo() : undo(); }
    else if (ctrl && (k === 'y' || k === 'Y')) redo();
    else if (ctrl && (k === 's' || k === 'S')) save(false);
    else if (ctrl && (k === 'a' || k === 'A')) setSelection(OE.store.items.map((it) => it.id));
    else if (ctrl && (k === 'd' || k === 'D')) duplicate();
    else if (ctrl && (k === 'c' || k === 'C')) copySelection();
    else if (ctrl && (k === 'v' || k === 'V')) paste();
    else if (!ctrl && (k === 'r' || k === 'R')) frameAction();
    else if (!ctrl && (k === 't' || k === 'T')) textAction();
    else if (k === 'Enter' && selected.size === 1 && selItems()[0].type === 'text') editText(selItems()[0]);
    else if (ctrl && k === ']') reorder(true);
    else if (ctrl && k === '[') reorder(false);
    else if (k === 'Delete' || k === 'Backspace') deleteSelected();
    else if (k === 'Escape') { if (tool) setTool(null); else setSelection([]); }
    else if (k === 'f' || k === 'F') {
      const list = selItems();
      if (list.length) OE.renderer.fitBounds(U.unionAABB(list));
      else return false;
    } else if (ctrl && k.startsWith('Arrow') && selected.size >= 2) {
      // Ctrl+方向鍵：往該方向對齊（不重疊）
      align({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[k]);
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
      const tc = document.getElementById('text-color');
      let colorRecorded = false;
      tc.addEventListener('input', () => { setTextColor(tc.value, !colorRecorded); colorRecorded = true; });
      tc.addEventListener('change', () => { colorRecorded = false; commit(); });
      for (const axis of ['h', 'v']) {
        const input = document.getElementById('gap-' + axis);
        const apply = () => {
          if (input.value.trim() === '') { updateSpacingUI(); return; }
          setSpacing(axis, Math.max(-100000, Number(input.value)));
        };
        input.addEventListener('change', apply);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { apply(); input.blur(); }
          if (e.key === 'Escape') { input.blur(); updateSpacingUI(); }
          e.stopPropagation();
        });
        input.addEventListener('blur', () => setTimeout(updateSpacingUI, 0));
      }
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
      if (!on) { selected.clear(); hoverId = null; drag = null; setTool(null); }
      selectionChanged();
    },
    pointerDown,
    pointerMove,
    pointerUp,
    drawOverlay,
    keyDown,
    action,
    addItems,
    beginImport,
    appendImported,
    endImport,
    setSelection,
    setSpacing,
    measureSpacing,
    renameFrame,
    align,
    lastPointer: null,
    get tool() { return tool; },
    editText,
    finishEdit,
    setTextColor,
    get selection() { return selItems(); },
    get dragging() { return !!drag; },
  };
})(window.OE);
