import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { NarrationTimeline } from './narration.js';

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
    const durations = loadSceneDurations();
    const timeline = new NarrationTimeline(durations);
    timeline.start();
    try {
      await use(timeline);
    } finally {
      const argoDir = process.env.ARGO_OUTPUT_DIR;
      const outputPath = argoDir
        ? `${argoDir}/.timing.json`
        : `narration-${testInfo.title}.json`;
      await timeline.flush(outputPath);
    }
  },
});

export { expect };
