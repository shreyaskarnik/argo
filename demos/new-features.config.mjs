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
    browser: 'webkit',
  },
  export: {
    preset: 'slow',
    crf: 16,
    transition: { type: 'fade-through-black', durationMs: 400 },
  },
  overlays: {
    autoBackground: true,
  },
});
