import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { applyComponent, removeComponent, resolveBlocksDir } from '../../src/hf/apply-component.js';

const SNIPPET = `<div id="hf-vignette"></div>
<style>#hf-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse, transparent var(--vignette-size, 45%), rgba(0,0,0,0.7) 100%); }</style>
<script>document.documentElement.dataset.hfScriptRan = '1';</script>`;

let browser: Browser;
let page: Page;
let tmp: string;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser.close(); });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'argo-apply-'));
  mkdirSync(join(tmp, 'vignette'), { recursive: true });
  writeFileSync(join(tmp, 'vignette', 'vignette.html'), SNIPPET);
  page = await browser.newPage();
  await page.setContent('<h1>app</h1>');
});
afterEach(async () => {
  await page.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveBlocksDir', () => {
  it('prefers explicit, then env, then "blocks"', () => {
    const prev = process.env.ARGO_BLOCKS_DIR;
    delete process.env.ARGO_BLOCKS_DIR;
    expect(resolveBlocksDir('x')).toBe('x');
    expect(resolveBlocksDir()).toBe('blocks');
    process.env.ARGO_BLOCKS_DIR = '/tmp/bd';
    expect(resolveBlocksDir()).toBe('/tmp/bd');
    if (prev === undefined) delete process.env.ARGO_BLOCKS_DIR; else process.env.ARGO_BLOCKS_DIR = prev;
  });
});

describe('applyComponent / removeComponent', () => {
  it('injects container + style + runs script, applies params, and removes cleanly', async () => {
    await applyComponent(page, 'vignette', {
      blocksDir: tmp,
      params: { '--vignette-size': '30%' },
    });

    expect(await page.locator('#argo-hf-vignette').count()).toBe(1);
    expect(await page.locator('style[data-argo-hf="vignette"]').count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.dataset.hfScriptRan)).toBe('1');
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--vignette-size'),
      ),
    ).toBe('30%');

    await removeComponent(page, 'vignette');
    expect(await page.locator('#argo-hf-vignette').count()).toBe(0);
    expect(await page.locator('style[data-argo-hf="vignette"]').count()).toBe(0);
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--vignette-size'),
      ),
    ).toBe('');
  });

  it('throws for a component that is not installed', async () => {
    await expect(applyComponent(page, 'nope', { blocksDir: tmp })).rejects.toThrow(/argo add nope/);
  });

  it('rejects unsafe params before touching the page', async () => {
    await expect(
      applyComponent(page, 'vignette', { blocksDir: tmp, params: { '--x': 'red; }' } }),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      applyComponent(page, 'vignette', { blocksDir: tmp, params: { 'not-a-var': 'red' } }),
    ).rejects.toThrow(/custom property/i);
  });
}, 60_000);
