import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { record } from '../src/record.js';

const originalCwd = process.cwd();

describe('record', () => {
  let tempDir: string;

  beforeEach(async () => {
    execFileMock.mockReset();
    tempDir = await mkdtemp(join(tmpdir(), 'argo-record-'));
    process.chdir(tempDir);
    mkdirSync('custom-demos', { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  // Common mock: simulate the in-process narration fixture writing the
  // screencast directly to ARGO_SCREENCAST_PATH and the timing JSON.
  function mockSubprocessSuccess() {
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const argoOutputDir = options.env.ARGO_OUTPUT_DIR as string;
      const screencastPath = options.env.ARGO_SCREENCAST_PATH as string;

      mkdirSync(resolve(tempDir, argoOutputDir), { recursive: true });
      writeFileSync(screencastPath, 'video');
      writeFileSync(resolve(tempDir, argoOutputDir, '.timing.json'), '{}');

      callback(null, '', '');
      return {} as never;
    });
  }

  it('generates a Playwright config from record options and lands the screencast at the known path', async () => {
    mockSubprocessSuccess();

    const result = await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
    });

    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    const config = readFileSync(configPath, 'utf-8');

    expect(config).toContain(`testDir: ${JSON.stringify(resolve('custom-demos'))}`);
    expect(config).toContain(`baseURL: ${JSON.stringify('http://localhost:4321')}`);
    expect(config).toContain('viewport: { width: 1280, height: 720 }');
    // Recording is driven by page.screencast.start() in the fixture, not Playwright recordVideo.
    expect(config).toContain("video: 'off'");
    expect(existsSync(join(tempDir, '.argo', 'demo', 'video.webm'))).toBe(true);
    expect(result).toEqual({
      videoPath: join('.argo', 'demo', 'video.webm'),
      timingPath: join('.argo', 'demo', '.timing.json'),
    });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      [
        playwrightCli,
        'test',
        '--config',
        join('.argo', 'demo', 'playwright.record.config.mjs'),
        '--grep',
        'demo',
        '--project',
        'demos',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          ARGO_OUTPUT_DIR: resolve(join('.argo', 'demo')),
          ARGO_SCREENCAST_PATH: resolve(join('.argo', 'demo', 'video.webm')),
          ARGO_SCREENCAST_WIDTH: '1280',
          ARGO_SCREENCAST_HEIGHT: '720',
          // showActions defaults off, sceneThumbs defaults on
          ARGO_SHOW_ACTIONS: '',
          ARGO_CURSOR_HIGHLIGHT: '',
          ARGO_SCENE_THUMBS: '1',
          ARGO_THUMBS_DIR: resolve(join('.argo', 'demo', 'thumbs')),
          ARGO_LIVE_FRAME_PATH: resolve(join('.argo', 'demo', '.live-frame.jpg')),
          BASE_URL: 'http://localhost:4321',
        }),
      }),
      expect.any(Function),
    );
    // The thumbs/ dir should be created by record() so the runtime can write into it.
    expect(existsSync(join(tempDir, '.argo', 'demo', 'thumbs'))).toBe(true);
  });

  it('serializes showActions config to ARGO_SHOW_ACTIONS env', async () => {
    mockSubprocessSuccess();

    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      showActions: { position: 'bottom-left', fontSize: 18 },
    });

    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ARGO_SHOW_ACTIONS: JSON.stringify({ position: 'bottom-left', fontSize: 18 }),
        }),
      }),
      expect.any(Function),
    );
  });

  it('passes showActions: true as empty-object JSON', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      showActions: true,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ ARGO_SHOW_ACTIONS: '{}' }) }),
      expect.any(Function),
    );
  });

  it('serializes automatic cursor highlight options to the recording runtime', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      cursorHighlight: { color: '#ff0000', radius: 24, clickRipple: false },
    });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ARGO_CURSOR_HIGHLIGHT: JSON.stringify({ color: '#ff0000', radius: 24, clickRipple: false }),
        }),
      }),
      expect.any(Function),
    );
  });

  it('passes cursorHighlight: true as default-options JSON', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      cursorHighlight: true,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ ARGO_CURSOR_HIGHLIGHT: '{}' }) }),
      expect.any(Function),
    );
  });

  it('honors sceneThumbnails: false to opt out of per-scene thumbs', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      sceneThumbnails: false,
    });
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ ARGO_SCENE_THUMBS: '0' }) }),
      expect.any(Function),
    );
  });

  it('drops a stale .live-frame.jpg from a prior run before recording', async () => {
    // Pre-seed a stale live frame
    const argoDir = join(tempDir, '.argo', 'demo');
    mkdirSync(argoDir, { recursive: true });
    const stalePath = join(argoDir, '.live-frame.jpg');
    writeFileSync(stalePath, 'stale-bytes');
    expect(existsSync(stalePath)).toBe(true);

    // Mock that doesn't write a new live frame — simulating a recording where
    // onFrame never fired (browser failed early). Stale frame must be gone.
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const argoOutputDir = options.env.ARGO_OUTPUT_DIR as string;
      mkdirSync(resolve(tempDir, argoOutputDir), { recursive: true });
      writeFileSync(options.env.ARGO_SCREENCAST_PATH, 'video');
      writeFileSync(resolve(tempDir, argoOutputDir, '.timing.json'), '{}');
      callback(null, '', '');
      return {} as never;
    });

    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
    });

    expect(existsSync(stalePath)).toBe(false);
  });

  it('reports jpeg-stitch finalization failures without blaming startRecording', async () => {
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const argoOutputDir = options.env.ARGO_OUTPUT_DIR as string;
      mkdirSync(resolve(tempDir, argoOutputDir), { recursive: true });
      writeFileSync(resolve(tempDir, argoOutputDir, '.timing.json'), '{}');
      callback(null, '', '');
      return {} as never;
    });

    await expect(record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      browser: 'chromium',
      captureMode: 'jpeg-stitch',
    })).rejects.toThrow(
      `captureMode: 'jpeg-stitch' did not produce ${join('.argo', 'demo', 'video.mp4')}`,
    );
  });

  it('normalizes deviceScaleFactor and scales the screencast size env accordingly', async () => {
    mockSubprocessSuccess();

    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      browser: 'chromium',
      deviceScaleFactor: 1.6,
    });

    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    const config = readFileSync(configPath, 'utf-8');

    expect(config).toContain("browserName: \"chromium\"");
    expect(config).toContain('deviceScaleFactor: 2');
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ARGO_SCREENCAST_WIDTH: '2560',
          ARGO_SCREENCAST_HEIGHT: '1440',
        }),
      }),
      expect.any(Function),
    );
  });

  it('clamps deviceScaleFactor to 1 on non-chromium browsers', async () => {
    // webkit/firefox don't honor --force-device-scale-factor — page renders at 1x
    // while screencast captures at the 2x viewport, leaving 75% of frames empty.
    mockSubprocessSuccess();

    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      browser: 'webkit',
      deviceScaleFactor: 2,
    });

    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    const config = readFileSync(configPath, 'utf-8');

    expect(config).toContain('deviceScaleFactor: 1');
    expect(execFileMock).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          ARGO_SCREENCAST_WIDTH: '1280',
          ARGO_SCREENCAST_HEIGHT: '720',
        }),
      }),
      expect.any(Function),
    );
  });

  it('embeds retries: 0 in the generated playwright config by default', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:3000',
      video: { width: 1280, height: 720 },
      browser: 'chromium',
    });
    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    expect(readFileSync(configPath, 'utf-8')).toContain('retries: 0');
  });

  it('embeds the requested retries count in the generated playwright config', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:3000',
      video: { width: 1280, height: 720 },
      browser: 'chromium',
      retries: 2,
    });
    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    expect(readFileSync(configPath, 'utf-8')).toContain('retries: 2');
  });

  it('clamps negative retries to 0 and floors fractional retries', async () => {
    mockSubprocessSuccess();
    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:3000',
      video: { width: 1280, height: 720 },
      browser: 'chromium',
      retries: 2.7,
    });
    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    expect(readFileSync(configPath, 'utf-8')).toContain('retries: 2');
  });

  it('includes isMobile, hasTouch, and contextOptions in generated config', async () => {
    mockSubprocessSuccess();

    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:3000',
      video: { width: 390, height: 664 },
      browser: 'webkit',
      isMobile: true,
      hasTouch: true,
      contextOptions: { colorScheme: 'dark' },
    });

    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    const config = readFileSync(configPath, 'utf-8');

    expect(config).toContain('viewport: { width: 390, height: 664 }');
    expect(config).toContain('isMobile: true');
    expect(config).toContain('hasTouch: true');
    expect(config).toContain('colorScheme: "dark"');
  });
});
