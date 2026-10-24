// 進入點：模式切換、滑鼠/觸控/滾輪輸入、拖曳匯入
(function (OE) {
  'use strict';

  const R = OE.renderer;
  const params = new URLSearchParams(location.search);
  const canEdit = params.has('edit') || location.hash === '#edit';

  const stage = document.getElementById('stage');
  const pointers = new Map(); // pointerId -> {x, y}
  let pan = null;             // { x, y, moved, vx, vy, t }
  let pinch = null;
  let spaceDown = false;
  let inertia = 0;

  console.info('OneEye v5');
  // 任何未預期的錯誤都顯示出來，避免「沒反應」
  window.addEventListener('error', (e) => OE.util.toast('發生錯誤：' + e.message, 8000));
  window.addEventListener('unhandledrejection', (e) => OE.util.toast('發生錯誤：' + (e.reason && e.reason.message ? e.reason.message : e.reason), 8000));

  OE.store.load();
  R.init();
  OE.video.init();

  function localXY(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function updateEmpty() {
    document.getElementById('empty').hidden = OE.store.items.length > 0;
    document.querySelector('#empty .empty-sub').textContent = OE.editor.active
      ? '把圖片或影片（可多選或整個資料夾）拖曳到這裡匯入'
      : '畫布上還沒有作品';
  }

  OE.onFrame = () => {
    document.getElementById('zoom-label').textContent = Math.round(OE.cam.s * 100) + '%';
  };

  // ---- 滾輪：滑鼠滾輪縮放；觸控板雙指平移、捏合縮放 ----
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    R.stopAnimation();
    cancelAnimationFrame(inertia);
    const p = localXY(e);
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    const isMouseWheel = e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy));
    if (e.ctrlKey || e.metaKey) {
      R.zoomAt(p.x, p.y, Math.exp(-dy * 0.01));
    } else if (isMouseWheel) {
      R.zoomAt(p.x, p.y, Math.exp(-dy * 0.0018));
    } else {
      R.panBy(-dx, -dy);
    }
  }, { passive: false });

  // ---- 指標（滑鼠 / 觸控 / 筆） ----
  stage.addEventListener('pointerdown', (e) => {
    R.stopAnimation();
    cancelAnimationFrame(inertia);
    stage.setPointerCapture(e.pointerId);
    const p = localXY(e);
    pointers.set(e.pointerId, p);

    if (pointers.size === 2) {
      // 兩指 → 捏合縮放（取消單指動作）
      if (OE.editor.active) OE.editor.pointerUp();
      pan = null;
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (pointers.size > 2) return;

    const wantPan = !OE.editor.active || e.button === 1 || e.button === 2 || spaceDown;
    if (wantPan) {
      pan = { x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false, vx: 0, vy: 0, t: performance.now(), button: e.button };
      stage.classList.add('panning');
    } else if (e.button === 0) {
      OE.editor.pointerDown(e, p.x, p.y);
    }
  });

  stage.addEventListener('pointermove', (e) => {
    const p = localXY(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      R.panBy(cx - pinch.cx, cy - pinch.cy);
      if (pinch.dist > 0) R.zoomAt(cx, cy, dist / pinch.dist);
      pinch = { dist, cx, cy };
      return;
    }
    if (pan) {
      const dx = p.x - pan.x, dy = p.y - pan.y;
      if (Math.hypot(p.x - pan.sx, p.y - pan.sy) > 4) pan.moved = true;
      const now = performance.now();
      const dt = Math.max(1, now - pan.t);
      pan.vx = pan.vx * 0.6 + (dx / dt) * 0.4;
      pan.vy = pan.vy * 0.6 + (dy / dt) * 0.4;
      pan.t = now;
      pan.x = p.x;
      pan.y = p.y;
      R.panBy(dx, dy);
      return;
    }
    if (OE.editor.active) {
      OE.editor.pointerMove(e, p.x, p.y);
    } else if (e.pointerType === 'mouse') {
      const w = R.toWorld(p.x, p.y);
      const it = R.pick(w.x, w.y);
      stage.classList.toggle('over-video', !!(it && it.type === 'video'));
    }
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (pan) {
      const p = pan;
      pan = null;
      stage.classList.remove('panning');
      if (!p.moved && !OE.editor.active && p.button === 0 && e.type === 'pointerup') {
        // 觀看模式：點擊影片播放/暫停
        const w = R.toWorld(p.x, p.y);
        const it = R.pick(w.x, w.y);
        if (it && it.type === 'video') OE.video.toggle(it.id);
      } else if (p.moved && performance.now() - p.t < 60) {
        startInertia(p.vx, p.vy);
      }
      return;
    }
    if (OE.editor.active) OE.editor.pointerUp(e);
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());

  // 放開時的慣性滑動
  function startInertia(vx, vy) {
    let last = performance.now();
    const step = (now) => {
      const dt = now - last;
      last = now;
      vx *= Math.pow(0.94, dt / 16);
      vy *= Math.pow(0.94, dt / 16);
      if (Math.hypot(vx, vy) < 0.02) return;
      R.panBy(vx * dt, vy * dt);
      inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  }

  // 雙擊：影片播放（編輯模式）或聚焦到該作品
  stage.addEventListener('dblclick', (e) => {
    const p = localXY(e);
    const w = R.toWorld(p.x, p.y);
    const it = R.pick(w.x, w.y);
    if (!it) return;
    if (it.type === 'frame') OE.editor.renameFrame(it);
    else if (it.type === 'text' && OE.editor.active) OE.editor.editText(it);
    else if (it.type === 'video' && OE.editor.active) OE.video.toggle(it.id);
    else if (it.type === 'image') R.fitBounds(OE.util.itemAABB(it), true, 0.04);
  });

  // ---- 鍵盤 ----
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { spaceDown = true; if (OE.editor.active) e.preventDefault(); return; }
    if (OE.editor.active && OE.editor.keyDown(e)) { e.preventDefault(); return; }
    const W = R.width / 2, H = R.height / 2;
    if (e.key === '0' || e.key === 'Home') R.fitAll();
    else if (e.key === '+' || e.key === '=') R.zoomAt(W, H, 1.25);
    else if (e.key === '-' || e.key === '_') R.zoomAt(W, H, 0.8);
    else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });
  window.addEventListener('blur', () => { spaceDown = false; });

  // ---- 按鈕 ----
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.closest('.vid-ui')) return;
    const act = b.dataset.act;
    const W = R.width / 2, H = R.height / 2;
    if (act === 'zoom-in') R.zoomAt(W, H, 1.4);
    else if (act === 'zoom-out') R.zoomAt(W, H, 1 / 1.4);
    else if (act === 'fit') R.fitAll();
    else if (act === 'preview') setEditing(false);
    else if (act === 'back-edit') setEditing(true);
    else OE.editor.action(act);
    b.blur();
  });

  function setEditing(on) {
    OE.editor.setActive(on);
    document.getElementById('btn-back-edit').hidden = on || !canEdit;
    stage.classList.remove('over-video');
    stage.style.cursor = '';
    if (!on) OE.util.toast('觀看者模式預覽：只能平移與縮放');
  }

  // ---- 拖曳匯入（僅編輯模式） ----
  let dragDepth = 0;
  const dropHint = document.getElementById('drop-hint');
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!OE.editor.active || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    dropHint.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (!OE.editor.active) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = OE.editor.active ? 'copy' : 'none';
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    if (!OE.editor.active) return;
    const p = localXY(e);
    const w = R.toWorld(p.x, p.y);
    const files = await collectDropped(e.dataTransfer);
    await OE.importer.importFiles(files, w.x, w.y);
    updateEmpty();
  });

  // 支援直接拖曳整個資料夾（遞迴讀取裡面的檔案）
  async function collectDropped(dt) {
    const entries = [...(dt.items || [])]
      .map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.length || !entries.some((en) => en.isDirectory)) return [...dt.files];
    const out = [];
    const walk = async (en) => {
      if (en.isFile) {
        out.push(await new Promise((res, rej) => en.file(res, rej)));
      } else if (en.isDirectory) {
        const reader = en.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child);
        } while (batch.length);
      }
    };
    for (const en of entries) await walk(en);
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return out;
  }

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    await OE.importer.importFiles(files, OE.cam.x, OE.cam.y);
    updateEmpty();
  });

  // ---- 啟動 ----
  OE.store.onChange = updateEmpty;
  updateEmpty();
  if (canEdit) {
    OE.editor.init().then(() => {
      updateEmpty();
      const prev = OE.store.onChange;
      OE.store.onChange = () => { prev(); updateEmpty(); };
    });
  }
  R.fitAll(false);
  if (!OE.store.items.length) { OE.cam.x = 0; OE.cam.y = 0; OE.cam.s = 1; }
})(window.OE);
