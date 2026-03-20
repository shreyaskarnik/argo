import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, existsSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { startAssetServer, type AssetServer } from './asset-server.js';
import { loadOverlayManifest, hasImageAssets } from './overlays/manifest.js';
import { normalizeDeviceScaleFactor, type BrowserEngine } from './config.js';

export interface RecordOptions {
  demosDir: string;
  baseURL: string;
  video: { width: number; height: number };
  browser?: BrowserEngine;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  contextOptions?: Record<string, unknown>;
  autoBackground?: boolean;
  defaultPlacement?: string;
  headed?: boolean;
  /** Override the .argo subdirectory name (for variants). Default: demoName. */
  argoSubdir?: string;
}

export interface RecordResult {
  videoPath: string;
  timingPath: string;
}

function findFileInResults(testResultsDir: string, extension: string): string | undefined {
  if (!existsSync(testResultsDir)) return undefined;
  for (const entry of readdirSync(testResultsDir, { recursive: true })) {
    const name = typeof entry === 'string' ? entry : entry.toString();
    if (name.endsWith(extension)) {
      return path.join(testResultsDir, name);
    }
  }
  return undefined;
}

function createPlaywrightConfig(options: RecordOptions, outputDir: string): string {
  const demosDir = path.resolve(options.demosDir);
  const { width, height } = options.video;
  const browser = options.browser ?? 'chromium';
  const deviceScaleFactor = normalizeDeviceScaleFactor(options.deviceScaleFactor);

  // When using a non-default scale factor, record at the scaled resolution
  // so Playwright captures every physical pixel. The export step will
  // downscale back to the logical resolution with a high-quality filter.
  const captureWidth = width * deviceScaleFactor;
  const captureHeight = height * deviceScaleFactor;

  // Build optional context options (isMobile, hasTouch, colorScheme, etc.)
  const extraUseFields: string[] = [];
  if (options.isMobile) extraUseFields.push(`        isMobile: true,`);
  if (options.hasTouch) extraUseFields.push(`        hasTouch: true,`);
  if (options.contextOptions) {
    for (const [key, value] of Object.entries(options.contextOptions)) {
      extraUseFields.push(`        ${key}: ${JSON.stringify(value)},`);
    }
  }
  const extraUse = extraUseFields.length > 0 ? '\n' + extraUseFields.join('\n') : '';

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
        headless: ${options.headed ? 'false' : 'true'},
        browserName: ${JSON.stringify(browser)},
        baseURL: ${JSON.stringify(options.baseURL)},
        viewport: { width: ${width}, height: ${height} },
        deviceScaleFactor: ${deviceScaleFactor},${extraUse}
        video: {
          mode: 'on',
          size: { width: ${captureWidth}, height: ${captureHeight} },
        },
        trace: 'on',
      },
    },
  ],
});
`;
}

export async function record(demoName: string, options: RecordOptions): Promise<RecordResult> {
  const argoDir = path.join('.argo', options.argoSubdir ?? demoName);
  mkdirSync(argoDir, { recursive: true });

  const videoPath = path.join(argoDir, 'video.webm');
  const timingPath = path.join(argoDir, '.timing.json');
  const testResultsDir = path.resolve('test-results');
  const recordConfigPath = path.join(argoDir, 'playwright.record.config.mjs');

  writeFileSync(recordConfigPath, createPlaywrightConfig(options, testResultsDir), 'utf-8');

  // Clean test-results to avoid picking up stale videos
  rmSync(testResultsDir, { recursive: true, force: true });

  // Start asset server if overlay manifest has image assets
  let assetServer: AssetServer | undefined;
  const overlayManifestPath = path.join(options.demosDir, `${demoName}.scenes.json`);
  try {
    const overlayEntries = await loadOverlayManifest(overlayManifestPath);
    if (overlayEntries && hasImageAssets(overlayEntries)) {
      const assetDir = path.join(options.demosDir, 'assets');
      assetServer = await startAssetServer(assetDir);
    }
  } catch (err) {
    // A malformed overlay manifest should not block recording —
    // overlays are rendered by explicit showOverlay()/withOverlay() calls in the demo script,
    // not from the manifest. Only warn.
    console.warn(`Warning: could not parse overlay manifest: ${(err as Error).message}`);
  }

  // Progress file for live scene status during recording
  const progressPath = path.join(argoDir, '.scene-progress.jsonl');
  if (existsSync(progressPath)) unlinkSync(progressPath);

  try {
    return await new Promise<RecordResult>((resolve, reject) => {
      // Poll the progress file to print scene names as they're recorded
      const seenScenes = new Set<string>();
      const progressPoll = setInterval(() => {
        try {
          if (!existsSync(progressPath)) return;
          const lines = readFileSync(progressPath, 'utf-8').trim().split('\n');
          for (const line of lines) {
            if (!line) continue;
            const { scene } = JSON.parse(line);
            if (scene && !seenScenes.has(scene)) {
              seenScenes.add(scene);
              console.log(`    🎯 ${scene}`);
            }
          }
        } catch { /* best-effort */ }
      }, 500);

      execFile('npx', ['playwright', 'test', '--config', recordConfigPath, '--grep', demoName, '--project', 'demos'], {
        env: {
          ...process.env,
          ARGO_DEMO_NAME: demoName,
          ARGO_OUTPUT_DIR: argoDir,
          ARGO_PROGRESS_PATH: progressPath,
          BASE_URL: options.baseURL,
          ARGO_ASSET_URL: assetServer?.url ?? '',
          ARGO_AUTO_BACKGROUND: options.autoBackground ? '1' : '',
          ARGO_DEFAULT_PLACEMENT: options.defaultPlacement ?? '',
          ARGO_SCENE_DURATIONS_PATH: path.resolve(path.join('.argo', demoName, '.scene-durations.json')),
          ARGO_OVERLAYS_PATH: path.resolve(path.join(options.demosDir, `${demoName}.scenes.json`)),
        },
      }, (error, stdout, stderr) => {
        clearInterval(progressPoll);
        // When DEBUG env vars are set (e.g., DEBUG=pw:api), forward Playwright's
        // debug output to stderr so users can see it even on success.
        if (process.env.DEBUG && stderr) {
          process.stderr.write(stderr);
        }
        if (error) {
          const output = [stdout, stderr].filter(Boolean).join('\n');
          reject(new Error(`Playwright recording failed:\n${output}`));
          return;
        }

        // Copy the video from test-results/ to .argo/<demo>/video.webm
        const found = findFileInResults(testResultsDir, '.webm');
        if (!found) {
          reject(new Error(
            `No video recording found in test-results/. ` +
            `Ensure playwright.config.ts has video: 'on' or video: { mode: 'on' }.`
          ));
          return;
        }
        copyFileSync(found, videoPath);

        // Copy trace if captured
        const traceFile = findFileInResults(testResultsDir, '.zip');
        if (traceFile) {
          const traceDest = path.join(argoDir, 'trace.zip');
          copyFileSync(traceFile, traceDest);
        }

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
  } finally {
    if (assetServer) await assetServer.close();
  }
}
