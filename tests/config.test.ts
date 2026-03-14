import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  defineConfig,
  loadConfig,
  demosProject,
  type ArgoConfig,
  type TTSEngine,
} from '../src/config.js';

const DEFAULTS: ArgoConfig = {
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 1920, height: 1080, fps: 30, browser: 'chromium', deviceScaleFactor: 1 },
  export: { preset: 'slow', crf: 16 },
  overlays: { autoBackground: false },
};

// ---------- defineConfig ----------
describe('defineConfig', () => {
  it('returns defaults when given an empty object', () => {
    const config = defineConfig({});
    expect(config).toEqual(DEFAULTS);
  });

  it('merges top-level overrides while preserving unset defaults', () => {
    const config = defineConfig({ baseURL: 'http://localhost:3000', demosDir: 'my-demos' });
    expect(config.baseURL).toBe('http://localhost:3000');
    expect(config.demosDir).toBe('my-demos');
    expect(config.outputDir).toBe('videos');
    expect(config.tts).toEqual(DEFAULTS.tts);
    expect(config.video).toEqual(DEFAULTS.video);
    expect(config.export).toEqual(DEFAULTS.export);
  });

  it('deep-merges nested tts config', () => {
    const config = defineConfig({ tts: { defaultSpeed: 1.5 } });
    expect(config.tts.defaultVoice).toBe('af_heart');
    expect(config.tts.defaultSpeed).toBe(1.5);
  });

  it('deep-merges nested video config', () => {
    const config = defineConfig({ video: { width: 1920, height: 1080 } });
    expect(config.video.width).toBe(1920);
    expect(config.video.height).toBe(1080);
    expect(config.video.fps).toBe(30);
  });

  it('normalizes deviceScaleFactor to a positive integer', () => {
    const rounded = defineConfig({ video: { deviceScaleFactor: 1.6 } });
    const clamped = defineConfig({ video: { deviceScaleFactor: 0.4 } });

    expect(rounded.video.deviceScaleFactor).toBe(2);
    expect(clamped.video.deviceScaleFactor).toBe(1);
  });

  it('deep-merges nested export config', () => {
    const config = defineConfig({ export: { crf: 23 } });
    expect(config.export.preset).toBe('slow');
    expect(config.export.crf).toBe(23);
  });

  it('preserves a custom TTS engine', () => {
    const engine: TTSEngine = {
      generate: async (_text, _options) => Buffer.from('audio'),
    };
    const config = defineConfig({ tts: { engine } });
    expect(config.tts.engine).toBe(engine);
    expect(config.tts.defaultVoice).toBe('af_heart');
  });
});

// ---------- demosProject ----------
describe('demosProject', () => {
  it('returns the correct Playwright project shape', () => {
    const project = demosProject({ baseURL: 'http://localhost:4000' });
    expect(project).toEqual({
      name: 'demos',
      testDir: 'demos',
      testMatch: '**/*.demo.ts',
      use: {
        browserName: 'chromium',
        baseURL: 'http://localhost:4000',
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        video: {
          mode: 'on',
          size: { width: 1920, height: 1080 },
        },
      },
    });
  });

  it('uses a custom demosDir as testDir', () => {
    const project = demosProject({ baseURL: 'http://localhost:4000', demosDir: 'my-demos' });
    expect(project.testDir).toBe('my-demos');
  });

  it('normalizes scale and applies custom browser and capture size', () => {
    const project = demosProject({
      baseURL: 'http://localhost:4000',
      browser: 'webkit',
      deviceScaleFactor: 1.6,
      video: { width: 1440, height: 900 },
    });

    expect(project.use).toEqual({
      browserName: 'webkit',
      baseURL: 'http://localhost:4000',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      video: {
        mode: 'on',
        size: { width: 2880, height: 1800 },
      },
    });
  });
});

// ---------- loadConfig ----------
describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'argo-config-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig(tmpDir);
    expect(config).toEqual(DEFAULTS);
  });

  it('loads argo.config.js and merges with defaults', async () => {
    await writeFile(
      join(tmpDir, 'argo.config.js'),
      `export default { demosDir: 'custom-demos', tts: { defaultSpeed: 2.0 } };`,
    );
    const config = await loadConfig(tmpDir);
    expect(config.demosDir).toBe('custom-demos');
    expect(config.tts.defaultSpeed).toBe(2.0);
    expect(config.tts.defaultVoice).toBe('af_heart');
    expect(config.outputDir).toBe('videos');
  });

  it('loads argo.config.mjs', async () => {
    await writeFile(
      join(tmpDir, 'argo.config.mjs'),
      `export default { outputDir: 'out' };`,
    );
    const config = await loadConfig(tmpDir);
    expect(config.outputDir).toBe('out');
    expect(config.demosDir).toBe('demos');
  });

  it('loads from an explicit path', async () => {
    const customDir = join(tmpDir, 'nested');
    await mkdir(customDir, { recursive: true });
    const customPath = join(customDir, 'my-config.mjs');
    await writeFile(customPath, `export default { baseURL: 'http://example.com' };`);

    const config = await loadConfig(tmpDir, customPath);
    expect(config.baseURL).toBe('http://example.com');
    expect(config.demosDir).toBe('demos');
  });

  it('rejects config that exports a string', async () => {
    await writeFile(
      join(tmpDir, 'argo.config.mjs'),
      `export default "not an object";`,
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('must export a plain object');
  });

  it('rejects config that exports an array', async () => {
    await writeFile(
      join(tmpDir, 'argo.config.mjs'),
      `export default [{ baseURL: "http://localhost" }];`,
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('must export a plain object');
  });

  it('rejects config that exports null', async () => {
    await writeFile(
      join(tmpDir, 'argo.config.mjs'),
      `export default null;`,
    );
    await expect(loadConfig(tmpDir)).rejects.toThrow('must export a plain object');
  });

  it('finds argo.config.ts first in search order', async () => {
    await writeFile(
      join(tmpDir, 'argo.config.ts'),
      `export default { demosDir: 'from-ts' };`,
    );
    await writeFile(
      join(tmpDir, 'argo.config.js'),
      `export default { demosDir: 'from-js' };`,
    );
    const config = await loadConfig(tmpDir);
    expect(config.demosDir).toBe('from-ts');
  });
});
