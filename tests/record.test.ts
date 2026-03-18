import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('generates a Playwright config from record options and copies artifacts', async () => {
    execFileMock.mockImplementation((_cmd, args, options, callback) => {
      const testResultsDir = resolve(tempDir, 'test-results');
      const argoOutputDir = options.env.ARGO_OUTPUT_DIR as string;

      mkdirSync(join(testResultsDir, 'demo-run'), { recursive: true });
      writeFileSync(join(testResultsDir, 'demo-run', 'video.webm'), 'video');
      mkdirSync(resolve(tempDir, argoOutputDir), { recursive: true });
      writeFileSync(resolve(tempDir, argoOutputDir, '.timing.json'), '{}');

      callback(null, '', '');
      return {} as never;
    });

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
    expect(config).toContain('size: { width: 1280, height: 720 }');
    expect(existsSync(join(tempDir, '.argo', 'demo', 'video.webm'))).toBe(true);
    expect(result).toEqual({
      videoPath: join('.argo', 'demo', 'video.webm'),
      timingPath: join('.argo', 'demo', '.timing.json'),
    });
    expect(execFileMock).toHaveBeenCalledWith(
      'npx',
      [
        'playwright',
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
          ARGO_OUTPUT_DIR: join('.argo', 'demo'),
          BASE_URL: 'http://localhost:4321',
        }),
      }),
      expect.any(Function),
    );
  });

  it('normalizes deviceScaleFactor in generated Playwright config', async () => {
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const testResultsDir = resolve(tempDir, 'test-results');
      const argoOutputDir = options.env.ARGO_OUTPUT_DIR as string;

      mkdirSync(join(testResultsDir, 'demo-run'), { recursive: true });
      writeFileSync(join(testResultsDir, 'demo-run', 'video.webm'), 'video');
      mkdirSync(resolve(tempDir, argoOutputDir), { recursive: true });
      writeFileSync(resolve(tempDir, argoOutputDir, '.timing.json'), '{}');

      callback(null, '', '');
      return {} as never;
    });

    await record('demo', {
      demosDir: 'custom-demos',
      baseURL: 'http://localhost:4321',
      video: { width: 1280, height: 720 },
      browser: 'webkit',
      deviceScaleFactor: 1.6,
    });

    const configPath = join(tempDir, '.argo', 'demo', 'playwright.record.config.mjs');
    const config = readFileSync(configPath, 'utf-8');

    expect(config).toContain("browserName: \"webkit\"");
    expect(config).toContain('deviceScaleFactor: 2');
    expect(config).toContain('size: { width: 2560, height: 1440 }');
  });

  it('includes isMobile, hasTouch, and contextOptions in generated config', async () => {
    execFileMock.mockImplementation((_cmd, _args, options, callback) => {
      const testResultsDir = resolve(tempDir, 'test-results');
      const argoOutputDir = options.env.ARGO_OUTPUT_DIR as string;

      mkdirSync(join(testResultsDir, 'demo-run'), { recursive: true });
      writeFileSync(join(testResultsDir, 'demo-run', 'video.webm'), 'video');
      mkdirSync(resolve(tempDir, argoOutputDir), { recursive: true });
      writeFileSync(resolve(tempDir, argoOutputDir, '.timing.json'), '{}');

      callback(null, '', '');
      return {} as never;
    });

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
