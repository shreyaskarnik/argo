import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Structural subset of `BrowserContext.newCDPSession()` and the resulting
 * `CDPSession` we depend on. Avoids pulling `@playwright/test` types into
 * this module's runtime dependencies.
 */
interface CdpPage {
  context(): { newCDPSession(page: CdpPage): Promise<CdpSession> };
}

interface CdpSession {
  on(event: 'Page.screencastFrame', listener: (payload: ScreencastFramePayload) => void): unknown;
  off(event: 'Page.screencastFrame', listener: (payload: ScreencastFramePayload) => void): unknown;
  send(method: 'Page.startScreencast', params: StartScreencastParams): Promise<unknown>;
  send(method: 'Page.stopScreencast'): Promise<unknown>;
  send(method: 'Page.screencastFrameAck', params: { sessionId: number }): Promise<unknown>;
  detach(): Promise<unknown>;
}

interface ScreencastFramePayload {
  /** Base64-encoded JPEG. */
  data: string;
  metadata: {
    /** Frame swap timestamp in seconds since epoch (Network.TimeSinceEpoch). Optional in CDP, populated in chromium. */
    timestamp?: number;
    deviceWidth: number;
    deviceHeight: number;
  };
  sessionId: number;
}

interface StartScreencastParams {
  format?: 'jpeg' | 'png';
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

export interface CdpScreencastOptions {
  /** Final stitched mp4 output path. */
  outputPath: string;
  /** Capture size — passed to CDP as maxWidth/maxHeight. */
  size: { width: number; height: number };
  /** JPEG quality 0-100. */
  quality: number;
  /** Output framerate hint for ffmpeg encode. Concat demuxer drives PTS from per-file durations; this is just metadata. */
  fps: number;
  /** Optional: write every captured JPEG to this path for live preview thumbnails. */
  liveFramePath?: string;
  /** Optional: per-scene thumb directory. Tag a scene via `setPendingThumb()`. */
  thumbsDir?: string;
}

export interface CdpScreencastHandle {
  /** Tag the next captured JPEG as the thumbnail for this scene. */
  setPendingThumb(scene: string): void;
  /**
   * Stop the screencast, flush remaining frames, run ffmpeg with concat
   * demuxer to produce `outputPath`, return when ffmpeg has exited.
   */
  stop(): Promise<void>;
  /** Number of frames CDP delivered (excludes any synthesized padding). */
  frameCount(): number;
}

/**
 * Build concat-demuxer lines from an ordered list of frames with paint
 * timestamps. Exported for tests.
 *
 * The concat demuxer reads:
 *   file 'frame-0000000.jpg'
 *   duration 0.0333
 *   file 'frame-0000001.jpg'
 *   duration 0.0286
 *   ...
 *   file 'frame-NNNNNNN.jpg'  ← final entry repeated, see below
 *
 * Each `duration` applies to the file that PRECEDES it. The final file's
 * duration is given by the trailing entry — and concat requires the last
 * file line to be repeated AFTER its duration so the duration is applied
 * (otherwise ffmpeg uses the file's intrinsic duration, which for a JPEG
 * is "1 frame at 25fps" = 40ms).
 */
export function buildConcatLines(
  frames: ReadonlyArray<{ filename: string; paintTimestampSec: number }>,
  fallbackFps: number,
): string[] {
  if (frames.length === 0) return [];
  const lines: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    lines.push(`file '${frames[i].filename}'`);
    let duration: number;
    if (i + 1 < frames.length) {
      duration = frames[i + 1].paintTimestampSec - frames[i].paintTimestampSec;
    } else {
      // Last frame — use the average of the prior frame intervals if we
      // have them, else fall back to 1/fps. Keeps the trailing hold sane.
      duration = frames.length > 1
        ? (frames[frames.length - 1].paintTimestampSec - frames[0].paintTimestampSec) / (frames.length - 1)
        : 1 / fallbackFps;
    }
    // Clamp to a sane range — clock weirdness or first-frame zero deltas
    // would otherwise break ffmpeg's PTS math.
    if (!Number.isFinite(duration) || duration <= 0) duration = 1 / fallbackFps;
    if (duration > 60) duration = 60;
    lines.push(`duration ${duration.toFixed(6)}`);
  }
  // Repeat the last file line so concat applies its duration. Without this
  // the trailing duration is silently ignored.
  lines.push(`file '${frames[frames.length - 1].filename}'`);
  return lines;
}

/**
 * Begin a CDP-direct screencast. Bypasses Playwright's `page.screencast.start`
 * so we own the `Page.screencastFrame` events end-to-end. Each event carries
 * `metadata.timestamp` — the actual paint time on Chrome's clock — which lets
 * us timestamp frames by paint, not by Node-side arrival wallclock. This is
 * the only way to keep visuals aligned with audio when CDP transport can't
 * sustain wallclock pace at high resolutions.
 *
 * Frames are written to disk under `<outputDir>/cdp-frames/`, then stitched
 * into the final mp4 via ffmpeg's concat demuxer with per-frame durations
 * derived from paint-timestamp deltas. Disk buffering trades ~5MB/s of I/O
 * for VFR output that doesn't depend on wallclock at all.
 *
 * Caller MUST NOT also call `page.screencast.start()` — Chromium accepts only
 * one screencast subscriber per target; the second supersedes the first.
 * `page.screencast.showActions()` is independent and stays usable.
 */
export async function startCdpScreencast(
  page: CdpPage,
  options: CdpScreencastOptions,
): Promise<CdpScreencastHandle> {
  const framesDir = join(dirname(options.outputPath), 'cdp-frames');
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const cdp = await page.context().newCDPSession(page);
  const frames: { filename: string; paintTimestampSec: number }[] = [];
  let pendingThumb: string | null = null;

  const handler = (payload: ScreencastFramePayload): void => {
    const { data, metadata, sessionId } = payload;
    // Ack first so Chrome's next paint isn't held by our I/O.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {
      // Detach races stop() — silent.
    });

    let buffer: Buffer;
    try {
      buffer = Buffer.from(data, 'base64');
    } catch {
      return;
    }

    // metadata.timestamp is optional in CDP. When absent, fall back to
    // Date.now() — better than dropping the frame, and chromium populates
    // it in practice.
    const tsSec = typeof metadata.timestamp === 'number'
      ? metadata.timestamp
      : Date.now() / 1000;

    const filename = `frame-${String(frames.length).padStart(7, '0')}.jpg`;
    try {
      writeFileSync(join(framesDir, filename), buffer);
    } catch (err) {
      console.warn(`Warning: cdp-screencast: failed to write ${filename}: ${(err as Error).message}`);
      return;
    }
    frames.push({ filename, paintTimestampSec: tsSec });

    if (options.liveFramePath) {
      try { writeFileSync(options.liveFramePath, buffer); } catch { /* best-effort */ }
    }
    if (pendingThumb && options.thumbsDir) {
      const scene = pendingThumb;
      pendingThumb = null;
      try { writeFileSync(join(options.thumbsDir, `${scene}.jpg`), buffer); } catch { /* best-effort */ }
    }
  };

  cdp.on('Page.screencastFrame', handler);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: options.quality,
    maxWidth: options.size.width,
    maxHeight: options.size.height,
    everyNthFrame: 1,
  });

  return {
    frameCount() { return frames.length; },
    setPendingThumb(scene) { pendingThumb = scene; },
    async stop() {
      cdp.off('Page.screencastFrame', handler);
      try { await cdp.send('Page.stopScreencast'); } catch { /* page may have closed */ }
      try { await cdp.detach(); } catch { /* best-effort */ }

      if (frames.length === 0) {
        console.warn('Warning: cdp-screencast: no frames captured — output mp4 not created.');
        return;
      }

      const concatPath = join(framesDir, 'concat.txt');
      const lines = buildConcatLines(frames, options.fps);
      writeFileSync(concatPath, lines.join('\n') + '\n', 'utf-8');

      await new Promise<void>((resolve, reject) => {
        // -vf fps=N forces CFR output. Without it, the concat-demuxer produces
        // VFR with avg_frame_rate well below the declared r_frame_rate, which
        // confuses downstream filter graphs (e.g. shader-splice trims): the
        // final mp4 ends up several seconds longer than the source.
        const proc = spawn('ffmpeg', [
          '-y',
          '-f', 'concat',
          '-safe', '0',
          '-i', concatPath,
          '-vf', `fps=${options.fps}`,
          '-fps_mode', 'cfr',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '12',
          '-pix_fmt', 'yuv420p',
          options.outputPath,
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`cdp-screencast: ffmpeg concat exited ${code}: ${stderr.slice(-2000)}`));
        });
      });

      // Free disk — JPEGs are only useful for the encode pass.
      rmSync(framesDir, { recursive: true, force: true });
    },
  };
}
