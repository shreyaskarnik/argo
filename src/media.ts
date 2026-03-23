import { execFileSync, spawnSync } from 'node:child_process';
import type { BackgroundTheme } from './overlays/zones.js';

export function getVideoDurationMs(videoPath: string): number {
  let raw: string;
  try {
    raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { encoding: 'utf-8' },
    ).trim();
  } catch (err) {
    throw new Error(
      `Failed to get video duration from ${videoPath}. ` +
      `Ensure ffprobe is installed (it usually comes with ffmpeg). ` +
      `Original error: ${(err as Error).message}`,
    );
  }

  const durationMs = Math.round(parseFloat(raw) * 1000);
  if (isNaN(durationMs) || durationMs <= 0) {
    throw new Error(
      `ffprobe returned invalid duration "${raw}" for ${videoPath}. The video file may be corrupt.`,
    );
  }

  return durationMs;
}

export function getVideoFrameRate(videoPath: string): number {
  let raw: string;
  try {
    raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', videoPath],
      { encoding: 'utf-8' },
    ).trim();
  } catch (err) {
    throw new Error(
      `Failed to get video frame rate from ${videoPath}. ` +
      `Ensure ffprobe is installed (it usually comes with ffmpeg). ` +
      `Original error: ${(err as Error).message}`,
    );
  }

  if (!raw || raw === '0/0') {
    throw new Error(`ffprobe returned invalid frame rate "${raw}" for ${videoPath}.`);
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  const fps = match ? Number(match[1]) / Number(match[2]) : Number(raw);
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`ffprobe returned invalid frame rate "${raw}" for ${videoPath}.`);
  }

  return fps;
}

/**
 * Compute average luminance of a single video frame at the given timestamp.
 * Returns a value 0–255 or null on failure.
 */
function frameLuminance(videoPath: string, timestampMs: number): number | null {
  try {
    const ss = (timestampMs / 1000).toFixed(3);
    const result = spawnSync('ffmpeg', [
      '-ss', ss,
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=64:36',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 36 * 3 + 1024 });

    // ffmpeg may return non-zero even when stdout has valid frame data (e.g., codec warnings)
    if (!result.stdout || result.stdout.length < 3) {
      return null;
    }

    const pixels = result.stdout as Buffer;
    let totalLuminance = 0;
    const pixelCount = Math.floor(pixels.length / 3);
    for (let i = 0; i < pixelCount; i++) {
      const r = pixels[i * 3];
      const g = pixels[i * 3 + 1];
      const b = pixels[i * 3 + 2];
      totalLuminance += 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return totalLuminance / pixelCount;
  } catch {
    return null;
  }
}

/**
 * Detect whether a video region is predominantly dark or light.
 * Samples multiple frames across the given time range for robustness
 * (a single frame might be a transition or black screen).
 *
 * Returns the *overlay* theme for contrast: dark video → 'light' overlay,
 * light video → 'dark' overlay. Falls back to 'dark' on error.
 */
export function detectVideoTheme(
  videoPath: string,
  startMs = 0,
  endMs?: number,
): BackgroundTheme {
  // Sample up to 5 frames spread across the range; if no endMs, sample around startMs
  const sampleCount = 5;
  const timestamps: number[] = [];
  if (endMs !== undefined && endMs > startMs) {
    const step = (endMs - startMs) / (sampleCount + 1);
    for (let i = 1; i <= sampleCount; i++) {
      timestamps.push(Math.round(startMs + step * i));
    }
  } else {
    // Single point — sample at start plus small offsets
    timestamps.push(startMs);
    if (startMs > 500) timestamps.push(startMs - 500);
    timestamps.push(startMs + 500);
  }

  const luminances: number[] = [];
  for (const ts of timestamps) {
    const lum = frameLuminance(videoPath, Math.max(0, ts));
    if (lum !== null) luminances.push(lum);
  }

  if (luminances.length === 0) return 'dark';

  const avgLuminance = luminances.reduce((a, b) => a + b, 0) / luminances.length;
  return avgLuminance < 128 ? 'light' : 'dark';
}

/**
 * Probe video dimensions (width × height) using ffprobe.
 * Returns { width, height } or null on failure.
 */
export function getVideoDimensions(videoPath: string): { width: number; height: number } | null {
  try {
    const raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0',
       '-show_entries', 'stream=width,height',
       '-of', 'csv=p=0:s=x', videoPath],
      { encoding: 'utf-8' },
    ).trim();
    const match = raw.match(/^(\d+)x(\d+)$/);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}
