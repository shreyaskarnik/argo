import { defineConfig } from '@argo-video/cli';

// Render an imported hyperframes block (vfx-iphone-device) as an Argo
// composition scene. The block uses html-in-canvas (CanvasDrawElement),
// which is currently Canary-only behind a flag.
//
// Run: npx argo pipeline composition-iphone --config demos/composition-iphone.config.mjs
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
    experimentalCanvasDrawElement: true,
    browserChannel: 'chrome-canary',
  },
  export: {
    preset: 'medium',
    crf: 18,
    encoder: 'cpu',
  },
});
