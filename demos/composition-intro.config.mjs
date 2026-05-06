import { defineConfig } from '@argo-video/cli';

// Composition demo — renders compositions/intro.html as a single Argo scene.
// Demonstrates the renderComposition primitive without involving any
// recorded app content.
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
