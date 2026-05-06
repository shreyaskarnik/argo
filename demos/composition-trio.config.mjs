import { defineConfig } from '@argo-video/cli';

// Stable chromium config — apple-money-count and blue-sweater-intro-video
// are GSAP-only blocks, no html-in-canvas / WebGL / GLTF dependency.
export default defineConfig({
  baseURL: 'about:blank',
  demosDir: 'demos',
  outputDir: 'videos',
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
  },
});
