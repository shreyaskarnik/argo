import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RecordOptions {
  demosDir: string;
  baseURL: string;
  video: { width: number; height: number };
}

export interface RecordResult {
  videoPath: string;
  timingPath: string;
}

function findVideoInResults(testResultsDir: string): string | undefined {
  if (!existsSync(testResultsDir)) return undefined;
  for (const entry of readdirSync(testResultsDir, { recursive: true })) {
    const name = typeof entry === 'string' ? entry : entry.toString();
    if (name.endsWith('.webm')) {
      return path.join(testResultsDir, name);
    }
  }
  return undefined;
}

function createPlaywrightConfig(options: RecordOptions, outputDir: string): string {
  const demosDir = path.resolve(options.demosDir);
  const { width, height } = options.video;

  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  preserveOutput: 'always',
  outputDir: ${JSON.stringify(outputDir)},
  projects: [
    {
      name: 'demos',
      testDir: ${JSON.stringify(demosDir)},
      testMatch: '**/*.demo.ts',
      use: {
        baseURL: ${JSON.stringify(options.baseURL)},
        viewport: { width: ${width}, height: ${height} },
        video: {
          mode: 'on',
          size: { width: ${width}, height: ${height} },
        },
      },
    },
  ],
});
`;
}

export function record(demoName: string, options: RecordOptions): Promise<RecordResult> {
  const argoDir = path.join('.argo', demoName);
  mkdirSync(argoDir, { recursive: true });

  const videoPath = path.join(argoDir, 'video.webm');
  const timingPath = path.join(argoDir, '.timing.json');
  const testResultsDir = path.resolve('test-results');
  const recordConfigPath = path.join(argoDir, 'playwright.record.config.mjs');

  writeFileSync(recordConfigPath, createPlaywrightConfig(options, testResultsDir), 'utf-8');

  // Clean test-results to avoid picking up stale videos
  rmSync(testResultsDir, { recursive: true, force: true });

  return new Promise((resolve, reject) => {
    execFile('npx', ['playwright', 'test', '--config', recordConfigPath, '--grep', demoName, '--project', 'demos'], {
      env: {
        ...process.env,
        ARGO_DEMO_NAME: demoName,
        ARGO_OUTPUT_DIR: argoDir,
        BASE_URL: options.baseURL,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        reject(new Error(`Playwright recording failed:\n${output}`));
        return;
      }

      // Copy the video from test-results/ to .argo/<demo>/video.webm
      const found = findVideoInResults(testResultsDir);
      if (!found) {
        reject(new Error(
          `No video recording found in test-results/. ` +
          `Ensure playwright.config.ts has video: 'on' or video: { mode: 'on' }.`
        ));
        return;
      }
      copyFileSync(found, videoPath);

      // Verify timing file was written by the narration fixture
      if (!existsSync(timingPath)) {
        reject(new Error(
          `No timing file found at ${timingPath}. ` +
          `Ensure the demo uses the argo test fixture with narration.mark() calls.`
        ));
        return;
      }

      resolve({ videoPath, timingPath });
    });
  });
}
