import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDemo } from '../src/validate.js';

describe('validateDemo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-validate-'));
    await mkdir(join(dir, 'demos'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('errors when demo script is missing', () => {
    const result = validateDemo({ demoName: 'missing', demosDir: join(dir, 'demos') });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Demo script not found');
  });

  it('errors when script does not import from @argo-video/cli', async () => {
    await writeFile(join(dir, 'demos', 'bad.demo.ts'), `
      import { test } from '@playwright/test';
      test('bad', async ({ page }) => {
        page.goto('/');
      });
    `);
    const result = validateDemo({ demoName: 'bad', demosDir: join(dir, 'demos') });
    expect(result.errors.some(e => e.includes("@argo-video/cli"))).toBe(true);
  });

  it('warns when no narration.mark() calls found', async () => {
    await writeFile(join(dir, 'demos', 'empty.demo.ts'), `
      import { test } from '@argo-video/cli';
      test('empty', async ({ page }) => {
        await page.goto('/');
      });
    `);
    const result = validateDemo({ demoName: 'empty', demosDir: join(dir, 'demos') });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('No narration.mark()'))).toBe(true);
  });

  it('warns when voiceover manifest is missing', async () => {
    await writeFile(join(dir, 'demos', 'novoice.demo.ts'), `
      import { test } from '@argo-video/cli';
      test('novoice', async ({ page, narration }) => {
        narration.mark('intro');
      });
    `);
    const result = validateDemo({ demoName: 'novoice', demosDir: join(dir, 'demos') });
    expect(result.warnings.some(w => w.includes('No voiceover manifest'))).toBe(true);
  });

  it('warns on scene name mismatch between script and voiceover', async () => {
    await writeFile(join(dir, 'demos', 'mismatch.demo.ts'), `
      import { test } from '@argo-video/cli';
      test('mismatch', async ({ page, narration }) => {
        narration.mark('intro');
        narration.mark('ending');
      });
    `);
    await writeFile(join(dir, 'demos', 'mismatch.voiceover.json'), JSON.stringify([
      { scene: 'intro', text: 'Hello' },
      { scene: 'typo-scene', text: 'Oops' },
    ]));
    const result = validateDemo({ demoName: 'mismatch', demosDir: join(dir, 'demos') });
    expect(result.warnings.some(w => w.includes('"typo-scene" has no matching narration.mark'))).toBe(true);
    expect(result.warnings.some(w => w.includes('"ending" has no voiceover entry'))).toBe(true);
  });

  it('errors on invalid voiceover JSON', async () => {
    await writeFile(join(dir, 'demos', 'badjson.demo.ts'), `
      import { test } from '@argo-video/cli';
      test('badjson', async ({ page, narration }) => { narration.mark('a'); });
    `);
    await writeFile(join(dir, 'demos', 'badjson.voiceover.json'), '{ not valid json');
    const result = validateDemo({ demoName: 'badjson', demosDir: join(dir, 'demos') });
    expect(result.errors.some(e => e.includes('not valid JSON'))).toBe(true);
  });

  it('errors on invalid overlay type/placement/motion', async () => {
    await writeFile(join(dir, 'demos', 'badoverlay.demo.ts'), `
      import { test } from '@argo-video/cli';
      test('badoverlay', async ({ page, narration }) => { narration.mark('a'); });
    `);
    await writeFile(join(dir, 'demos', 'badoverlay.overlays.json'), JSON.stringify([
      { scene: 'a', type: 'invalid-type', placement: 'invalid-zone', motion: 'invalid-motion' },
    ]));
    const result = validateDemo({ demoName: 'badoverlay', demosDir: join(dir, 'demos') });
    expect(result.errors.some(e => e.includes('unknown type'))).toBe(true);
    expect(result.errors.some(e => e.includes('unknown placement'))).toBe(true);
    expect(result.errors.some(e => e.includes('unknown motion'))).toBe(true);
  });

  it('passes cleanly with valid demo + voiceover', async () => {
    await writeFile(join(dir, 'demos', 'good.demo.ts'), `
      import { test } from '@argo-video/cli';
      import { showOverlay } from '@argo-video/cli';
      test('good', async ({ page, narration }) => {
        narration.mark('intro');
        narration.mark('done');
      });
    `);
    await writeFile(join(dir, 'demos', 'good.voiceover.json'), JSON.stringify([
      { scene: 'intro', text: 'Welcome' },
      { scene: 'done', text: 'Goodbye' },
    ]));
    const result = validateDemo({ demoName: 'good', demosDir: join(dir, 'demos') });
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
