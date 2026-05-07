import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import { schedulePlacements, type Placement } from './tts/align.js';
import type { CameraMove } from './camera-move.js';
import { startCdpScreencast, type CdpScreencastHandle } from './cdp-screencast.js';

/**
 * Subset of Playwright's Page we depend on — typed structurally so we don't
 * pull `@playwright/test` types into the runtime module.
 */
interface ScreencastPage {
  screencast: {
    start(options?: {
      path?: string;
      size?: { width: number; height: number };
      quality?: number;
      onFrame?: (frame: { data: Buffer }) => void | Promise<void>;
      annotate?: { duration?: number; position?: string; fontSize?: number };
    }): Promise<unknown>;
    stop(): Promise<void>;
    showActions(options?: {
      duration?: number;
      fontSize?: number;
      position?: 'top-left' | 'top' | 'top-right' | 'bottom-left' | 'bottom' | 'bottom-right';
    }): Promise<unknown>;
  };
  evaluate<R>(pageFunction: () => R | Promise<R>): Promise<R>;
  on(event: 'framenavigated', listener: (frame: { parentFrame: () => unknown }) => void): unknown;
  off(event: 'framenavigated', listener: (frame: { parentFrame: () => unknown }) => void): unknown;
  context(): unknown;
}

export interface StartRecordingOptions {
  /** Override the recording size (defaults to the screencast page viewport). */
  size?: { width: number; height: number };
  /** JPEG quality for the optional onFrame stream — passed straight through. */
  quality?: number;
}

export interface SceneDurationOptions {
  leadInMs?: number;
  leadOutMs?: number;
  minMs?: number;
  maxMs?: number;
  multiplier?: number;
  fallbackMs?: number;
}

export interface CursorSample {
  /** Normalized X position (0..1 of viewport width). */
  cx: number;
  /** Normalized Y position (0..1 of viewport height). */
  cy: number;
  /** Timestamp in ms from timeline start. */
  timeMs: number;
}

export class NarrationTimeline {
  private timings: Map<string, number> = new Map();
  private startTime: number | null = null;
  private sceneDurations: Record<string, number> = {};
  private cachedPlacements: Placement[] | null = null;
  private _cameraMoves: CameraMove[] = [];
  private _cursorTelemetry: CursorSample[] = [];
  private _fallbackWarned = false;
  private _screencastStop: (() => Promise<void>) | null = null;
  private _streamCleanup: (() => Promise<void>) | null = null;
  private _pendingThumbScene: string | null = null;
  private _recordingPage: ScreencastPage | null = null;
  private _navListener: ((frame: { parentFrame: () => unknown }) => void) | null = null;
  private _cdpHandle: CdpScreencastHandle | null = null;

  constructor(sceneDurations?: Record<string, number>) {
    if (sceneDurations) {
      this.sceneDurations = sceneDurations;
    }
  }

  start(): void {
    this.startTime = Date.now();
    this.timings = new Map();
    this.cachedPlacements = null;
  }

  /**
   * Begin screen recording via Playwright 1.59+ `page.screencast.start()`.
   * Call this once setup (login, navigation, theme prep) is done and the
   * "real" demo is about to begin. Re-anchors the timeline clock so the
   * next `mark()` lands at ~0ms — no head-trim heuristic needed downstream.
   *
   * No-op when ARGO_SCREENCAST_PATH is unset (e.g., running standalone in
   * VS Code without the argo pipeline). The fixture wires the env var.
   */
  /** True once `startRecording()` has been called and the screencast is
   *  active. Used by `renderComposition` to decide whether to start the
   *  recording itself (after a composition's warmup) or leave it alone
   *  when the demo started recording earlier for a recorded scene. */
  get isRecording(): boolean {
    return this._screencastStop !== null;
  }

  async startRecording(page: ScreencastPage, options: StartRecordingOptions = {}): Promise<void> {
    const screencastPath = process.env.ARGO_SCREENCAST_PATH;
    if (!screencastPath) {
      // Standalone Playwright run — no recording. Demos still work.
      return;
    }
    if (this._screencastStop) {
      throw new Error('startRecording() already called for this timeline');
    }

    // Pin recording size from env (set by the argo pipeline) when the caller
    // didn't specify — otherwise Playwright's default isn't guaranteed to match
    // the configured viewport (webkit picks 800x450). Caller-passed size wins.
    let size = options.size;
    if (!size) {
      const w = Number(process.env.ARGO_SCREENCAST_WIDTH);
      const h = Number(process.env.ARGO_SCREENCAST_HEIGHT);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        size = { width: w, height: h };
      }
    }

    // Wire the JPEG frame stream when any feature is requested:
    //  - ARGO_LIVE_FRAME_PATH: dashboard / preview live thumbnail
    //  - ARGO_SCENE_THUMBS=1 + ARGO_THUMBS_DIR: per-scene scrubber JPEGs
    //  - ARGO_STREAM_OUT: stream-encode mode — pipe JPEGs directly to ffmpeg
    //    instead of letting Playwright's hardcoded VP8 encoder touch them.
    //    Output is libx264 ultrafast near-lossless mp4; the export pipeline's
    //    second-pass encode handles final quality. This bypasses VP8's tight
    //    bitrate cap (microsoft/playwright#8683 etc.) which causes watercolor
    //    quantization on dark backgrounds at 4K source.
    const liveFramePath = process.env.ARGO_LIVE_FRAME_PATH || '';
    const thumbsDir = process.env.ARGO_SCENE_THUMBS === '0' ? '' : (process.env.ARGO_THUMBS_DIR || '');
    const streamOut = process.env.ARGO_STREAM_OUT || '';
    const streamFps = Number(process.env.ARGO_FPS) || 30;
    // CDP-direct screencast: bypass Playwright's onFrame wrapper to access
    // metadata.timestamp (paint time). Only meaningful with stream-encode
    // (record.ts only sets the env var for chromium + captureMode: jpeg-stitch).
    const useCdpDirect = process.env.ARGO_USE_CDP_DIRECT === '1';

    // Honor ARGO_JPEG_QUALITY for stream-encode mode; caller `options.quality` wins.
    const envQuality = Number(process.env.ARGO_JPEG_QUALITY);
    const quality = options.quality
      ?? (Number.isFinite(envQuality) && envQuality > 0 ? envQuality : undefined);

    if (useCdpDirect && streamOut) {
      // Chromium accepts only one screencast subscriber per target — calling
      // page.screencast.start would supersede our CDP subscription. Skip it
      // entirely. showActions still works because it's a separate Playwright
      // feature that just sets a flag for instrumentation hooks.
      const captureSize = size ?? { width: 1920, height: 1080 };
      const handle = await startCdpScreencast(page as Parameters<typeof startCdpScreencast>[0], {
        outputPath: streamOut,
        size: captureSize,
        quality: quality ?? 80,
        fps: streamFps,
        liveFramePath: liveFramePath || undefined,
        thumbsDir: thumbsDir || undefined,
      });
      this._cdpHandle = handle;
      this._screencastStop = async () => { await handle.stop(); };
    } else {

    // Set up the ffmpeg child for stream-encode mode.
    let ffmpegProc: ChildProcessByStdio<Writable, null, null> | null = null;
    let writeChain: Promise<void> = Promise.resolve();
    let lastJpeg: Buffer | null = null;
    let lastFrameNumber = -1;
    let cdpFrameCount = 0;
    let gapFillCount = 0;
    const recordingStart = Date.now();

    if (streamOut) {
      // libx264 ultrafast: must outpace 4K@30fps in realtime. Slower presets
      // create stdin backpressure that travels back through CDP and starves
      // frames. Final quality comes from the export's second-pass re-encode.
      ffmpegProc = spawn('ffmpeg', [
        '-y',
        '-f', 'image2pipe',
        '-r', String(streamFps),
        '-i', '-',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '12',
        '-pix_fmt', 'yuv420p',
        streamOut,
      ], { stdio: ['pipe', 'ignore', 'ignore'] });

      ffmpegProc.on('error', (err) => {
        console.warn(`Warning: stream-encode ffmpeg error: ${err.message}`);
      });
      ffmpegProc.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          console.warn(`Warning: stream-encode ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
        }
      });
    }

    // Serialize stdin writes through a promise chain that respects backpressure
    // (drain before continuing). Without this, JPEGs can buffer unboundedly in
    // node memory if libx264 falls behind.
    const writeFrame = (data: Buffer): void => {
      const stdin = ffmpegProc?.stdin;
      if (!stdin || stdin.destroyed) return;
      writeChain = writeChain.then(() => new Promise<void>((resolve) => {
        const ok = stdin.write(data, (err) => {
          if (err && !stdin.destroyed) console.warn(`Warning: stream-encode write: ${err.message}`);
        });
        if (ok) resolve();
        else stdin.once('drain', () => resolve());
      }));
    };

    // CDP delivers screencast frames only when the page changes — a static
    // page yields zero frames. To keep wall-clock and video time in lockstep,
    // we gap-fill: at each onFrame, compute the target frame number from
    // elapsed wall time and repeat the last JPEG to cover any missed slots.
    // libx264 compresses identical frames cheaply (B/P at zero motion).
    const fillGapTo = (targetFrame: number): void => {
      while (lastFrameNumber + 1 < targetFrame) {
        if (lastJpeg) writeFrame(lastJpeg);
        lastFrameNumber++;
        gapFillCount++;
      }
    };

    let onFrame: ((frame: { data: Buffer }) => void) | undefined;
    if (liveFramePath || thumbsDir || streamOut) {
      onFrame = ({ data }) => {
        // Best-effort writes — frame stream is high frequency, ignore EAGAIN-style
        // races with readers. JPEG decoders gracefully fail on partial reads.
        if (liveFramePath) {
          try { writeFileSync(liveFramePath, data); } catch { /* ignore */ }
        }
        if (streamOut) {
          const elapsed = Date.now() - recordingStart;
          const targetFrame = Math.floor(elapsed * streamFps / 1000);
          fillGapTo(targetFrame);
          writeFrame(data);
          lastJpeg = data;
          lastFrameNumber = targetFrame;
          cdpFrameCount++;
        }
        if (thumbsDir && this._pendingThumbScene) {
          const scene = this._pendingThumbScene;
          this._pendingThumbScene = null;
          try { writeFileSync(join(thumbsDir, `${scene}.jpg`), data); } catch { /* ignore */ }
        }
      };
    }

    // Playwright's screencast still demands a `path` for its WebM writer even
    // when we ignore that output entirely (stream-encode mode). Pass the path
    // through; for jpeg-stitch users it's a discardable temp file.
    await page.screencast.start({ path: screencastPath, size, quality, onFrame });
    this._screencastStop = () => page.screencast.stop();
    this._recordingPage = page;

    // CDP screencast only emits frames on paint. After page.goto() lands,
    // Chrome can stay paused for the inter-paint window — gap-fill repeats
    // the last (pre-nav) JPEG and the new page doesn't appear in the video
    // until the next natural paint (could be seconds on heavy SPAs). Force
    // a paint right after navigation so CDP unsticks promptly.
    const navListener = (frame: { parentFrame: () => unknown }): void => {
      if (frame.parentFrame() !== null) return; // ignore subframe navs
      this._triggerPaint();
    };
    this._navListener = navListener;
    page.on('framenavigated', navListener);

    // Cleanup hook for stream-encode mode — pads to wall-clock, ends stdin,
    // waits for ffmpeg to flush. Called from _closeRecording().
    if (streamOut && ffmpegProc) {
      const proc = ffmpegProc;
      this._streamCleanup = async () => {
        // Snapshot stats BEFORE the tail pad — that fillGapTo would otherwise
        // inflate gap-fill numbers with legitimate end-of-recording padding.
        const elapsed = Date.now() - recordingStart;
        const inFlightCdpFrames = cdpFrameCount;
        const inFlightGapFills = gapFillCount;

        // Pad final frames so the mp4 duration matches actual recording length
        // (idle pages can leave a multi-second tail with no CDP frames).
        const targetFrame = Math.floor(elapsed * streamFps / 1000);
        fillGapTo(targetFrame);
        await writeChain;
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
        await new Promise<void>((resolve) => {
          if (proc.exitCode !== null) resolve();
          else proc.once('close', () => resolve());
        });

        // Diagnostic: if CDP averaged less than half the requested fps over a
        // recording longer than 5s, throughput was likely the bottleneck.
        // Visuals can lag audio because frame numbers (computed from arrival
        // wallclock) drift past actual paint moments under queue pressure.
        // Hotfix mitigates via lower default JPEG quality at DPR>1; this
        // warning surfaces remaining trouble so users can switch to
        // captureMode: 'webm' or drop deviceScaleFactor to 1.
        const elapsedSec = elapsed / 1000;
        const avgCdpFps = elapsedSec > 0 ? inFlightCdpFrames / elapsedSec : 0;
        if (elapsedSec > 5 && inFlightCdpFrames > 0 && avgCdpFps < streamFps * 0.5) {
          console.warn(
            `Warning: jpeg-stitch sustained ${avgCdpFps.toFixed(1)}fps from CDP over ${elapsedSec.toFixed(1)}s ` +
            `(target ${streamFps}fps; ${inFlightGapFills} of ${inFlightCdpFrames + inFlightGapFills} frames synthesized). ` +
            `CDP transport may be under-running — visuals could lag audio. ` +
            `Consider captureMode: 'webm', deviceScaleFactor: 1, or a lower jpegQuality.`,
          );
        }
      };
    }

    } // close legacy `else` branch — showActions + timeline anchor below run for both paths.

    // Optional auto-annotation of every Playwright interaction.
    const showActionsEnv = process.env.ARGO_SHOW_ACTIONS;
    if (showActionsEnv) {
      try {
        const opts = JSON.parse(showActionsEnv) as Parameters<typeof page.screencast.showActions>[0];
        await page.screencast.showActions(opts);
      } catch (err) {
        console.warn(`Warning: page.screencast.showActions failed: ${(err as Error).message}`);
      }
    }

    // Re-anchor the timeline so timestamps align with the video, not the test start.
    this.startTime = Date.now();
    this.timings = new Map();
    this.cachedPlacements = null;
    this._pendingThumbScene = null;
  }

  /**
   * Stop the active screencast, if any. Called by the test fixture in its
   * finally block. Swallows errors after warning — recording stop is
   * best-effort, the file is already on disk by the time we get here.
   */
  async _closeRecording(): Promise<void> {
    const stop = this._screencastStop;
    if (!stop) return;
    this._screencastStop = null;
    const cleanup = this._streamCleanup;
    this._streamCleanup = null;

    // Detach the framenavigated listener so a reused page (e.g., across
    // tests in the same worker) doesn't keep nudging paints after teardown.
    const navListener = this._navListener;
    const recPage = this._recordingPage;
    if (navListener && recPage) {
      try { recPage.off('framenavigated', navListener); } catch { /* best-effort */ }
    }
    this._navListener = null;
    this._recordingPage = null;

    // Stop CDP screencast first so no more frames arrive after we've sealed
    // the stream-encode pipeline. Then pad/flush ffmpeg and wait for it to
    // close — order matters: we want the full set of CDP frames in the mp4.
    const errors: string[] = [];
    try {
      await stop();
    } catch (err) {
      const message = `failed to stop screencast: ${(err as Error).message}`;
      console.warn(`Warning: ${message}`);
      errors.push(message);
    }
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        const message = `failed to finalize stream-encode: ${(err as Error).message}`;
        console.warn(`Warning: ${message}`);
        errors.push(message);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Recording teardown failed: ${errors.join('; ')}`);
    }
  }

  /**
   * Mutate a no-op `data-argo-paint` attribute on the documentElement to
   * force Chrome's compositor to schedule a paint. CDP screencast then emits
   * a fresh frame containing the current visual state. Fire-and-forget — the
   * eval can race page disposal during teardown; we silently ignore those.
   */
  private _triggerPaint(): void {
    const page = this._recordingPage;
    if (!page) return;
    page.evaluate(() => {
      // performance.now() is monotonic and unique enough to guarantee the
      // attribute value actually changes (Chrome optimizes out same-value sets).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (document.documentElement as any).dataset.argoPaint = String(performance.now());
    }).catch(() => { /* page disposed during teardown — best-effort */ });
  }

  mark(scene: string): void {
    if (this.startTime === null) {
      throw new Error('Cannot mark before start() has been called');
    }
    if (this.timings.has(scene)) {
      throw new Error(`Duplicate scene name: "${scene}"`);
    }
    const ms = Date.now() - this.startTime;
    this.timings.set(scene, ms);
    this.cachedPlacements = null;

    // Tell the next onFrame callback to also persist this scene's JPEG —
    // best-effort, gated on ARGO_THUMBS_DIR being set + screencast being live.
    this._pendingThumbScene = scene;
    if (this._cdpHandle) this._cdpHandle.setPendingThumb(scene);

    // Force CDP to emit a fresh frame so this scene's visual state is in the
    // recording at mark-time. Without this, an idle page (no recent paint)
    // can leave the previous scene's JPEG as the gap-fill source until the
    // next natural paint — which can be hundreds of ms later, enough for
    // visuals to lag audio noticeably.
    this._triggerPaint();

    // Append to JSONL progress file for live scene status in the parent process
    const progressPath = process.env.ARGO_PROGRESS_PATH;
    if (progressPath) {
      try {
        appendFileSync(progressPath, JSON.stringify({ scene, ms }) + '\n');
      } catch {
        // Best-effort — don't fail recording over progress reporting
      }
    }
  }

  /**
   * Record a camera move (zoom/pan) to be applied as an ffmpeg post-export effect.
   * Call this during recording with the target element's bounding box.
   */
  recordCameraMove(move: Omit<CameraMove, 'startMs'> & { startMs?: number }): void {
    if (this.startTime === null) {
      throw new Error('Cannot record camera move before start() has been called');
    }
    const startMs = move.startMs ?? (Date.now() - this.startTime);
    this._cameraMoves.push({ ...move, startMs });
  }

  getCameraMoves(): CameraMove[] {
    return [...this._cameraMoves];
  }

  /**
   * Record a cursor position sample for dwell-based camera suggestions.
   * Coordinates should be normalized to 0..1 of the viewport.
   */
  recordCursorPosition(cx: number, cy: number): void {
    if (this.startTime === null) return;
    this._cursorTelemetry.push({
      cx,
      cy,
      timeMs: Date.now() - this.startTime,
    });
  }

  getCursorTelemetry(): CursorSample[] {
    return [...this._cursorTelemetry];
  }

  getTimings(): Record<string, number> {
    return Object.fromEntries(this.timings);
  }

  async flush(outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(this.getTimings(), null, 2), 'utf-8');

    // Write camera moves to a sidecar file if any were recorded
    if (this._cameraMoves.length > 0) {
      const cameraMovesPath = outputPath.replace(/\.json$/, '') + '.camera-moves.json';
      await writeFile(cameraMovesPath, JSON.stringify(this._cameraMoves, null, 2), 'utf-8');
    }

    // Write cursor telemetry for dwell-based camera suggestions
    if (this._cursorTelemetry.length > 0) {
      const cursorPath = outputPath.replace(/\.json$/, '') + '.cursor-telemetry.json';
      await writeFile(cursorPath, JSON.stringify(this._cursorTelemetry), 'utf-8');
    }
  }

  private getBaseDuration(scene: string, options?: SceneDurationOptions): number {
    const clipMs = this.sceneDurations[scene];
    const fallback = options?.fallbackMs ?? 5000;
    if (clipMs === undefined) {
      if (!this._fallbackWarned && Object.keys(this.sceneDurations).length === 0) {
        this._fallbackWarned = true;
        console.warn(
          `Warning: scene durations not loaded — using ${fallback}ms fallback for "${scene}" (and subsequent scenes). ` +
          `Run 'argo pipeline' for TTS-synced durations, or 'argo tts generate' first.`,
        );
      }
      return fallback;
    }

    const raw = clipMs * (options?.multiplier ?? 1)
      + (options?.leadInMs ?? 200)
      + (options?.leadOutMs ?? 400);

    const min = options?.minMs ?? 2200;
    const max = options?.maxMs ?? 30000;
    return Math.max(min, Math.min(max, raw));
  }

  private getPlacements(): Placement[] {
    if (this.cachedPlacements) return this.cachedPlacements;

    const scheduledScenes = Array.from(this.timings.entries())
      .filter(([name]) => this.sceneDurations[name] !== undefined)
      .map(([name, startMs]) => ({
        scene: name,
        startMs,
        durationMs: this.sceneDurations[name],
      }));

    this.cachedPlacements = schedulePlacements(scheduledScenes);
    return this.cachedPlacements;
  }

  /**
   * Compute a hold duration for a scene based on its TTS clip length.
   * Use for overlay durations and passive reading time — not for
   * page loads, click completion, or selector readiness.
   *
   * When the scene has already been marked, this returns the remaining wait
   * from "now", not the full scene duration. It also accounts for any audio
   * backlog caused by earlier clips running long.
   */
  durationFor(scene: string, options?: SceneDurationOptions): number {
    const baseDurationMs = this.getBaseDuration(scene, options);
    if (this.startTime === null) return baseDurationMs;

    const markMs = this.timings.get(scene);
    if (markMs === undefined) return baseDurationMs;

    const placement = this.getPlacements().find((p) => p.scene === scene);
    if (!placement) return baseDurationMs;

    const leadOutMs = options?.leadOutMs ?? 400;
    const desiredEndMs = Math.max(
      markMs + baseDurationMs,
      placement.endMs + leadOutMs,
    );
    const nowMs = Math.max(0, Date.now() - this.startTime);

    return Math.max(0, Math.ceil(desiredEndMs - nowMs));
  }

  /**
   * Return the full scene duration based on TTS clip length — NOT time-aware.
   * Unlike `durationFor()` which subtracts elapsed time, this always returns
   * the same value regardless of when it's called. Use for overlay display
   * durations and anywhere you need a stable, non-decreasing value.
   */
  sceneDuration(scene: string, options?: SceneDurationOptions): number {
    return this.getBaseDuration(scene, options);
  }

  /**
   * Return scene-relative per-word timestamps for `scene` (first word
   * starts near 0). Loaded from the transcript sidecar pointed to by
   * `ARGO_TRANSCRIPT_PATH` (the pipeline sets this to the scene-keyed
   * file after TTS+transcription). Empty array if transcription is
   * disabled or the file is missing — treat word timing as an
   * enhancement, not a precondition.
   *
   * Use this during recording to schedule effects on specific words:
   *
   *   for (const w of narration.wordTiming('hero')) {
   *     setTimeout(() => focusRing(page, '#x'), w.start * 1000);
   *   }
   *
   * For absolute (recording-aligned) timestamps over the whole video,
   * post-pipeline consumers should read `.argo/&lt;demo&gt;/narration.transcript.json`
   * directly — that file is written after alignment with placement
   * offsets folded in.
   */
  wordTiming(scene: string): WordTiming[] {
    const transcript = loadTranscript();
    const words = transcript?.scenes[scene];
    return words ? words.map((w) => ({ ...w })) : [];
  }

  /**
   * Return how many milliseconds remain (from "now") until `target`
   * is spoken inside `scene`. Useful for syncing visual effects to
   * specific words instead of dividing a scene into even beats:
   *
   *   narration.mark('voiceover');
   *   const t = narration.atWord('voiceover', 'Kokoro');
   *   if (t !== null) await page.waitForTimeout(t);
   *   dimAround(page, '#engine-kokoro', { duration: 800 });
   *
   * Matching is case-insensitive and ignores trailing punctuation
   * (Whisper preserves periods/commas attached to words). Returns
   * the FIRST occurrence after `options.afterMs` (default 0). If the
   * target word has already been spoken — or the transcript is
   * missing, the word isn't found, or the scene hasn't been marked —
   * returns null. Callers should fall back to even-beat scheduling.
   */
  atWord(
    scene: string,
    target: string,
    options?: { afterMs?: number; occurrence?: number },
  ): number | null {
    if (this.startTime === null) return null;
    const markMs = this.timings.get(scene);
    if (markMs === undefined) return null;

    const words = this.wordTiming(scene);
    if (words.length === 0) return null;

    const normalized = target.toLowerCase().replace(/[^\w']/g, '');
    const wantedOccurrence = options?.occurrence ?? 1;
    const afterMs = options?.afterMs ?? 0;

    let seen = 0;
    for (const w of words) {
      const wMs = w.start * 1000;
      if (wMs < afterMs) continue;
      const norm = w.text.toLowerCase().replace(/[^\w']/g, '');
      if (norm !== normalized) continue;
      seen++;
      if (seen < wantedOccurrence) continue;

      const elapsedInSceneMs = (Date.now() - this.startTime) - markMs;
      const remaining = wMs - elapsedInSceneMs;
      // Negative means we missed it — return null so the caller can
      // skip the cue rather than firing late.
      return remaining > 0 ? Math.ceil(remaining) : null;
    }
    return null;
  }
}

export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

interface AggregateTranscript {
  version: number;
  model: string;
  language?: string;
  scenes: Record<string, WordTiming[]>;
}

let cachedTranscript: AggregateTranscript | null | undefined = undefined;

/** Lazily load + cache the aggregate transcript file referenced by
 *  `ARGO_TRANSCRIPT_PATH`. Cached per process so repeated lookups across
 *  scenes pay one filesystem read. Returns null if the env var is unset
 *  or the file is missing/malformed (transcription is opt-in). */
function loadTranscript(): AggregateTranscript | null {
  if (cachedTranscript !== undefined) return cachedTranscript;
  const path = process.env.ARGO_TRANSCRIPT_PATH;
  if (!path) {
    cachedTranscript = null;
    return null;
  }
  try {
    if (!existsSync(path)) {
      cachedTranscript = null;
      return null;
    }
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as AggregateTranscript;
    cachedTranscript = parsed;
    return parsed;
  } catch (err) {
    console.warn(
      `Warning: failed to load transcript from ${path}: ${(err as Error).message}. ` +
      `Continuing without word timings.`
    );
    cachedTranscript = null;
    return null;
  }
}
