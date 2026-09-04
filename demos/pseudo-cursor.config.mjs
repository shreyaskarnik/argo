import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  // Playwright fulfills this origin from pseudo-cursor.html; no server needed.
  baseURL: 'http://pseudo-cursor.test',
  demosDir: 'demos',
  outputDir: 'videos',
  video: {
    width: 1280,
    height: 720,
    fps: 30,
    browser: 'chromium',
    captureMode: 'jpeg-stitch',
    // The SVG travels alone. Brief circles locate it on appearance or a click.
    cursorHighlight: { mode: 'click', radius: 24, opacity: 0.9 },
  },
  export: { encoder: 'cpu', preset: 'fast', crf: 18 },
});
