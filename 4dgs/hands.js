// Camera vision for the AR page (MediaPipe). Two runners side by side, each in its own background worker:
//   'hands' tracks your hands (fast)  ·  'cut' makes the hand cut-outs for Instructor mode (slower)
// Each sees a small copy of the camera frame, so the page, its buttons and the 4DGS player stay smooth.
// Computers that can't run workers fall back to the page itself. Phones never do (it would freeze the player).
import { MP, createRunner } from './vision-core.js';

const SIDE = 320;                                    // longest side of the frame the models see

function shrinker() {
  const c = document.createElement('canvas'), g = c.getContext('2d', { alpha: false });
  return (video) => {
    const k = SIDE / Math.max(video.videoWidth, video.videoHeight);
    const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    g.drawImage(video, 0, 0, w, h);
    return c;
  };
}

async function inWorker(role) {
  const w = new Worker(new URL('hands-worker.js', import.meta.url), { type: 'module' });
  const waiting = new Map();                           // request id -> { ok, no }: every reply finds its own request
  let next = 0, busy = false;
  const ask = (msg, transfer = []) => new Promise((ok, no) => {
    const id = ++next; waiting.set(id, { ok, no }); w.postMessage({ ...msg, id }, transfer);
  });
  w.onmessage = ({ data }) => {
    const p = waiting.get(data.id); if (!p) return;
    waiting.delete(data.id);
    if (data.type === 'error') p.no(new Error(data.message)); else p.ok(data);
  };
  w.onerror = (e) => { for (const p of waiting.values()) p.no(e); waiting.clear(); };
  await Promise.race([
    ask({ type: 'init', role, delegate: new URL(location.href).searchParams.get('handsgpu') ? 'GPU' : 'CPU' }),
    new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 40000)),
  ]);
  const small = shrinker();
  return {
    mode: 'worker',
    get busy() { return busy; },
    // one frame in flight at a time; resolves with this runner's result for the frame
    async detect(video, extra) {
      if (busy) return null;
      busy = true;
      try {
        const bitmap = await createImageBitmap(small(video));
        return await ask({ type: 'frame', bitmap, extra }, [bitmap]);
      } finally { busy = false; }
    },
    close() { w.terminate(); },
  };
}

async function onPage(role) {
  const { FilesetResolver, HandLandmarker, ImageSegmenter } = await import(`${MP}/vision_bundle.mjs`);
  const runner = await createRunner(role, () => FilesetResolver.forVisionTasks(`${MP}/wasm`), { HandLandmarker, ImageSegmenter }, 'CPU');
  const small = shrinker();
  let busy = false;
  return {
    mode: 'page',
    get busy() { return busy; },
    async detect(video, extra) {
      if (busy) return null;
      busy = true;
      try { await new Promise((r) => setTimeout(r)); return runner.run(small(video), extra); } finally { busy = false; }
    },
    close() {},
  };
}

export async function createVisionRunner(role) {
  try { return await inWorker(role); }
  catch (e) {
    if (matchMedia('(pointer: coarse)').matches) throw e;     // phones: never on the page (it would freeze the player)
    return onPage(role);
  }
}
