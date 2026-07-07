import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDemo } from '../../src/validate.js';

describe('validate: hf-component + accent', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'argo-validate-hf-'));
    mkdirSync(join(tmp, 'demos'), { recursive: true });
    mkdirSync(join(tmp, 'blocks', 'vignette'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'vignette', 'vignette.html'), '<div></div>');
    writeFileSync(
      join(tmp, 'demos', 'd.demo.ts'),
      `import { test } from '@argo-video/cli';\ntest('d', async ({ page, narration }) => { narration.mark('intro'); });\n`,
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeManifest(overlay: unknown) {
    const entry: Record<string, unknown> = { scene: 'intro', text: 'hi' };
    if (overlay !== undefined) entry.overlay = overlay;
    writeFileSync(join(tmp, 'demos', 'd.scenes.json'), JSON.stringify([entry]));
  }

  it('accepts an installed hf-component', async () => {
    writeManifest({ type: 'hf-component', name: 'vignette' });
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
    });
    expect(result.errors.filter((e) => e.includes('hf-component'))).toEqual([]);
  });

  it('errors on a missing hf-component with an install hint', async () => {
    writeManifest({ type: 'hf-component', name: 'grain-overlay' });
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
    });
    expect(result.errors.some((e) => /grain-overlay[\s\S]*argo add/.test(e))).toBe(true);
  });

  it('errors on an hf-component cue missing "name"', async () => {
    writeManifest({ type: 'hf-component' });
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
    });
    expect(result.errors.some((e) => /hf-component.*name/i.test(e))).toBe(true);
  });

  it('errors on an hf-component name with path traversal characters', async () => {
    writeManifest({ type: 'hf-component', name: '../evil' });
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
    });
    expect(result.errors.some((e) => /invalid hf-component name/.test(e))).toBe(true);
  });

  it('errors on a malformed transition accent', async () => {
    writeManifest(undefined);
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
      transitionAccent: 'blue',
    });
    expect(result.errors.some((e) => /accent.*hex/i.test(e))).toBe(true);
  });

  it('accepts a valid transition accent', async () => {
    writeManifest(undefined);
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
      transitionAccent: '#0EA5E9',
    });
    expect(result.errors.filter((e) => /accent/i.test(e))).toEqual([]);
  });

  it('accepts a valid transition accent without leading #', async () => {
    writeManifest(undefined);
    const result = await validateDemo({
      demoName: 'd',
      demosDir: join(tmp, 'demos'),
      blocksDir: join(tmp, 'blocks'),
      transitionAccent: '0ea5e9',
    });
    expect(result.errors.filter((e) => /accent/i.test(e))).toEqual([]);
  });
});
