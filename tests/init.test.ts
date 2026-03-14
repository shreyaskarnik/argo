import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { init } from '../src/init.js';

describe('init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates demos/ directory', async () => {
    await init(dir);
    const { stat } = await import('node:fs/promises');
    const s = await stat(join(dir, 'demos'));
    expect(s.isDirectory()).toBe(true);
  });

  it('creates example.demo.ts with correct content', async () => {
    await init(dir);
    const content = await readFile(join(dir, 'demos', 'example.demo.ts'), 'utf-8');
    expect(content).toContain("import { test } from '@argo-video/cli'");
    expect(content).toContain("import { showOverlay, withOverlay } from '@argo-video/cli'");
    expect(content).toContain("narration.mark('welcome')");
    expect(content).toContain('showOverlay(page,');
    expect(content).toContain('withOverlay(page,');
    expect(content).toContain('narration.durationFor(');
  });

  it('creates example.voiceover.json with valid JSON array', async () => {
    await init(dir);
    const content = await readFile(join(dir, 'demos', 'example.voiceover.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(3);
    expect(parsed[0]).toHaveProperty('scene');
    expect(parsed[0]).toHaveProperty('text');
  });

  it('creates example.overlays.json with valid JSON array', async () => {
    await init(dir);
    const content = await readFile(join(dir, 'demos', 'example.overlays.json'), 'utf-8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0]).toHaveProperty('scene');
    expect(parsed[0]).toHaveProperty('type');
    expect(parsed[1].type).toBe('headline-card');
    expect(parsed[1].placement).toBe('top-left');
  });

  it('creates argo.config.mjs with defineConfig and comments', async () => {
    await init(dir);
    const content = await readFile(join(dir, 'argo.config.mjs'), 'utf-8');
    expect(content).toContain("import { defineConfig } from '@argo-video/cli'");
    expect(content).toContain('export default defineConfig(');
    expect(content).toContain('baseURL');
    expect(content).toContain('// deviceScaleFactor: 2,');
    expect(content).toContain('autoBackground: true');
  });

  it('creates playwright.config.ts wired to argo.config.mjs', async () => {
    await init(dir);
    const content = await readFile(join(dir, 'playwright.config.ts'), 'utf-8');

    expect(content).toContain("import config from './argo.config.mjs'");
    expect(content).toContain('Math.max(1, Math.round(config.video?.deviceScaleFactor ?? 1))');
    expect(content).toContain("browserName: config.video?.browser ?? 'chromium'");
    expect(content).toContain('deviceScaleFactor: scale');
    expect(content).toContain('size: { width: width * scale, height: height * scale }');
  });

  it('does NOT overwrite existing files', async () => {
    await mkdir(join(dir, 'demos'), { recursive: true });
    await writeFile(join(dir, 'demos', 'example.demo.ts'), 'existing content');
    await writeFile(join(dir, 'argo.config.mjs'), 'existing config');

    await init(dir);

    const demo = await readFile(join(dir, 'demos', 'example.demo.ts'), 'utf-8');
    expect(demo).toBe('existing content');

    const config = await readFile(join(dir, 'argo.config.mjs'), 'utf-8');
    expect(config).toBe('existing config');
  });
});
