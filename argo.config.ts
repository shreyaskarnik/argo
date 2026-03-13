import { defineConfig } from 'argo';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos/',
  outputDir: 'videos/',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 2560, height: 1440, fps: 30 },
  export: { preset: 'slow', crf: 16 },
});
