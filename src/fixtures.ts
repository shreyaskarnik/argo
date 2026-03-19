import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { NarrationTimeline } from './narration.js';
import { resetManifestCache } from './overlays/manifest-loader.js';

type TimelineFactory = (title: string) => NarrationTimeline;

const defaultFactory: TimelineFactory = () => new NarrationTimeline();

export function createNarrationFixture(factory: TimelineFactory = defaultFactory) {
  return async (
    _context: Record<string, unknown>,
    use: (timeline: NarrationTimeline) => Promise<void>,
    testInfo: { title: string },
  ) => {
    const timeline = factory(testInfo.title);
    timeline.start();
    try {
      await use(timeline);
    } finally {
      await timeline.flush(`narration-${testInfo.title}.json`);
    }
  };
}

export async function demoType(
  page: Page,
  selectorOrLocator: string | { pressSequentially: (text: string, options?: { delay?: number }) => Promise<void> },
  text: string,
  delay = 60,
): Promise<void> {
  const locator = typeof selectorOrLocator === 'string'
    ? page.locator(selectorOrLocator)
    : selectorOrLocator;
  await locator.pressSequentially(text, { delay });
}

function loadSceneDurations(): Record<string, number> | undefined {
  const durationsPath = process.env.ARGO_SCENE_DURATIONS_PATH;
  if (!durationsPath || !existsSync(durationsPath)) return undefined;
  try {
    return JSON.parse(readFileSync(durationsPath, 'utf-8'));
  } catch (err) {
    console.warn(
      `Warning: failed to parse scene durations from ${durationsPath}: ${(err as Error).message}. ` +
      `Falling back to default durations. Clear .argo/ and re-run the pipeline if timing is wrong.`
    );
    return undefined;
  }
}

export const test = base.extend<{ narration: NarrationTimeline }>({
  narration: async ({}, use, testInfo) => {
    // Auto-discover overlay manifest when running from VS Code or standalone
    // Playwright (without argo pipeline setting ARGO_OVERLAYS_PATH).
    // Uses the test file basename (e.g., showcase.demo.ts → showcase) rather
    // than testInfo.title, since titles can be anything ("Showcase demo", etc.)
    const pipelineOverlayPath = process.env.ARGO_OVERLAYS_PATH;
    let autoDiscovered = false;

    if (!pipelineOverlayPath) {
      const fileBase = basename(testInfo.file).replace(/\.demo\.ts$/, '');
      const candidates = [
        `demos/${fileBase}.scenes.json`,
        `${fileBase}.scenes.json`,
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          process.env.ARGO_OVERLAYS_PATH = candidate;
          autoDiscovered = true;
          break;
        }
      }
    }

    // Reset manifest cache so each test gets a fresh read
    resetManifestCache();

    const durations = loadSceneDurations();
    const timeline = new NarrationTimeline(durations);
    timeline.start();
    try {
      await use(timeline);
    } finally {
      // Restore original env to avoid leaking across tests in the same worker
      if (autoDiscovered) {
        delete process.env.ARGO_OVERLAYS_PATH;
        resetManifestCache();
      }

      const argoDir = process.env.ARGO_OUTPUT_DIR;
      const outputPath = argoDir
        ? `${argoDir}/.timing.json`
        : `narration-${testInfo.title}.json`;
      await timeline.flush(outputPath);
    }
  },
});

export { expect };
