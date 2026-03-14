import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ExportOptions {
  demoName: string;
  argoDir: string;
  outputDir: string;
  preset?: string;
  crf?: number;
  fps?: number;
  tailPadMs?: number;
  /** Logical output width (e.g. 1920). Used with deviceScaleFactor for downscaling. */
  outputWidth?: number;
  /** Logical output height (e.g. 1080). Used with deviceScaleFactor for downscaling. */
  outputHeight?: number;
  /** When > 1, recording was captured at scaled resolution and needs lanczos downscale. */
  deviceScaleFactor?: number;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(3).replace(/\.?0+$/, '');
}

/**
 * Check whether ffmpeg is available on the system PATH.
 * Returns true if found, throws with install instructions otherwise.
 */
export function checkFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    return true;
  } catch {
    throw new Error(
      'ffmpeg is not installed. Install it with:\n' +
        '  macOS:   brew install ffmpeg\n' +
        '  Linux:   apt install ffmpeg\n' +
        '  Windows: choco install ffmpeg',
    );
  }
}

/**
 * Export a demo to MP4 by combining the screen recording with aligned narration audio.
 */
export async function exportVideo(options: ExportOptions): Promise<string> {
  const {
    demoName,
    argoDir,
    outputDir,
    preset = 'slow',
    crf = 16,
    fps,
    tailPadMs,
    outputWidth,
    outputHeight,
    deviceScaleFactor = 1,
  } = options;

  checkFfmpeg();

  const demoDir = join(argoDir, demoName);
  const videoPath = join(demoDir, 'video.webm');
  const audioPath = join(demoDir, 'narration-aligned.wav');

  if (!existsSync(videoPath)) {
    throw new Error(`Missing video.webm at ${videoPath}`);
  }
  if (!existsSync(audioPath)) {
    throw new Error(`Missing narration-aligned.wav at ${audioPath}`);
  }

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = join(outputDir, `${demoName}.mp4`);

  const args: string[] = [
    '-i', videoPath,
    '-i', audioPath,
  ];

  // Build video filter chain
  const vFilters: string[] = [];
  if (tailPadMs && tailPadMs > 0) {
    vFilters.push(`tpad=stop_mode=clone:stop_duration=${formatSeconds(tailPadMs)}`);
  }
  if (deviceScaleFactor > 1 && outputWidth && outputHeight) {
    vFilters.push(`scale=${outputWidth}:${outputHeight}:flags=lanczos`);
  }
  if (vFilters.length > 0) {
    args.push('-vf', vFilters.join(','));
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-c:a', 'aac',
    '-b:a', '192k',
  );

  if (fps !== undefined) {
    args.push('-r', String(fps));
  }

  args.push('-shortest', '-y', outputPath);

  const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });

  if (result.error) {
    throw new Error(`Failed to launch ffmpeg: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`ffmpeg was killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed with exit code ${result.status}`);
  }

  return outputPath;
}
