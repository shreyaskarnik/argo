import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Recording is driven by `narration.startRecording(page)`, not Playwright's
 * `recordVideo`. A demo that marks scenes without it generates voiceover, runs
 * the browser, and only then fails at export with "No screencast recording
 * found" — so the cost lands at the end of a full pipeline run.
 *
 * Nothing else catches this: the suite mocks recording, and CI's ci-smoke uses
 * a demo that does call it. Three demos shipped without it, including the one
 * backing the quickstart in example/README.md.
 *
 * `renderComposition` is the one legitimate alternative — it calls
 * startRecording itself when the host is not already recording
 * (src/composition.ts), which is how demos/argo-launch.demo.ts is covered.
 */
function demoDirs(): string[] {
  return [join(ROOT, 'demos'), join(ROOT, 'example', 'demos')].filter(existsSync);
}

/** A demo is discoverable by the pipeline only if it has a scenes manifest. */
function discoverableDemos(): Array<{ name: string; script: string }> {
  const found: Array<{ name: string; script: string }> = [];
  for (const dir of demoDirs()) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.scenes.json')) continue;
      const name = entry.slice(0, -'.scenes.json'.length);
      const script = join(dir, `${name}.demo.ts`);
      if (existsSync(script)) found.push({ name, script });
    }
  }
  return found;
}

describe('every discoverable demo starts recording', () => {
  const demos = discoverableDemos();

  it('finds demos to check', () => {
    expect(demos.length).toBeGreaterThan(0);
  });

  it.each(demos)('$name calls startRecording (or renderComposition)', ({ script }) => {
    const source = readFileSync(script, 'utf8');
    const starts = source.includes('startRecording') || source.includes('renderComposition');
    expect(starts).toBe(true);
  });
});
