import { defineConfig } from '@argo-video/cli';

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
    // 2x DPI capture — page keeps the normal 1920px desktop layout while the
    // recorder captures a 3840×2160 source.
    // Requires --force-device-scale-factor flag (auto-applied by record.ts) so
    // the CDP screencast actually delivers 4K JPEGs (without the flag,
    // screencast caps at viewport CSS pixels regardless of DPR).
    deviceScaleFactor: 2,
    // EXPERIMENT (feat/jpeg-stitch): capture all frames as high-quality JPEGs
    // and stitch in post with libx264 — bypasses the engine's VP8 encoder.
    captureMode: 'jpeg-stitch',
    jpegQuality: 95,
    showActions: false,
  },
  export: {
    preset: 'slow',
    // CRF 14: showcase content is mostly dark gradient backgrounds with text
    // overlays. CRF 16 left visible banding in those flat dark regions even
    // with libx264's aq-mode=3. CRF 14 gives ~1.5–2× more bits where it
    // matters (dark/flat regions) at modest file-size cost.
    crf: 14,
    // Pin the encoder so preview re-export matches pipeline output exactly.
    // Without this, preview defaults to GPU (videotoolbox watercolor risk).
    encoder: 'cpu',
    // Keep the 1920px-wide desktop layout during recording, but export a 4K
    // master so the 2x capture is not downscaled back to 1080p.
    outputWidth: 3840,
    outputHeight: 2160,
    transition: { type: 'shader', shader: 'crosswarp', durationMs: 1200 },
    // speedRamp: { gapSpeed: 2.0, minGapMs: 600 },  // disabled for now — conflicts with transitions
    // formats: ['gif'],  // too long for GIF — use argo clip for scene-level GIFs
    audio: { loudnorm: true },
    watermark: {
      src: 'assets/logo-watermark.png',
      position: 'bottom-right',
      opacity: 0.16,
      // 4K master: scale up so the watermark stays visually-relative to a
      // 1080p master, and bump margin proportionally. The PNG is sampled with
      // bicubic during scale — for cleanest output, replace with a 2× asset
      // when one is available.
      scale: 2,
      margin: 52,
    },
    sharpen: true,
    // Frame: wrap the recording in a styled frame with padding, rounded corners,
    // drop shadow, and a gradient background (the "Screen Studio" look).
    frame: {
      padding: 48,
      borderRadius: 16,
      shadow: 0.32,
      background: { type: 'gradient', value: 'linear-gradient(135deg, #1a1a2e, #16213e)' },
    },
    // Motion blur: time-gated to zoom-in/zoom-out intervals via ffmpeg enable expressions.
    // motionBlur: { intensity: 0.5 },
    // variants: [
    //   { name: 'vertical', video: { width: 1080, height: 1920 } },
    //   { name: 'square',   video: { width: 1080, height: 1080 } },
    // ],
  },
  overlays: {
    autoBackground: true,
  },
});
