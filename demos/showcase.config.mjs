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
  },
  export: {
    preset: 'slow',
    crf: 23,
    transition: { type: 'fade-through-black', durationMs: 2000 },
    // speedRamp: { gapSpeed: 2.0, minGapMs: 600 },  // disabled for now — conflicts with transitions
    formats: ['gif'],
    audio: { loudnorm: true },
    // variants: [
    //   { name: 'vertical', video: { width: 1080, height: 1920 } },
    //   { name: 'square',   video: { width: 1080, height: 1080 } },
    // ],
  },
  overlays: {
    autoBackground: true,
  },
});
