import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:8080',
  demosDir: 'demos',
  outputDir: 'videos',
  video: {
    browser: 'webkit',
  },
  overlays: {
    autoBackground: true,
  },
});
