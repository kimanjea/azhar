// Camera vision for the AR page (MediaPipe Tasks), split into two runners so they can work side by side:
//  - hands: 21 joints per hand, fast (~30 ms on a laptop CPU). Drives pinch gestures, and moves the cut-outs.
//  - cut:   a pixel-tight cut-out of each hand, Vision Pro style: the segmenter's "body skin" pixels, kept only
//           near a tracked hand, soft-edged. Slower (~130 ms), so the page slides each cut-out along with its hand
//           between updates. (People cut-outs: "people", built but switched off for now.)
// Everything runs on the CPU on purpose: on phones the GPU belongs to the 4DGS player.
export const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3';
const HANDS = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const SEGMENT = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const BACKGROUND = 0, SKIN = 2;                     // the segmenter's classes we use

const ramp = (c, lo, hi) => (c <= lo ? 0 : c >= hi ? 255 : ((c - lo) / (hi - lo)) * 255);   // soft edge from confidence
let clock = 0;
const stamp = () => (clock = Math.max(performance.now(), clock + 1));

// A hand as the page needs it: pinch, its centre and size (to move cut-outs), and its joints (to find its skin)
export function summarizeHands(r) {
  return (r.landmarks || []).map((pts, i) => {
    const d = (a, b) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
    const palm = [0, 5, 9, 13, 17];
    return {
      id: r.handedness?.[i]?.[0]?.categoryName || String(i),
      pinch: d(4, 8) / (d(0, 9) || 1e-3), size: d(0, 9) || 1e-3,               // size: wrist to middle knuckle
      x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2,               // pinch point
      cx: palm.reduce((s, k) => s + pts[k].x, 0) / 5, cy: palm.reduce((s, k) => s + pts[k].y, 0) / 5,
      pts: pts.flatMap((p) => [p.x, p.y]),
    };
  });
}

// getFiles: returns MediaPipe's wasm loader (in a worker each model needs its own; see hands-worker.js)
export async function createRunner(role, getFiles, { HandLandmarker, ImageSegmenter }, delegate = 'CPU') {
  if (role === 'hands') {
    const lm = await HandLandmarker.createFromOptions(await getFiles(), {
      baseOptions: { modelAssetPath: HANDS, delegate }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
    return { run: (image) => ({ hands: summarizeHands(lm.detectForVideo(image, stamp())) }) };
  }
  const seg = await ImageSegmenter.createFromOptions(await getFiles(), {
    baseOptions: { modelAssetPath: SEGMENT, delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
  // hands: the latest tracked hands (from the hands runner), to say which skin is a hand.
  // Returns one soft cut-out per hand: { id, x0, y0, cw, ch, w, h, data, cx, cy, size } in this frame's pixels.
  return {
    run(image, { hands = [], people = false } = {}) {
      const r = seg.segmentForVideo(image, stamp());
      const masks = r.confidenceMasks || [], w = masks[0]?.width, h = masks[0]?.height;
      const cuts = [];
      if (w && masks[SKIN]) {
        const skin = masks[SKIN].getAsFloat32Array();
        for (const hand of hands) {
          const P = []; for (let k = 0; k < 42; k += 2) P.push([hand.pts[k] * w, hand.pts[k + 1] * h]);
          const span = Math.hypot(P[0][0] - P[9][0], P[0][1] - P[9][1]);
          const reach = span * 0.8, reach2 = reach * reach;         // how far from a joint a hand pixel can be
          let x0 = w, y0 = h, x1 = 0, y1 = 0;
          for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
          x0 = Math.max(0, Math.floor(x0 - reach)); y0 = Math.max(0, Math.floor(y0 - reach));
          x1 = Math.min(w - 1, Math.ceil(x1 + reach)); y1 = Math.min(h - 1, Math.ceil(y1 + reach));
          const cw = x1 - x0 + 1, ch = y1 - y0 + 1; if (cw < 2 || ch < 2) continue;
          const data = new Uint8ClampedArray(cw * ch);
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const a = ramp(skin[y * w + x], 0.3, 0.7); if (!a) continue;
            let near = Infinity;
            for (const [px, py] of P) { const dx = px - x, dy = py - y, dd = dx * dx + dy * dy; if (dd < near) near = dd; }
            if (near > reach2) continue;
            const fade = near < reach2 * 0.5 ? 1 : 1 - (near - reach2 * 0.5) / (reach2 * 0.5);   // soft at the reach limit
            data[(y - y0) * cw + (x - x0)] = a * fade;
          }
          cuts.push({ id: hand.id, x0, y0, cw, ch, w, h, data, cx: hand.cx, cy: hand.cy, size: hand.size });
        }
        if (people && masks[BACKGROUND]) {                           // anyone in view (off for now)
          const bg = masks[BACKGROUND].getAsFloat32Array(), data = new Uint8ClampedArray(w * h);
          for (let i = 0; i < data.length; i++) data[i] = ramp(1 - bg[i], 0.35, 0.75);
          cuts.push({ id: 'people', x0: 0, y0: 0, cw: w, ch: h, w, h, data });
        }
      }
      r.close?.();
      return { cuts };
    },
  };
}
