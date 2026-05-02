import { defineConfig } from '@argo-video/cli';

// CI smoke config — exercises the cross-browser robustness fixes:
//   * captureMode: 'jpeg-stitch' auto-downgrades to 'webm' on non-chromium
//   * deviceScaleFactor: 2 auto-clamps to 1 on non-chromium
//   * shader transition exercises setsar=1 normalization on webkit
// Silent demo (no text in scenes manifest) — TTS is skipped, video-only export.
export default defineConfig({
  // Demo uses page.setContent — baseURL is unused but required by config schema.
  baseURL: 'about:blank',
  demosDir: 'demos',
  outputDir: 'videos',
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    deviceScaleFactor: 2,
    captureMode: 'jpeg-stitch',
  },
  export: {
    preset: 'ultrafast',
    crf: 28,
    encoder: 'cpu',
    transition: { type: 'shader', shader: 'crosswarp', durationMs: 600 },
  },
});
