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
 * Detect whether a video frame is predominantly dark or light.
 * Extracts a single frame at the given timestamp using ffmpeg, reads raw
 * RGB pixel data, and computes average luminance.
 *
 * Returns the *overlay* theme for contrast: dark video → 'light' overlay,
 * light video → 'dark' overlay. Falls back to 'dark' on error.
 */
export function detectVideoTheme(
  videoPath: string,
  timestampMs = 0,
): BackgroundTheme {
  try {
    const ss = (timestampMs / 1000).toFixed(3);
    // Extract a single frame as raw RGB, scaled down for fast analysis
    const result = spawnSync('ffmpeg', [
      '-ss', ss,
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=64:36',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 36 * 3 + 1024 });

    if (result.status !== 0 || !result.stdout || result.stdout.length < 3) {
      return 'dark'; // fallback
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
    const avgLuminance = totalLuminance / pixelCount;

    // Dark background → light overlay, light background → dark overlay
    return avgLuminance < 128 ? 'light' : 'dark';
  } catch {
    return 'dark'; // safe fallback
  }
}
