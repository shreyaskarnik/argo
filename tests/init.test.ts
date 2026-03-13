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
    expect(content).toContain("import { test, demoType } from 'argo'");
    expect(content).toContain('narration.showCaption');
    expect(content).toContain('narration.withCaption');
    expect(content).toContain("narration.mark('done')");
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

  it('creates argo.config.js with config', async () => {
    await init(dir);
    const content = await readFile(join(dir, 'argo.config.js'), 'utf-8');
    expect(content).toContain('export default');
    expect(content).toContain('baseURL');
  });

  it('does NOT overwrite existing files', async () => {
    await mkdir(join(dir, 'demos'), { recursive: true });
    await writeFile(join(dir, 'demos', 'example.demo.ts'), 'existing content');
    await writeFile(join(dir, 'argo.config.js'), 'existing config');

    await init(dir);

    const demo = await readFile(join(dir, 'demos', 'example.demo.ts'), 'utf-8');
    expect(demo).toBe('existing content');

    const config = await readFile(join(dir, 'argo.config.js'), 'utf-8');
    expect(config).toBe('existing config');
  });
});
