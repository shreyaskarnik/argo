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
    // q88 (not 95): the catalog scene captures a playing video preview —
    // q95 frames of video noise saturate the stitch writer.
    jpegQuality: 88,
    // The live-site scenes occasionally wedge the renderer under screencast;
    // one retry re-runs the demo rather than failing the pipeline.
    retries: 1,
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
    // whip-pan: fast camera-language cut — matches the "choreography" thesis
    // and never smears on-screen text the way long warps do.
    transition: { type: 'shader', shader: 'whip-pan', durationMs: 1600, accent: '#0ea5e9' },
  },
});
