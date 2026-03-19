import { execFileSync } from 'node:child_process';

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
