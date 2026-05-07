import { defineConfig } from '@argo-video/cli';

// Argo × Hyperframes crossover demo (Plan A).
//
// Stable chromium + jpeg-stitch + DSF=2 (Argo's high-quality recording path).
// Compositions are GSAP-only — no Canary / html-in-canvas needed.
//
// Run:
//   BASE_URL=http://127.0.0.1:8976 \
//     npx argo pipeline argo-launch --config demos/argo-launch.config.mjs
export default defineConfig({
  baseURL: 'http://127.0.0.1:8976',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'chromium',
    captureMode: 'jpeg-stitch',
    deviceScaleFactor: 2,
  },
  export: {
    preset: 'medium',
    crf: 18,
    encoder: 'cpu',
    transition: { type: 'fade-through-black', durationMs: 600 },
    audio: { loudnorm: true },
  },
  overlays: {
    autoBackground: true,
  },
});
