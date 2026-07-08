import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:8976',
  demosDir: 'demos',
  outputDir: 'videos',
  blocksDir: 'blocks',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'chromium',
    captureMode: 'jpeg-stitch',
    jpegQuality: 95,
    showActions: false,
  },
  export: {
    preset: 'slow',
    // Dark story-page backdrops — same banding rationale as the main showcase.
    crf: 14,
    encoder: 'cpu',
    // Track 1 dogfood: hyperframes-ported shader at every boundary, tinted
    // with the brand accent (domain-warp uses accentDark/accentBright for its
    // edge glow).
    transition: { type: 'shader', shader: 'domain-warp', durationMs: 2400, accent: '#0ea5e9' },
  },
});
