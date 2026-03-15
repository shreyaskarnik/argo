import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initFrom } from '../src/init.js';

const SAMPLE_TEST = `
import { test, expect } from '@playwright/test';

test('checkout flow', async ({ page }) => {
  await page.goto('/products');
  await page.click('.product-card');

  await page.click('#add-to-cart');
  await expect(page.locator('.cart-count')).toHaveText('1');

  await page.goto('/checkout');
  await page.fill('#card-number', '4242424242424242');
  await page.click('#pay-now');
});
`;

describe('initFrom', () => {
  let dir: string;
  let testFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-init-from-'));
    testFile = join(dir, 'checkout.spec.ts');
    await writeFile(testFile, SAMPLE_TEST, 'utf-8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates demo script with narration fixture', async () => {
    await initFrom({ from: testFile, cwd: dir });
    const content = await readFile(join(dir, 'demos', 'checkout.demo.ts'), 'utf-8');
    expect(content).toContain("import { test } from '@argo-video/cli'");
    expect(content).toContain('narration.mark(');
    expect(content).toContain('narration.durationFor(');
    expect(content).toContain('async ({ page, narration })');
  });

  it('creates voiceover skeleton with _hint fields', async () => {
    await initFrom({ from: testFile, cwd: dir });
    const content = await readFile(join(dir, 'demos', 'checkout.voiceover.json'), 'utf-8');
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry).toHaveProperty('scene');
      expect(entry).toHaveProperty('text', '');
      expect(entry).toHaveProperty('_hint');
    }
  });

  it('creates overlays skeleton', async () => {
    await initFrom({ from: testFile, cwd: dir });
    const content = await readFile(join(dir, 'demos', 'checkout.overlays.json'), 'utf-8');
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry).toHaveProperty('scene');
      expect(entry).toHaveProperty('type', 'lower-third');
      expect(entry).toHaveProperty('text');
    }
  });

  it('creates config files', async () => {
    await initFrom({ from: testFile, cwd: dir });
    const config = await readFile(join(dir, 'argo.config.mjs'), 'utf-8');
    expect(config).toContain('defineConfig');
    const pw = await readFile(join(dir, 'playwright.config.ts'), 'utf-8');
    expect(pw).toContain("import config from './argo.config.mjs'");
  });

  it('derives demo name from filename', async () => {
    await initFrom({ from: testFile, cwd: dir });
    const content = await readFile(join(dir, 'demos', 'checkout.demo.ts'), 'utf-8');
    expect(content).toBeTruthy();
  });

  it('respects --demo name override', async () => {
    await initFrom({ from: testFile, demo: 'my-flow', cwd: dir });
    const content = await readFile(join(dir, 'demos', 'my-flow.demo.ts'), 'utf-8');
    expect(content).toBeTruthy();
    const vo = await readFile(join(dir, 'demos', 'my-flow.voiceover.json'), 'utf-8');
    expect(vo).toBeTruthy();
  });

  it('does not overwrite existing files', async () => {
    await mkdir(join(dir, 'demos'), { recursive: true });
    await writeFile(join(dir, 'demos', 'checkout.demo.ts'), 'existing');

    await initFrom({ from: testFile, cwd: dir });

    const content = await readFile(join(dir, 'demos', 'checkout.demo.ts'), 'utf-8');
    expect(content).toBe('existing');
  });

  it('throws on file with no Playwright actions', async () => {
    const emptyTest = join(dir, 'empty.ts');
    await writeFile(emptyTest, 'const x = 1;\n', 'utf-8');

    await expect(initFrom({ from: emptyTest, cwd: dir })).rejects.toThrow('No scenes detected');
  });

  it('handles .test.ts extension in filename', async () => {
    const testPath = join(dir, 'signup.test.ts');
    await writeFile(testPath, SAMPLE_TEST, 'utf-8');

    await initFrom({ from: testPath, cwd: dir });
    const content = await readFile(join(dir, 'demos', 'signup.demo.ts'), 'utf-8');
    expect(content).toBeTruthy();
  });

  it('scene names in voiceover match scene names in demo script', async () => {
    await initFrom({ from: testFile, cwd: dir });

    const demoContent = await readFile(join(dir, 'demos', 'checkout.demo.ts'), 'utf-8');
    const voContent = await readFile(join(dir, 'demos', 'checkout.voiceover.json'), 'utf-8');
    const overlayContent = await readFile(join(dir, 'demos', 'checkout.overlays.json'), 'utf-8');

    const voScenes = JSON.parse(voContent).map((e: any) => e.scene);
    const overlayScenes = JSON.parse(overlayContent).map((e: any) => e.scene);

    // Every voiceover scene should appear as a mark() in the demo
    for (const scene of voScenes) {
      expect(demoContent).toContain(`narration.mark('${scene}')`);
    }

    // Overlays should match voiceover scenes
    expect(overlayScenes).toEqual(voScenes);
  });
});
