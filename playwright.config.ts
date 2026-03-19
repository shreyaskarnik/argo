/// <reference types="node" />
import { defineConfig } from '@playwright/test';

/**
 * Playwright config for VS Code's test extension.
 *
 * Reads the showcase demo config for browser/viewport settings.
 * For the full pipeline (TTS + record + export), use:
 *   npx argo pipeline <demo> --config demos/showcase.config.mjs
 */
export default defineConfig({
  preserveOutput: 'always',
  projects: [
    {
      name: 'demos',
      testDir: 'demos',
      testMatch: '**/*.demo.ts',
      use: {
        browserName: 'chromium',
        baseURL: process.env.BASE_URL ?? 'http://localhost:8976',
        viewport: { width: 1920, height: 1080 },
        video: {
          mode: 'on',
          size: { width: 1920, height: 1080 },
        },
      },
    },
  ],
});
