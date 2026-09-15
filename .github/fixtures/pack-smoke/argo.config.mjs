import { defineConfig } from '@argo-video/cli';

// Deliberately minimal. The cross-browser `ci-smoke` job already covers
// capture-mode downgrades, dsf clamping and shader transitions; this fixture
// exists only to answer "does the published tarball record and export at all",
// so it avoids anything that would slow the run or add a failure mode of its own.
export default defineConfig({
  // The demo uses page.setContent — baseURL is unused but the schema requires it.
  baseURL: 'about:blank',
  demosDir: 'demos',
  outputDir: 'videos',
  video: { width: 1920, height: 1080, fps: 30 },
  export: { preset: 'ultrafast', crf: 28, encoder: 'cpu' },
});
