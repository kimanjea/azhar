// 4DGS player: plays a SplatPipe faithful 4D file (.f4d) in the page, interactively.
// Nothing heavy loads until the visitor presses "View in 3D".
const PC = 'https://cdn.jsdelivr.net/npm/playcanvas@2.24.1/build/playcanvas.min.mjs';
const CONTROLS = 'https://cdn.jsdelivr.net/npm/playcanvas@2.24.1/scripts/esm/camera-controls.mjs';
const AHEAD = 6, BEHIND = 1;

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

async function fetchF4D(urls, total, onProgress) {
  // the file is stored in parts (GitHub limits file size); stream them back-to-back into one gzip stream
  let got = 0, i = 0;
  const joined = new ReadableStream({
    async pull(ctl) {
      if (i >= urls.length) { ctl.close(); return; }
      const r = await fetch(urls[i++]);
      if (!r.ok) { ctl.error(new Error('The 4D file could not be loaded.')); return; }
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength; onProgress(Math.min(1, got / total)); ctl.enqueue(value);
      }
    },
  });
  const buf = await new Response(joined.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'F4D1') throw new Error('Not a 4D file.');
  const hl = new DataView(buf).getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
  let off = 8 + hl;
  const n = h.splats, P = h.props.length;
  const b16 = new Uint16Array(buf.slice(off, off + h.block_bytes[0]));
  off += h.block_bytes[0];
  const base = h.props.map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < P; c++) base[c][i] = HALF[b16[i * P + c]];
  const offsets = [];
  for (let k = 0; k < h.frames; k++) { offsets.push(off); off += h.block_bytes[1 + k]; }
  return { h, buf, base, offsets };
}

function buildFrame(pc, dec, k) {
  // frame k = base + its stored differences, exactly as packed
  const { h, base, buf, offsets } = dec, n = h.splats;
  const ix = Object.fromEntries(h.props.map((p, i) => [p, i]));
  const storage = base.map((a) => a.slice());
  let pos = offsets[k];
  for (const [g, cols] of Object.entries(h.groups)) {
    const len = n * cols.length, step = h.steps[g];
    const q = new Int16Array(buf.slice(pos, pos + len * 2));
    pos += len * 2;
    cols.forEach((col, ci) => {
      const a = storage[ix[col]], o = ci * n;
      for (let i = 0; i < n; i++) { const d = q[o + i]; if (d) a[i] += d * step; }
    });
  }
  return new pc.GSplatData([{ name: 'vertex', count: n,
    properties: h.props.map((name, c) => ({ type: 'float', name, storage: storage[c], byteSize: 4 })) }]);
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
    const btn = this.$('.s4d-start'), gen = ++this.gen;
    btn.disabled = true;
    this.root.classList.add('is-loading');
    try {
      const scene = await (await fetch(this.sceneUrl)).json();
      if (gen !== this.gen) return;
      this.scene = scene;
      const [pc, { CameraControls }] = await Promise.all([import(PC), import(CONTROLS)]);
      this.pc = pc;
      const dec = await fetchF4D((scene.parts || [scene.file]).map((p) => new URL(p, this.sceneUrl)), scene.bytes,
        (p) => { if (gen !== this.gen) return; this.$('.s4d-bar > div').style.width = `${Math.round(p * 100)}%`; this.$('.s4d-status').textContent = `Loading ${Math.round(p * 100)}%`; });
      if (gen !== this.gen) return;
      this.$('.s4d-status').textContent = 'Preparing…';
      this.dec = dec;
      await this.initViewer(CameraControls);
      if (gen !== this.gen) return;
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
      this.root.classList.remove('is-loading');
      this.$('.s4d-status').textContent = `Couldn’t start the 3D view. ${e.message}`;
      btn.disabled = false;
    }
  }

  async initViewer(CameraControls) {
    const pc = this.pc, canvas = this.$('.s4d-canvas');
    const device = await pc.createGraphicsDevice(canvas, { deviceTypes: ['webgl2'], antialias: false });
    device.maxPixelRatio = Math.min(devicePixelRatio, 2);
    const opts = new pc.AppOptions();
    opts.graphicsDevice = device;
    opts.componentSystems = [pc.CameraComponentSystem, pc.ScriptComponentSystem, pc.GSplatComponentSystem];
    opts.resourceHandlers = [pc.GSplatHandler, pc.ScriptHandler];
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
    this.content = new pc.Entity('content');
    app.root.addChild(this.content);
    this.cache = new Map(); this.loading = new Map(); this.chain = Promise.resolve();
    this.i = 0; this.acc = 0;
    app.on('update', (dt) => this.tick(dt));
    app.start();
  }

  goTo(name, instant = false) {
    const v = this.scene.views[name]; if (!v) return;
    const pc = this.pc;
    const target = new pc.Vec3(...v.target), position = new pc.Vec3(...v.position);
    position.add(position.clone().sub(target).mulScalar(0.03));    // step back from blobs hugging the lens
    this.content.setLocalPosition(0, 0, 0);
    const damping = this.controls.focusDamping;
    if (instant) this.controls.focusDamping = 0;
    this.controls.reset(target, position);
    if (instant) setTimeout(() => { this.controls.focusDamping = damping; }, 50);
    for (const b of this.root.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  }

  load(k) {
    if (this.cache.has(k)) return Promise.resolve(this.cache.get(k));
    if (this.loading.has(k)) return this.loading.get(k);
    const p = this.chain = this.chain.then(() => new Promise((r) => setTimeout(r, 0))).then(() => {
      this.loading.delete(k);
      if (this.cache.has(k)) return this.cache.get(k);
      const pc = this.pc;
      const res = new pc.GSplatResource(this.app.graphicsDevice, buildFrame(pc, this.dec, k));
      const e = new pc.Entity(`frame_${k}`);
      e.addComponent('gsplat');
      e.gsplat.resource = res;
      const r = this.scene.rotation; e.setLocalRotation(new pc.Quat(r[0], r[1], r[2], r[3]));
      e.enabled = false;
      this.content.addChild(e);
      const f = { e, res }; this.cache.set(k, f); return f;
    });
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
