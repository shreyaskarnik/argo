import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
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

export function record(demoName: string, options: RecordOptions): Promise<RecordResult> {
  const argoDir = path.join('.argo', demoName);
  mkdirSync(argoDir, { recursive: true });

  const videoPath = path.join(argoDir, 'video.webm');
  const timingPath = path.join(argoDir, '.timing.json');

  // Clean test-results to avoid picking up stale videos
  rmSync('test-results', { recursive: true, force: true });

  return new Promise((resolve, reject) => {
    execFile('npx', ['playwright', 'test', '--grep', demoName, '--project', 'demos'], {
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
      const found = findVideoInResults('test-results');
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
