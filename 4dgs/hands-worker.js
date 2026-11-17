// Camera vision off the main thread, so taps, buttons and the 4DGS player never wait for it.
// The page runs two of these side by side: one tracks hands (fast), one makes hand cut-outs (slower).
import { HandLandmarker, ImageSegmenter } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs';
import { MP, createRunner } from './vision-core.js';

let runner = null;

onmessage = async ({ data: m }) => {
  if (m.type === 'init') {
    try {
      // module build (works in module workers). MediaPipe's loader hands itself over once, and a module only runs once,
      // so each model loads its own copy (same file, its own address; the download comes from the cache)
      let n = 0;
      const files = async () => ({ wasmLoaderPath: `${MP}/wasm/vision_wasm_module_internal.js?m=${m.role}${++n}`,
        wasmBinaryPath: `${MP}/wasm/vision_wasm_module_internal.wasm` });
      runner = await createRunner(m.role, files, { HandLandmarker, ImageSegmenter }, m.delegate || 'CPU');
      postMessage({ type: 'ready', id: m.id });
    } catch (e) { postMessage({ type: 'error', id: m.id, message: String(e?.message || e) }); }
  } else if (m.type === 'frame') {
    let out = {};
    try { out = runner.run(m.bitmap, m.extra); } catch (e) { out.err = String(e?.message || e); }
    m.bitmap.close?.();
    postMessage({ type: 'result', id: m.id, ...out }, (out.cuts || []).map((c) => c.data.buffer));
  }
};
