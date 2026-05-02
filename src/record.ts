import { execFile } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { startAssetServer, type AssetServer } from './asset-server.js';
import { loadOverlayManifest, hasImageAssets } from './overlays/manifest.js';
import { normalizeDeviceScaleFactor, type BrowserEngine, type ShowActionsConfig } from './config.js';

export interface RecordOptions {
  demosDir: string;
  baseURL: string;
  video: { width: number; height: number; fps?: number };
  browser?: BrowserEngine;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  contextOptions?: Record<string, unknown>;
  autoBackground?: boolean;
  defaultPlacement?: string;
  allowRawGsap?: boolean;
  headed?: boolean;
  /** Override the .argo subdirectory name (for variants). Default: demoName. */
  argoSubdir?: string;
  /** Auto-annotate Playwright interactions in the recording. */
  showActions?: boolean | ShowActionsConfig;
  /** Capture a JPEG per scene mark for the preview scrubber. Default: true. */
  sceneThumbnails?: boolean;
  /** Capture all frames as JPEGs and stitch in post for higher quality. */
  captureMode?: 'webm' | 'jpeg-stitch';
  /** JPEG quality 0-100. Used by jpeg-stitch mode. */
  jpegQuality?: number;
}

export interface RecordResult {
  videoPath: string;
  timingPath: string;
}

function createPlaywrightConfig(demoName: string, options: RecordOptions, outputDir: string): string {
  const demosDir = path.resolve(options.demosDir);
  const { width, height } = options.video;
  const browser = options.browser ?? 'chromium';
  const deviceScaleFactor = normalizeDeviceScaleFactor(options.deviceScaleFactor);

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

  // Chromium's CDP screencast captures JPEGs at viewport CSS pixels regardless
  // of `deviceScaleFactor` (Page.startScreencast caps at viewport, not at the
  // emulated device pixel ratio). The `--force-device-scale-factor` launch flag
  // pins the renderer's native DPR so screencast frames come out at true 2x/3x
  // resolution — required for supersampled lanczos downscale in export.
  const needsDpiFlag = browser === 'chromium' && deviceScaleFactor > 1;
  const launchOptionsField = needsDpiFlag
    ? `\n        launchOptions: { args: ['--force-device-scale-factor=${deviceScaleFactor}'] },`
    : '';

  // Recording is driven by `narration.startRecording(page)` which calls
  // page.screencast.start() at the first scene — no Playwright recordVideo here.
  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  preserveOutput: 'always',
  outputDir: ${JSON.stringify(outputDir)},
  projects: [
    {
      name: 'demos',
      testDir: ${JSON.stringify(demosDir)},
      testMatch: ${JSON.stringify(`${demoName}.demo.ts`)},
      use: {
        headless: ${options.headed ? 'false' : 'true'},
        browserName: ${JSON.stringify(browser)},
        baseURL: ${JSON.stringify(options.baseURL)},
        viewport: { width: ${width}, height: ${height} },
        deviceScaleFactor: ${deviceScaleFactor},${extraUse}${launchOptionsField}
        video: 'off',
        trace: 'off',
      },
    },
  ],
});
`;
}

export async function record(demoName: string, options: RecordOptions): Promise<RecordResult> {
  const argoDir = path.join('.argo', options.argoSubdir ?? demoName);
  mkdirSync(argoDir, { recursive: true });

  // Clean stale recordings from any previous capture mode. Switching between
  // jpeg-stitch and webm leaves the other format on disk, and downstream code
  // that auto-detects the input file (preview, clip extraction) can pick the
  // wrong one — silently exporting last run's video.
  for (const stale of ['video.mp4', 'video.webm', '.engine-discard.webm']) {
    const stalePath = path.join(argoDir, stale);
    if (existsSync(stalePath)) {
      try { unlinkSync(stalePath); } catch { /* best-effort */ }
    }
  }

  // jpeg-stitch (stream-encode) produces an H.264 mp4 directly — JPEG frames
  // are piped to ffmpeg child in narration.startRecording, bypassing
  // Playwright's hardcoded VP8 encoder. Default mode keeps Playwright's WebM.
  //
  // jpeg-stitch is chromium-only in practice: webkit/firefox screencast
  // onFrame delivery is far below 30fps (firefox typically ~3fps), so
  // 80%+ of frames get synthesized as duplicates and the page-side test
  // hits its timeout while the CDP transport drains. Auto-fall back to
  // webm with a loud warning rather than letting the recording hang.
  const browserName = options.browser ?? 'chromium';
  let useJpegStitch = options.captureMode === 'jpeg-stitch';
  if (useJpegStitch && browserName !== 'chromium') {
    console.warn(
      `Warning: captureMode: 'jpeg-stitch' is chromium-only — ` +
      `${browserName}'s screencast cannot sustain the JPEG framerate. ` +
      `Falling back to captureMode: 'webm' for this run.`,
    );
    useJpegStitch = false;
  }

  // deviceScaleFactor > 1 only works on chromium (via --force-device-scale-factor).
  // webkit/firefox keep the page at 1x but the screencast still captures at the
  // 2x/3x viewport size — the page renders into the upper-left of the frame and
  // the rest is empty gray pixels (a "frame within a frame" once the export's
  // frame effect wraps it). Clamp to 1 with a warning rather than producing
  // unusable output.
  const requestedDsf = normalizeDeviceScaleFactor(options.deviceScaleFactor);
  if (requestedDsf > 1 && browserName !== 'chromium') {
    console.warn(
      `Warning: deviceScaleFactor: ${requestedDsf} is chromium-only — ` +
      `${browserName} renders the page at 1x while the screencast captures at ` +
      `${requestedDsf}x, leaving the right and bottom of every frame empty. ` +
      `Clamping to 1 for this run.`,
    );
    options = { ...options, deviceScaleFactor: 1 };
  }
  const videoExt = useJpegStitch ? '.mp4' : '.webm';
  const videoPath = path.join(argoDir, `video${videoExt}`);
  // Playwright's screencast.start still requires a `path` even when we ignore
  // its WebM output (we feed JPEGs to our own ffmpeg via onFrame). Route it to
  // a discardable sidecar so it doesn't clobber our streamed mp4.
  const enginePath = useJpegStitch
    ? path.join(argoDir, '.engine-discard.webm')
    : videoPath;
  const timingPath = path.join(argoDir, '.timing.json');
  const testResultsDir = path.resolve('test-results');
  const recordConfigPath = path.join(argoDir, 'playwright.record.config.mjs');

  writeFileSync(recordConfigPath, createPlaywrightConfig(demoName, options, testResultsDir), 'utf-8');

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

  // Stale live-frame from a previous run would mislead polling clients
  // (preview "Re-record" button) — drop it.
  const liveFramePath = path.join(argoDir, '.live-frame.jpg');
  if (existsSync(liveFramePath)) unlinkSync(liveFramePath);

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

      // Encode showActions as JSON when set so the runtime can pass it straight
      // through to page.screencast.showActions(). Empty string means "off".
      let showActionsEnv = '';
      if (options.showActions === true) {
        showActionsEnv = '{}';
      } else if (options.showActions && typeof options.showActions === 'object') {
        showActionsEnv = JSON.stringify(options.showActions);
      }

      // Per-scene thumbs: default ON. Pass '0' to opt out, anything else (including '') means on.
      const sceneThumbsEnv = options.sceneThumbnails === false ? '0' : '1';
      const thumbsDir = path.resolve(path.join(argoDir, 'thumbs'));
      mkdirSync(thumbsDir, { recursive: true });

      // jpeg-stitch (stream-encode) mode: narration.startRecording spawns an
      // ffmpeg child and pipes JPEGs from `onFrame` directly into it. ARGO_STREAM_OUT
      // is the mp4 path that ffmpeg writes; ARGO_FPS sets the input cadence (frame
      // gaps in CDP get padded with frame duplicates to match wallclock).
      const streamOutPath = useJpegStitch ? path.resolve(videoPath) : '';
      // At deviceScaleFactor>1 in stream-encode, every CDP frame is a 4K JPEG.
      // Quality 95 produces JPEGs large enough that the CDP transport (encode
      // + IPC + parse) can't sustain wallclock pace on heavy SPAs. Frames pile
      // up upstream of onFrame, arrivals lag paint, and visuals fall behind
      // audio. Default to 80 (3-4x smaller JPEGs) when the user hasn't pinned
      // a value — explicit jpegQuality always wins.
      const dsf = normalizeDeviceScaleFactor(options.deviceScaleFactor);
      const defaultJpegQuality = useJpegStitch && dsf > 1 ? 80 : 95;
      const jpegQuality = String(options.jpegQuality ?? defaultJpegQuality);

      execFile('npx', ['playwright', 'test', '--config', recordConfigPath, '--grep', demoName, '--project', 'demos'], {
        env: {
          ...process.env,
          ARGO_DEMO_NAME: demoName,
          ARGO_OUTPUT_DIR: path.resolve(argoDir),
          ARGO_PROGRESS_PATH: progressPath,
          ARGO_SCREENCAST_PATH: path.resolve(enginePath),
          ARGO_SCREENCAST_WIDTH: String(options.video.width * normalizeDeviceScaleFactor(options.deviceScaleFactor)),
          ARGO_SCREENCAST_HEIGHT: String(options.video.height * normalizeDeviceScaleFactor(options.deviceScaleFactor)),
          ARGO_SHOW_ACTIONS: showActionsEnv,
          ARGO_SCENE_THUMBS: sceneThumbsEnv,
          ARGO_THUMBS_DIR: thumbsDir,
          ARGO_LIVE_FRAME_PATH: path.resolve(path.join(argoDir, '.live-frame.jpg')),
          ARGO_STREAM_OUT: streamOutPath,
          ARGO_FPS: String(options.video.fps ?? 30),
          ARGO_JPEG_QUALITY: jpegQuality,
          // CDP-direct screencast: chromium-only path that uses paint timestamps
          // (CDP metadata.timestamp) instead of arrival wallclock for frame
          // numbering. Sidesteps the throughput-induced visual lag that the
          // hotfix only mitigates. Disable via ARGO_CDP_DIRECT=0 to fall back
          // to the legacy onFrame + image2pipe path (e.g. for debugging).
          ARGO_USE_CDP_DIRECT:
            process.env.ARGO_CDP_DIRECT === '0'
              ? ''
              : (useJpegStitch && browserName === 'chromium' ? '1' : ''),
          BASE_URL: options.baseURL,
          ARGO_ASSET_URL: assetServer?.url ?? '',
          ARGO_AUTO_BACKGROUND: options.autoBackground ? '1' : '',
          ARGO_DEFAULT_PLACEMENT: options.defaultPlacement ?? '',
          ARGO_ALLOW_RAW_GSAP: options.allowRawGsap ? '1' : '',
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

        // narration.startRecording() wrote the screencast directly to videoPath.
        // If it's missing, the demo never called startRecording() — fail loudly.
        if (!existsSync(videoPath)) {
          reject(new Error(
            `No screencast recording found at ${videoPath}. ` +
            `Ensure the demo calls 'await narration.startRecording(page)' before the first 'narration.mark()'.`
          ));
          return;
        }

        // Verify timing file was written by the narration fixture
        if (!existsSync(timingPath)) {
          reject(new Error(
            `No timing file found at ${timingPath}. ` +
            `Ensure the demo uses the argo test fixture with narration.mark() calls.`
          ));
          return;
        }

        // Clean up the engine's discardable WebM in stream-encode mode.
        // Playwright requires a path for screencast.start, but we ignore that
        // output entirely (frames go straight to our ffmpeg child via onFrame).
        if (useJpegStitch && existsSync(enginePath)) {
          try { rmSync(enginePath); } catch { /* best-effort */ }
        }

        resolve({ videoPath, timingPath });
      });
    });
  } finally {
    if (assetServer) await assetServer.close();
  }
}
