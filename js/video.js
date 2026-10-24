// 影片播放：畫布上平常只畫封面，播放時在物件位置疊一個跟著鏡頭移動的 <video>
(function (OE) {
  'use strict';

  const active = new Map(); // id -> { wrap, el, ui, parts }
  let layer;

  function create(it) {
    const wrap = document.createElement('div');
    wrap.className = 'vid-wrap';
    const el = document.createElement('video');
    el.src = OE.store.url(it.src);
    el.playsInline = true;
    el.preload = 'auto';
    const poster = it.lods.length ? it.lods[it.lods.length - 1].p : '';
    if (poster) el.poster = OE.store.url(poster);
    wrap.appendChild(el);

    const ui = document.createElement('div');
    ui.className = 'vid-ui';
    ui.innerHTML =
      '<button class="pp" title="播放/暫停">❚❚</button>' +
      '<input type="range" min="0" max="1000" value="0" title="進度">' +
      '<span class="time">0:00 / 0:00</span>' +
      '<button class="mute" title="靜音">🔊</button>' +
      '<button class="close" title="關閉">✕</button>';
    const parts = {
      pp: ui.querySelector('.pp'),
      range: ui.querySelector('input'),
      time: ui.querySelector('.time'),
      mute: ui.querySelector('.mute'),
    };
    // 控制列上的操作不要傳到畫布（避免被當成平移／選取）
    ui.addEventListener('pointerdown', (e) => e.stopPropagation());
    ui.addEventListener('dblclick', (e) => e.stopPropagation());
    parts.pp.onclick = () => toggle(it.id);
    parts.mute.onclick = () => { el.muted = !el.muted; refreshUI(entry); };
    ui.querySelector('.close').onclick = () => close(it.id);
    let seeking = false;
    parts.range.addEventListener('input', () => {
      seeking = true;
      if (isFinite(el.duration)) el.currentTime = (parts.range.value / 1000) * el.duration;
    });
    parts.range.addEventListener('change', () => { seeking = false; });
    el.addEventListener('timeupdate', () => { if (!seeking) refreshUI(entry); });
    el.addEventListener('play', () => { refreshUI(entry); OE.renderer.requestDraw(); });
    el.addEventListener('pause', () => { refreshUI(entry); OE.renderer.requestDraw(); });
    el.addEventListener('ended', () => refreshUI(entry));

    layer.appendChild(wrap);
    layer.appendChild(ui);
    const entry = { wrap, el, ui, parts };
    active.set(it.id, entry);
    return entry;
  }

  function refreshUI(a) {
    const el = a.el;
    a.parts.pp.textContent = el.paused ? '▶' : '❚❚';
    a.parts.mute.textContent = el.muted ? '🔇' : '🔊';
    if (isFinite(el.duration) && el.duration > 0) a.parts.range.value = Math.round((el.currentTime / el.duration) * 1000);
    a.parts.time.textContent = OE.util.formatTime(el.currentTime) + ' / ' + OE.util.formatTime(el.duration);
  }

  function toggle(id) {
    const it = OE.store.get(id);
    if (!it || it.type !== 'video') return;
    const a = active.get(id) || create(it);
    if (a.el.paused) {
      a.el.play().catch(() => {
        // 瀏覽器不允許有聲自動播放時，改用靜音播放
        a.el.muted = true;
        a.el.play().catch(() => OE.util.toast('這個影片格式無法在此瀏覽器播放'));
      });
    } else {
      a.el.pause();
    }
    update();
  }

  function close(id) {
    const a = active.get(id);
    if (!a) return;
    a.el.pause();
    a.el.removeAttribute('src');
    a.el.load();
    a.wrap.remove();
    a.ui.remove();
    active.delete(id);
    OE.renderer.requestDraw();
  }

  // 每次重畫後同步 <video> 的位置
  function update() {
    if (!active.size) return;
    const cam = OE.cam, W = OE.renderer.width, H = OE.renderer.height;
    for (const [id, a] of active) {
      const it = OE.store.get(id);
      if (!it) { close(id); continue; }
      const cx = (it.x - cam.x) * cam.s + W / 2;
      const cy = (it.y - cam.y) * cam.s + H / 2;
      const b = OE.util.itemAABB(it);
      const tl = OE.renderer.toScreen(b.minX, b.minY), br = OE.renderer.toScreen(b.maxX, b.maxY);
      const offscreen = br.x < 0 || br.y < 0 || tl.x > W || tl.y > H;
      // 離開畫面就暫停，省資源
      if (offscreen && !a.el.paused) a.el.pause();
      a.wrap.style.display = offscreen ? 'none' : '';
      a.wrap.style.width = it.w + 'px';
      a.wrap.style.height = it.h + 'px';
      a.wrap.style.transform =
        `translate(${cx}px,${cy}px) rotate(${it.rot}rad) scale(${cam.s}) translate(${-it.w / 2}px,${-it.h / 2}px)`;
      // 控制列放在影片外框下方（螢幕座標，不隨縮放變形）
      const sw = br.x - tl.x;
      const showUI = !offscreen && sw > 140;
      a.ui.style.display = showUI ? '' : 'none';
      if (showUI) {
        const uw = Math.min(Math.max(sw, 260), 520);
        a.ui.style.width = uw + 'px';
        const left = OE.util.clamp(cx - uw / 2, 8, W - uw - 8);
        const top = OE.util.clamp(br.y + 8, 8, H - 48);
        a.ui.style.transform = `translate(${left}px,${top}px)`;
      }
    }
  }

  OE.video = {
    init() {
      layer = document.getElementById('video-layer');
    },
    toggle,
    close,
    closeAll() { for (const id of [...active.keys()]) close(id); },
    update,
    isPlaying(id) {
      return active.has(id);
    },
  };
})(window.OE);
