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
  /** Trim this many ms from the start of the video (skip setup before first scene). */
  headTrimMs?: number;
  tailPadMs?: number;
  /** Logical output width (e.g. 1920). Used with deviceScaleFactor for downscaling. */
  outputWidth?: number;
  /** Logical output height (e.g. 1080). Used with deviceScaleFactor for downscaling. */
  outputHeight?: number;
  /** When > 1, recording was captured at scaled resolution and needs lanczos downscale. */
  deviceScaleFactor?: number;
  /** Optional path to a PNG image to embed as the MP4 thumbnail (cover art). */
  thumbnailPath?: string;
  /** Optional path to ffmpeg chapter metadata file for MP4 chapter markers. */
  chapterMetadataPath?: string;
  /** Additional aspect ratios to export alongside the main 16:9. */
  formats?: Array<'1:1' | '9:16'>;
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
    thumbnailPath,
    chapterMetadataPath,
  } = options;

  checkFfmpeg();

  const demoDir = join(argoDir, demoName);
  const videoPath = join(demoDir, 'video.webm');
  const audioPath = join(demoDir, 'narration-aligned.wav');

  if (!existsSync(videoPath)) {
    throw new Error(`Missing video.webm at ${videoPath}`);
  }
  const hasAudio = existsSync(audioPath);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = join(outputDir, `${demoName}.mp4`);

  if (thumbnailPath && !existsSync(thumbnailPath)) {
    console.warn(
      `Warning: configured thumbnailPath "${thumbnailPath}" does not exist. ` +
      `The video will be exported without a thumbnail.`
    );
  }
  const hasThumbnail = thumbnailPath && existsSync(thumbnailPath);

  const headTrimMs = options.headTrimMs ?? 0;
  const headTrimSec = headTrimMs > 0 ? (headTrimMs / 1000).toFixed(3) : '';

  const args: string[] = [];

  // Trim setup/teardown by seeking both inputs to the first scene mark
  if (headTrimSec) args.push('-ss', headTrimSec);
  args.push('-i', videoPath);   // input 0: video
  if (hasAudio) {
    if (headTrimSec) args.push('-ss', headTrimSec);
    args.push('-i', audioPath); // input 1: audio (omitted for silent videos)
  }

  let nextInput = hasAudio ? 2 : 1;
  const hasChapters = chapterMetadataPath && existsSync(chapterMetadataPath);
  let chapterInputIdx = -1;
  if (hasChapters) {
    chapterInputIdx = nextInput++;
    args.push('-i', chapterMetadataPath);
  }

  let thumbInputIdx = -1;
  if (hasThumbnail) {
    thumbInputIdx = nextInput++;
    args.push('-i', thumbnailPath);
  }

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
  );
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  if (fps !== undefined) {
    args.push('-r', String(fps));
  }

  if (hasChapters) {
    args.push('-map_metadata', String(chapterInputIdx));
  }

  if (hasThumbnail) {
    // Map video, audio (if present), and thumbnail streams explicitly
    args.push('-map', '0:v');
    if (hasAudio) args.push('-map', '1:a');
    args.push('-map', `${thumbInputIdx}:v`);
    // Encode thumbnail stream as PNG attached picture
    args.push('-c:v:1', 'png', '-disposition:v:1', 'attached_pic');
    // Skip -shortest: the PNG has 0 duration and would truncate the whole output.
  } else if (hasAudio) {
    args.push('-shortest');
  }

  args.push('-y', outputPath);

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

  // Export additional aspect ratios by cropping from the main 16:9 output
  const formats = options.formats ?? [];
  for (const format of formats) {
    const suffix = format.replace(':', 'x');
    const formatPath = outputPath.replace(/\.mp4$/, `.${suffix}.mp4`);

    // Compute crop dimensions from 16:9 source
    const srcW = outputWidth ?? 1920;
    const srcH = outputHeight ?? 1080;
    let cropW: number, cropH: number;

    if (format === '1:1') {
      // Square: crop to height × height, centered horizontally
      cropW = srcH;
      cropH = srcH;
    } else {
      // 9:16 vertical: crop to (height × 9/16) × height, centered
      cropW = Math.round(srcH * 9 / 16);
      cropH = srcH;
    }

    const cropX = Math.round((srcW - cropW) / 2);
    const cropY = 0;

    const formatArgs = [
      '-i', outputPath,
      '-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
      '-c:v', 'libx264',
      '-preset', preset,
      '-crf', String(crf),
      '-c:a', 'copy',
      '-y', formatPath,
    ];

    const fmtResult = spawnSync('ffmpeg', formatArgs, { stdio: 'inherit' });
    if (fmtResult.status !== 0) {
      console.warn(`Warning: failed to export ${format} format to ${formatPath}`);
    }
  }

  return outputPath;
}
