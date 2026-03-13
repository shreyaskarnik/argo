import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { startFakeServer, type FakeServer } from './fake-server.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

let server: FakeServer;

beforeAll(async () => {
  server = await startFakeServer();
});

afterAll(async () => {
  await server.close();
});

describe('E2E: argo record', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'argo-e2e-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function writePlaywrightConfig(baseURL: string): Promise<void> {
    // testDir uses absolute path so Playwright can find it from any cwd
    const demosDir = join(workDir, 'demos');
    const config = `
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'demos',
      testDir: '${demosDir}',
      testMatch: '**/*.demo.ts',
      use: {
        baseURL: '${baseURL}',
        video: 'on',
      },
    },
  ],
  outputDir: '${join(workDir, 'test-results')}',
});
`;
    return writeFile(join(workDir, 'playwright.config.ts'), config);
  }

  function writeDemoFile(): Promise<void> {
    const demo = `
import { test, expect } from '@playwright/test';

test('example', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Welcome to Argo Demo');
  await page.click('#action');
  await expect(page.locator('#result')).toHaveText('Done!');
});
`;
    return writeFile(join(workDir, 'demos', 'example.demo.ts'), demo);
  }

  function runPlaywright(): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        'npx',
        [
          'playwright', 'test',
          '--config', join(workDir, 'playwright.config.ts'),
          '--grep', 'example',
          '--project', 'demos',
        ],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            BASE_URL: server.url,
            NODE_PATH: join(PROJECT_ROOT, 'node_modules'),
          },
          timeout: 30_000,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Playwright failed:\n${stdout}\n${stderr}`));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  it('records a demo against the fake server', async () => {
    await mkdir(join(workDir, 'demos'), { recursive: true });
    await writePlaywrightConfig(server.url);
    await writeDemoFile();

    await runPlaywright();

    // Playwright with video: 'on' creates test-results/<test-name>/video.webm
    const testResults = join(workDir, 'test-results');
    const resultsStat = await stat(testResults);
    expect(resultsStat.isDirectory()).toBe(true);

    // Find the video file somewhere in test-results
    const entries = await readdir(testResults, { recursive: true });
    const videoFile = entries.find((e) => e.endsWith('.webm'));
    expect(videoFile).toBeDefined();
  }, 60_000);
});
