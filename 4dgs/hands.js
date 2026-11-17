// Camera hand tracking for the AR page: MediaPipe's hand landmarker finds 21 joints per hand in each camera frame.
// Only loaded when the visitor turns "Hand tracking" on. Works in any browser with a camera (no headset needed).
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export async function createHandTracker() {
  const { FilesetResolver, HandLandmarker } = await import(`${MP}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let lm;
  try { lm = await HandLandmarker.createFromOptions(files, opts('GPU')); }
  catch { lm = await HandLandmarker.createFromOptions(files, opts('CPU')); }
  let last = 0;
  return {
    // source: a <video>, canvas or ImageData from the camera; returns hands in the source's 0..1 image space
    detect(source) {
      const now = performance.now();
      if (now <= last) return null;
      last = now;
      const r = lm.detectForVideo(source, now);
      return (r.landmarks || []).map((pts, i) => {
        const d = (a, b) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
        const size = d(0, 9) || 1e-3;                              // wrist to middle knuckle: the hand's apparent size
        return {
          id: r.handedness?.[i]?.[0]?.categoryName || String(i),
          pinch: d(4, 8) / size,                                    // thumb tip to index tip, relative to hand size
          x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2,
          size,
        };
      });
    },
    close() { try { lm.close(); } catch {} },
  };
}
