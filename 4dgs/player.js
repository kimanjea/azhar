// 4DGS player: plays a SplatPipe faithful 4D file (.f4d) in the page, interactively.
// Nothing heavy loads until the visitor presses "View in 3D".
const PC = 'https://cdn.jsdelivr.net/npm/playcanvas@2.24.1/build/playcanvas.min.mjs';
const CONTROLS = 'https://cdn.jsdelivr.net/npm/playcanvas@2.24.1/scripts/esm/camera-controls.mjs';
// phones get a smaller look-ahead and pixel ratio: iOS gives each tab little memory
const SMALL = matchMedia('(pointer: coarse)').matches || (navigator.deviceMemory || 8) <= 4;
const AHEAD = SMALL ? 3 : 6, BEHIND = 1;

const mb = (b) => `${Math.round(b / 2 ** 20)} MB`;
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// float16 -> float32
const HALF = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();

const gunzip = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

async function download(urls, total, onProgress) {
  // the file is stored in parts (GitHub limits file size): download them back to back into one buffer
  let got = 0;
  const chunks = [];
  for (const url of urls) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('The 4D file could not be loaded.');
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.byteLength; onProgress(Math.min(1, got / total));
    }
  }
  const file = new Uint8Array(got);
  for (let o = 0, i = 0; i < chunks.length; o += chunks[i].byteLength, i++) file.set(chunks[i], o);
  chunks.length = 0;
  return file;
}

// F4D3 (compact website form, made by SplatPipe's web4d.py): the base splat is a .sog file, unpacked by PlayCanvas;
// each moment holds 1-byte changes of the moving splats only, relative to the moment before (every key_every-th
// moment relative to the base, so the player can jump anywhere).
async function fetchF4D3(pc, app, urls, total, sogUrl, onProgress) {
  const file = await download(urls, total, onProgress);
  if (String.fromCharCode(...file.subarray(0, 4)) !== 'F4D3') throw new Error('Not a 4D file.');
  const hl = new DataView(file.buffer, file.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(file.subarray(8, 8 + hl)));
  let off = 8 + hl;
  const blocks = h.z_bytes.map((sz) => { const b = file.subarray(off, off + sz); off += sz; return b; });
  const mvBytes = await gunzip(blocks[0]);
  const mv = new Uint32Array(mvBytes.buffer.slice(mvBytes.byteOffset, mvBytes.byteOffset + mvBytes.byteLength));
  const asset = new pc.Asset('f4d-base', 'gsplat', { url: sogUrl }, { decompress: true });
  app.assets.add(asset);
  await new Promise((ok, no) => { asset.once('load', ok); asset.once('error', (e) => no(new Error(String(e)))); app.assets.load(asset); });
  const gd = asset.resource.gsplatData;
  // phones skip the view-dependent colour detail (SH), as for the other format
  const props = h.props.filter((p) => !(SMALL && p.startsWith('f_rest')) && gd.getProp(p));
  const base = props.map((p) => gd.getProp(p));
  app.assets.remove(asset);
  return { v3: true, h, base, props, mv, blocks, state: null };
}

async function buildFrame3(pc, dec, k) {
  const { h, base, props, mv } = dec, M = mv.length, n = h.splats, key = h.key_every || h.frames;
  const ix = Object.fromEntries(props.map((p, i) => [p, i]));
  const groups = Object.entries(h.groups);
  let st = dec.state;
  if (!st || st.k >= k || Math.floor(st.k / key) !== Math.floor(k / key)) {
    // start a fresh run at the keyframe before k (moving values = the base)
    st = { k: k - (k % key) - 1, vals: {} };
    for (const [g, cols] of groups) st.vals[g] = cols.map((c) => { const a = new Float32Array(M), b = base[ix[c]]; for (let i = 0; i < M; i++) a[i] = b[mv[i]]; return a; });
  }
  for (let j = st.k + 1; j <= k; j++) {
    const blk = await gunzip(dec.blocks[1 + j]);
    let tot = 0; for (const [, cols] of groups) tot += cols.length * M;
    const d8 = new Int8Array(blk.buffer, blk.byteOffset, tot);
    const dv = new DataView(blk.buffer, blk.byteOffset);
    const ne = dv.getUint32(tot, true), esc = new Map();
    for (let e = 0; e < ne; e++) esc.set(dv.getUint32(tot + 4 + 4 * e, true), dv.getInt16(tot + 4 + 4 * ne + 2 * e, true));
    const fromBase = j % key === 0;
    let pos = 0;
    for (const [g, cols] of groups) {
      const step = h.steps[g];
      cols.forEach((c, ci) => {
        const a = st.vals[g][ci], b = base[ix[c]];
        for (let i = 0; i < M; i++, pos++) {
          let d = d8[pos]; if (d === -128) d = esc.get(pos) ?? 0;
          a[i] = (fromBase ? b[mv[i]] : a[i]) + d * step;
        }
      });
    }
    st.k = j;
  }
  dec.state = st;
  const storage = base.slice();
  for (const [g, cols] of groups) cols.forEach((c, ci) => {
    const i = ix[c]; if (i === undefined) return;
    const a = base[i].slice(), v = st.vals[g][ci];
    for (let m = 0; m < M; m++) a[mv[m]] = v[m];
    storage[i] = a;
  });
  return new pc.GSplatData([{ name: 'vertex', count: n,
    properties: props.map((name, c) => ({ type: 'float', name, storage: storage[c], byteSize: 4 })) }]);
}

async function fetchF4D(urls, total, onProgress) {
  let file = await download(urls, total, onProgress);

  // F4D2 (web form): base and each frame compressed on their own, so frames stay small until shown.
  // F4D1: one compressed stream; unpacked whole.
  let raw = file, blocks;
  const v2 = String.fromCharCode(...file.subarray(0, 4)) === 'F4D2';
  if (!v2) { raw = await gunzip(file); file = null; }
  if (!['F4D1', 'F4D2'].includes(String.fromCharCode(...raw.subarray(0, 4)))) throw new Error('Not a 4D file.');
  const hl = new DataView(raw.buffer, raw.byteOffset).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + hl)));
  const sizes = v2 ? h.z_bytes : h.block_bytes;
  let off = 8 + hl;
  blocks = sizes.map((sz) => { const b = raw.subarray(off, off + sz); off += sz; return b; });
  const baseBytes = v2 ? await gunzip(blocks[0]) : blocks[0];

  // phones skip the view-dependent colour detail (SH): 45 of 59 values per splat, the bulk of each frame's memory
  const n = h.splats, P = h.props.length;
  const keep = h.props.map((p, c) => [p, c]).filter(([p]) => !(SMALL && p.startsWith('f_rest')));
  const b16 = new Uint16Array(baseBytes.buffer.slice(baseBytes.byteOffset, baseBytes.byteOffset + baseBytes.byteLength));
  const base = keep.map(([, c]) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = HALF[b16[i * P + c]]; return a; });
  const frame = (k) => v2 ? gunzip(blocks[1 + k]) : Promise.resolve(blocks[1 + k]);
  return { h, base, props: keep.map(([p]) => p), frame };
}

async function buildFrame(pc, dec, k) {
  // frame k = base + its stored differences, exactly as packed
  const { h, base, props } = dec, n = h.splats;
  const ix = Object.fromEntries(props.map((p, i) => [p, i]));
  const moving = new Set(Object.values(h.groups).flat());
  const storage = base.map((a, i) => moving.has(props[i]) ? a.slice() : a);   // unchanged values are shared, not copied
  const bytes = await dec.frame(k);
  const all = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  let pos = 0;
  for (const [g, cols] of Object.entries(h.groups)) {
    const step = h.steps[g];
    cols.forEach((col, ci) => {
      const a = storage[ix[col]], o = pos + ci * n;
      if (a) for (let i = 0; i < n; i++) { const d = all[o + i]; if (d) a[i] += d * step; }
    });
    pos += n * cols.length;
  }
  return new pc.GSplatData([{ name: 'vertex', count: n,
    properties: props.map((name, c) => ({ type: 'float', name, storage: storage[c], byteSize: 4 })) }]);
}

class Player {
  constructor(root) {
    this.root = root;
    this.sceneUrl = new URL(root.dataset.scene, location.href);
    this.$ = (s) => root.querySelector(s);
    this.gen = 0; this.live = false; this.visible = true;
    this.$('.s4d-start').addEventListener('click', () => this.start());
    // controls are wired once; they act only while a clip is live
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }).observe(root);
    this.$('.s4d-play').addEventListener('click', () => { if (this.live) { this.playing = !this.playing; this.render(); } });
    this.$('.s4d-scrub').addEventListener('input', (e) => { if (this.live) { this.playing = false; this.seek(Number(e.target.value)); this.render(); } });
    for (const b of root.querySelectorAll('[data-view]')) b.addEventListener('click', () => this.live && this.goTo(b.dataset.view));
    root.addEventListener('keydown', (e) => {
      if (!this.live || !e.target.classList.contains('s4d-canvas')) return;
      if (e.key === ' ') { this.playing = !this.playing; this.render(); e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { this.playing = false; this.seek(this.i + (e.key === 'ArrowRight' ? 1 : -1)); this.render(); }
    });
    this.initMore();
    this.initTilt();
    this.initTools();
    // data-autoload: start loading as soon as the page has loaded (skipped when the visitor asked to save data)
    if ('autoload' in root.dataset && !navigator.connection?.saveData) {
      const go = () => setTimeout(() => this.start(), 300);
      document.readyState === 'complete' ? go() : addEventListener('load', go, { once: true });
    }
  }

  // Tilt to look: on phones and tablets, tilting the device swings the view around the current camera view,
  // inside the same limits as dragging. Android starts it by itself; iPhone asks permission on a tap of "Tilt".
  initTilt() {
    this.tilt = { on: false, base: null, yaw: 0, pitch: 0, ty: 0, tp: 0 };
    const btn = this.$('.s4d-tilt');
    const touch = matchMedia('(pointer: coarse)').matches;
    if (!btn) return;
    if (!touch) return this.initMouseTilt(btn);
    if (typeof DeviceOrientationEvent === 'undefined') { btn.remove(); return; }
    btn.hidden = false;
    const needsAsk = typeof DeviceOrientationEvent.requestPermission === 'function';
    const listen = () => {
      if (this.tiltListening) return;
      this.tiltListening = true;
      addEventListener('deviceorientation', (e) => this.onTilt(e));
      addEventListener('orientationchange', () => { this.tilt.base = null; });
    };
    const set = (on) => { this.tilt.on = on; this.tilt.base = null; btn.setAttribute('aria-pressed', String(on)); if (on) listen(); };
    btn.addEventListener('click', async () => {
      if (this.tilt.on) return set(false);
      if (needsAsk) {
        try { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } catch { return; }
      }
      set(true);
    });
    if (!needsAsk && !reduceMotion) set(true);
  }

  // Laptops and PCs (no gyroscope): the pointer's position over the clip tilts the view the same way.
  // Holding a button to drag turns it off for that moment, so dragging behaves exactly as before.
  initMouseTilt(btn) {
    btn.hidden = false;
    const t = this.tilt;
    const set = (on) => { t.on = on; t.ty = t.tp = 0; btn.setAttribute('aria-pressed', String(on)); };
    btn.addEventListener('click', () => set(!t.on));
    this.root.addEventListener('pointermove', (e) => {
      if (!t.on || e.pointerType !== 'mouse') return;
      if (e.buttons) { t.ty = t.yaw; t.tp = t.pitch; return; }        // dragging: hold the tilt where it is
      const r = this.root.getBoundingClientRect(), m = this.tiltRange();
      const nx = Math.max(-1, Math.min(1, (e.clientX - r.left) / r.width * 2 - 1));
      const ny = Math.max(-1, Math.min(1, (e.clientY - r.top) / r.height * 2 - 1));
      t.ty = nx * m; t.tp = -ny * m * 0.6;
    });
    this.root.addEventListener('pointerleave', () => { t.ty = 0; t.tp = 0; });
    set(!reduceMotion);
  }

  onTilt(e) {
    const t = this.tilt;
    if (!t.on || e.beta == null || e.gamma == null) return;
    // device tilt in the screen's own frame, so landscape works too
    const a = (screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI / 180;
    const x = e.gamma * Math.cos(a) + e.beta * Math.sin(a), y = e.beta * Math.cos(a) - e.gamma * Math.sin(a);
    if (!t.base) { t.base = { x, y }; return; }
    const m = this.tiltRange();
    const k = 0.6;                                  // degrees of view per degree of tilt
    t.ty = Math.max(-m, Math.min(m, (x - t.base.x) * k));
    t.tp = Math.max(-m, Math.min(m, (y - t.base.y) * k));
  }

  // The Review page's viewer tools, on the website too
  initTools() {
    this.limitOn = true; this.spinOn = false; this.spinYaw = 0; this.spinPhase = 0;
    const on = (sel, fn) => this.$(sel)?.addEventListener('click', fn);
    on('.s4d-reset', () => this.live && this.resetView());
    on('.s4d-limit', () => this.live && this.setLimit(!this.limitOn));
    on('.s4d-spin', () => this.live && this.setSpin(!this.spinOn));
    on('.s4d-full', () => this.toggleFull());
    // grabbing the view stops the slow turn, as on the Review page
    this.root.addEventListener('pointerdown', (e) => { if (this.spinOn && e.target.classList.contains('s4d-canvas')) this.setSpin(false); });
    this.root.addEventListener('wheel', () => this.spinOn && this.setSpin(false), { passive: true });
    const sync = () => {
      const full = document.fullscreenElement === this.root || document.webkitFullscreenElement === this.root || this.root.classList.contains('is-full');
      this.$('.s4d-full')?.setAttribute('aria-pressed', String(full));
    };
    document.addEventListener('fullscreenchange', sync); document.addEventListener('webkitfullscreenchange', sync);
    this.root.addEventListener('keydown', (e) => {
      if (!this.live || e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'f') this.toggleFull();
      else if (k === 'r') this.resetView();
      else if (k === 'l') this.setLimit(!this.limitOn);
      else if (k === 's') this.setSpin(!this.spinOn);
      else if (k === 'escape' && this.root.classList.contains('is-full')) this.toggleFull();
    });
  }

  resetView() { this.setSpin(false); this.goTo('cam1'); this.playing = !reduceMotion; this.seek(0); this.render(); }

  setLimit(on) {
    this.limitOn = on;
    this.$('.s4d-limit')?.setAttribute('aria-pressed', String(on));
    if (on) this.limitOrbit(this.view || 'cam1'); else this.freeOrbit();
    this.spinYaw = 0;
  }

  setSpin(on) {
    this.spinOn = on && !reduceMotion;
    this.$('.s4d-spin')?.setAttribute('aria-pressed', String(this.spinOn));
    if (!this.spinOn) this.spinPhase = 0;
  }

  toggleFull() {
    const r = this.root, doc = document;
    const native = doc.fullscreenElement === r || doc.webkitFullscreenElement === r;
    if (native) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
    if (r.classList.contains('is-full')) {
      r.classList.remove('is-full'); doc.documentElement.classList.remove('s4d-noscroll');
      this.$('.s4d-full')?.setAttribute('aria-pressed', 'false'); return;
    }
    const req = r.requestFullscreen || r.webkitRequestFullscreen;
    if (req) req.call(r).catch?.(() => this.fakeFull());
    else this.fakeFull();
  }

  fakeFull() {      // iPhone Safari: no full screen for page elements, so fill the window instead
    this.root.classList.add('is-full'); document.documentElement.classList.add('s4d-noscroll');
    this.$('.s4d-full')?.setAttribute('aria-pressed', 'true');
  }

  spinRange() {
    const o = { mode: 'window', ...(this.scene?.orbit || {}) };
    if (o.mode !== 'arc') return o.margin ?? 3;
    const ys = Object.values(this.scene.views).map((v) => this.viewAngles(v).yaw);
    return Math.max(o.margin ?? 12, (Math.max(...ys) - Math.min(...ys)) / 2 + (o.margin ?? 12) / 2);
  }

  tiltRange() { return Math.min(25, (this.scene?.orbit?.margin ?? 3)); }

  // turn the clip about the point the current view looks at: the same as the camera swinging around it
  applyTilt(dt = 0) {
    const t = this.tilt, pc = this.pc;
    if (!this.content || !this.pivot || !pc) return;
    const goal = t.on ? 1 : 0;
    t.yaw += ((t.ty * goal) - t.yaw) * 0.15; t.pitch += ((t.tp * goal) - t.pitch) * 0.15;
    if (this.spinOn) {
      if (this.limitOn) { this.spinPhase += dt * 0.35; this.spinYaw = this.spinRange() * Math.sin(this.spinPhase); }
      else this.spinYaw = (this.spinYaw + dt * 8) % 360;
    } else if (this.limitOn) this.spinYaw *= 0.9;
    if (Math.abs(t.yaw) < 1e-3 && Math.abs(t.pitch) < 1e-3 && !t.on && Math.abs(this.spinYaw) < 1e-3 && !this.spinOn) return;
    const right = this.camera.right.clone();
    const q = new pc.Quat().setFromAxisAngle(pc.Vec3.UP, -(t.yaw + this.spinYaw)).mul(new pc.Quat().setFromAxisAngle(right, -t.pitch));
    const off = q.transformVector(this.pivot.clone().mulScalar(-1)).add(this.pivot);
    this.content.setLocalRotation(q);
    this.content.setLocalPosition(off);
  }

  // "More 4D clips": swap which clip this player shows
  initMore() {
    const card = this.root.closest('article') || document, more = card.querySelector('.s4d-more');
    if (!more) return;
    const toggle = more.querySelector('.s4d-more-toggle'), list = more.querySelector('.s4d-more-list');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open)); list.hidden = !open;
    });
    for (const b of list.querySelectorAll('[data-scene]')) b.addEventListener('click', () => {
      for (const x of list.querySelectorAll('[data-scene]')) x.setAttribute('aria-current', String(x === b));
      this.switchTo(b.dataset);
      this.root.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
    });
  }

  switchTo({ scene, poster, status, alt }) {
    const url = new URL(scene, location.href);
    if (url.href === this.sceneUrl.href) return;
    const wasStarted = this.live || this.root.classList.contains('is-loading');
    this.teardown();
    this.sceneUrl = url;
    const img = this.$('.s4d-poster');
    if (poster) img.src = poster;
    if (alt) img.alt = alt;
    this.$('.s4d-status').textContent = status || '';
    if (wasStarted) this.start();
  }

  teardown() {
    this.gen++; this.live = false; this.playing = false;
    if (this.app) {
      for (const f of this.cache.values()) { f.e.destroy(); f.res.destroy?.(); }
      this.cache.clear();
      this.resize?.disconnect();
      this.app.destroy(); this.app = null;
      const old = this.$('.s4d-canvas'), fresh = old.cloneNode(false);    // a used WebGL canvas can't be reused
      old.replaceWith(fresh);
    }
    this.dec = null;
    this.root.classList.remove('is-live', 'is-loading');
    this.$('.s4d-bar > div').style.width = '0';
    this.$('.s4d-start').disabled = false;
  }

  async start() {
    if (this.live || this.root.classList.contains('is-loading')) return;
    const btn = this.$('.s4d-start'), gen = ++this.gen;
    btn.disabled = true;
    this.root.classList.add('is-loading');
    try {
      const scene = await (await fetch(this.sceneUrl)).json();
      if (gen !== this.gen) return;
      this.scene = scene;
      const [pc, { CameraControls }] = await Promise.all([import(PC), import(CONTROLS)]);
      this.pc = pc;
      // open the 3D view before downloading: a phone may refuse a new graphics context once memory is full
      await this.initViewer(CameraControls);
      if (gen !== this.gen) return;
      const urls = (scene.parts || [scene.file]).map((p) => new URL(p, this.sceneUrl));
      const progress = (p) => { if (gen !== this.gen) return; this.$('.s4d-bar > div').style.width = `${Math.round(p * 100)}%`; this.$('.s4d-status').textContent = `Loading ${Math.round(p * 100)}%`; };
      const dec = scene.format === 'f4d3'
        ? await fetchF4D3(this.pc, this.app, urls, scene.bytes, new URL(scene.base, this.sceneUrl).href, progress)
        : await fetchF4D(urls, scene.bytes, progress);
      if (gen !== this.gen) return;
      this.$('.s4d-status').textContent = 'Preparing…';
      this.dec = dec;
      this.root.classList.remove('is-loading');
      this.root.classList.add('is-live');
      this.frames = dec.h.frames;
      this.fps = dec.h.fps || scene.fps || 10;
      const scrub = this.$('.s4d-scrub');
      scrub.max = String(this.frames - 1);
      await this.seek(0);
      this.goTo('cam1', true);
      this.live = true;
      this.playing = !reduceMotion;
      this.render();
    } catch (e) {
      if (gen !== this.gen) return;
      this.teardown();
      this.$('.s4d-status').textContent = e.noDevice
        ? `This browser couldn’t open a 3D view (${e.detail}). On iPhone, Lockdown Mode turns 3D off.`
        : `Couldn’t start the 3D view. ${e.message}`;
    }
  }

  async initViewer(CameraControls) {
    const pc = this.pc, canvas = this.$('.s4d-canvas');
    // WebGL 2 first, then plain settings, then WebGPU (newer iPhones and browsers)
    let device, why = '';
    for (const o of [{ deviceTypes: ['webgl2'], antialias: false, powerPreference: 'high-performance' },
                     { deviceTypes: ['webgl2'] }, { deviceTypes: ['webgpu'] }]) {
      if (o.deviceTypes[0] === 'webgpu' && !navigator.gpu) continue;
      try { device = await pc.createGraphicsDevice(canvas, o); if (device) break; } catch (e) { why = e?.message || String(e); }
    }
    if (!device) {
      const gl = (() => { try { return document.createElement('canvas').getContext('webgl2') ? 'WebGL 2 works' : 'WebGL 2 unavailable'; } catch { return 'WebGL 2 blocked'; } })();
      throw Object.assign(new Error(why), { noDevice: true, detail: `${gl}${navigator.gpu ? ', WebGPU present' : ''}${why ? ` · ${why}` : ''}` });
    }
    device.maxPixelRatio = Math.min(devicePixelRatio, SMALL ? 1.5 : 2);
    const opts = new pc.AppOptions();
    opts.graphicsDevice = device;
    opts.componentSystems = [pc.CameraComponentSystem, pc.ScriptComponentSystem, pc.GSplatComponentSystem];
    opts.resourceHandlers = [pc.GSplatHandler, pc.ScriptHandler, pc.TextureHandler, pc.BinaryHandler, pc.JsonHandler];   // textures: the SOG base
    const app = this.app = new pc.AppBase(canvas);
    app.init(opts);
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_AUTO);
    const fit = () => app.resizeCanvas(canvas.clientWidth, canvas.clientHeight);
    (this.resize = new ResizeObserver(fit)).observe(canvas);
    fit();
    const bg = getComputedStyle(this.root).getPropertyValue('--s4d-bg').trim() || '#0b0b0c';
    const c = new pc.Color(); c.fromString(bg);
    const camera = this.camera = new pc.Entity('camera');
    camera.addComponent('camera', { clearColor: c, fov: this.scene.fov || 40, nearClip: 0.01, farClip: 1000 });
    camera.addComponent('script');
    app.root.addChild(camera);
    const controls = this.controls = camera.script.create(CameraControls);
    controls.moveSpeed = 1; controls.focusDamping = 0.9;
    // viewers only orbit and zoom; no flying or panning away from the filmed views
    controls.enableFly = false; controls.middleButton = 'none'; controls.rightButton = 'none';
    this.content = new pc.Entity('content');
    app.root.addChild(this.content);
    this.cache = new Map(); this.loading = new Map(); this.chain = Promise.resolve();
    this.i = 0; this.acc = 0;
    app.on('update', (dt) => { this.applyTilt(dt); this.tick(dt); });
    app.start();
  }

  goTo(name, instant = false) {
    const v = this.scene.views[name]; if (!v) return;
    const pc = this.pc;
    const target = new pc.Vec3(...v.target), position = new pc.Vec3(...v.position);
    position.add(position.clone().sub(target).mulScalar(0.03));    // step back from blobs hugging the lens
    this.content.setLocalPosition(0, 0, 0);
    this.content.setLocalRotation(0, 0, 0, 1);
    this.pivot = target.clone();
    if (this.tilt) this.tilt.base = null;
    const damping = this.controls.focusDamping;
    if (instant) this.controls.focusDamping = 0;
    this.view = name;
    this.freeOrbit();
    this.controls.reset(target, position);
    if (this.limitOn !== false) this.limitOrbit(name);
    if (instant) setTimeout(() => { this.controls.focusDamping = damping; }, 50);
    for (const b of this.root.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  }

  // A 4D splat from a few fixed cameras is only right near where they stood, so the view is kept there.
  // scene.json "orbit": {"mode": "window", "margin": 3}  each View is its own small window (default)
  //                     {"mode": "arc",    "margin": 12} the whole arc between the cameras (when it's been checked)
  //                     {"mode": "free"}                 no limit
  viewAngles(v) {
    const pc = this.pc, t = new pc.Vec3(...v.target), p = new pc.Vec3(...v.position);
    p.add(p.clone().sub(t).mulScalar(0.03));
    const d = t.clone().sub(p).normalize(), deg = 180 / Math.PI;
    return { yaw: Math.atan2(-d.x, -d.z) * deg, pitch: -Math.atan2(-d.y, Math.hypot(d.x, d.z)) * deg, dist: t.distance(p) };
  }

  freeOrbit() {
    const pc = this.pc, c = this.controls;
    c.yawRange = new pc.Vec2(-360, 360); c.pitchRange = new pc.Vec2(-360, 360); c.zoomRange = new pc.Vec2(0.01, 0);
  }

  limitOrbit(name) {
    const o = { mode: 'window', ...(this.scene.orbit || {}) };
    if (o.mode === 'free') return;
    const pc = this.pc, c = this.controls, near = this.viewAngles(this.scene.views[name]).yaw;
    const views = o.mode === 'arc' ? Object.values(this.scene.views) : [this.scene.views[name]];
    const m = o.margin ?? (o.mode === 'arc' ? 12 : 3);
    const a = views.map((v) => this.viewAngles(v));
    const ys = a.map((x) => x.yaw + 360 * Math.round((near - x.yaw) / 360));   // continuous around the current view
    c.yawRange = new pc.Vec2(Math.min(...ys) - m, Math.max(...ys) + m);
    const ps = a.map((x) => x.pitch);
    c.pitchRange = new pc.Vec2(Math.max(-89, Math.min(...ps) - m), Math.min(89, Math.max(...ps) + m));
    const ds = a.map((x) => x.dist);
    c.zoomRange = new pc.Vec2(Math.min(...ds) * (o.mode === 'arc' ? 0.6 : 0.85), Math.max(...ds) * (o.mode === 'arc' ? 1.2 : 1.1));
  }

  load(k) {
    if (this.cache.has(k)) return Promise.resolve(this.cache.get(k));
    if (this.loading.has(k)) return this.loading.get(k);
    const dec = this.dec;
    const p = this.chain.then(() => new Promise((r) => setTimeout(r, 0))).then(async () => {
      this.loading.delete(k);
      if (this.cache.has(k)) return this.cache.get(k);
      const pc = this.pc, data = dec.v3 ? await buildFrame3(pc, dec, k) : await buildFrame(pc, dec, k);
      if (dec !== this.dec || !this.app) throw new Error('stale');
      const res = new pc.GSplatResource(this.app.graphicsDevice, data);
      const e = new pc.Entity(`frame_${k}`);
      e.addComponent('gsplat');
      e.gsplat.resource = res;
      const r = this.scene.rotation; e.setLocalRotation(new pc.Quat(r[0], r[1], r[2], r[3]));
      e.enabled = false;
      this.content.addChild(e);
      const f = { e, res }; this.cache.set(k, f); return f;
    });
    this.chain = p.catch(() => {});      // one failed frame never blocks the ones queued after it
    this.loading.set(k, p);
    return p;
  }

  show(k) {
    const f = this.cache.get(k); if (!f) return false;
    const prev = this.cache.get(this.i); if (prev && prev !== f) prev.e.enabled = false;
    f.e.enabled = true; this.i = k; this.render(); return true;
  }

  prefetch() {
    const n = this.frames, keep = new Set();
    for (let d = -BEHIND; d <= AHEAD; d++) keep.add((this.i + d + n) % n);
    for (const [k, f] of this.cache) if (!keep.has(k)) { f.e.destroy(); f.res.destroy?.(); this.cache.delete(k); }
    for (let d = 1; d <= AHEAD; d++) this.load((this.i + d) % n).catch(() => {});
  }

  async seek(k) {
    k = ((k % this.frames) + this.frames) % this.frames;
    await this.load(k); this.show(k); this.prefetch();
  }

  tick(dt) {
    if (!this.live || !this.playing || !this.visible) return;
    this.acc += dt;
    if (this.acc < 1 / this.fps) return;
    const next = (this.i + 1) % this.frames;
    if (this.show(next)) { this.acc = 0; this.prefetch(); } else this.load(next).catch(() => {});
  }

  render() {
    const play = this.$('.s4d-play');
    play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    play.dataset.state = this.playing ? 'playing' : 'paused';
    this.$('.s4d-scrub').value = String(this.i);
    this.$('.s4d-time').textContent = `${clock(this.i / this.fps)} · ${this.i + 1}/${this.frames}`;
  }
}

for (const el of document.querySelectorAll('[data-splat4d]')) new Player(el);
