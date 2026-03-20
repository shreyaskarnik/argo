import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Placement } from './tts/align.js';
import type { TransitionConfig } from './config.js';
import { buildTransitionFilters } from './transitions.js';
import { runFfmpegWithProgress } from './progress.js';
import { buildSpeedRampFilter, type Segment } from './speed-ramp.js';
import { buildCameraMoveFilter, type CameraMove } from './camera-move.js';
import { getVideoFrameRate } from './media.js';

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
  /** Additional formats to export alongside the main 16:9. */
  formats?: Array<'1:1' | '9:16' | 'gif'>;
  /** Scene transition config for inter-scene transitions. */
  transition?: TransitionConfig;
  /** Scene placements — needed for transitions. */
  placements?: Placement[];
  /** Estimated total duration in ms — used for progress bar. */
  totalDurationMs?: number;
  /** Precomputed speed-ramp segments on the post-trim timeline. */
  speedRampSegments?: Segment[];
  /** Apply EBU R128 loudness normalization to audio. */
  loudnorm?: boolean;
  /** Path to a background music file to mix under narration. */
  musicPath?: string;
  /** Music volume when narration is NOT playing (0.0 to 1.0). Default: 0.15 */
  musicVolume?: number;
  /** Music volume when narration IS playing (0.0 to 1.0). Default: 0.05 */
  duckVolume?: number;
  /** Post-export camera moves (zoom/pan) recorded during Playwright session. */
  cameraMoves?: CameraMove[];
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
 * Export an MP4 to animated GIF with palette optimization.
 */
async function exportGif(
  mp4Path: string,
  gifPath: string,
  fps = 10,
  width = 640,
): Promise<void> {
  // Two-pass approach: generate palette first, then use it for high-quality GIF
  const palettePath = mp4Path.replace(/\.mp4$/, '.palette.png');

  const paletteArgs = [
    '-i', mp4Path,
    '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`,
    '-y', palettePath,
  ];

  const paletteResult = spawnSync('ffmpeg', paletteArgs, { stdio: 'pipe' });
  if (paletteResult.status !== 0) {
    console.warn('Warning: GIF palette generation failed, using single-pass fallback');
    // Single-pass fallback
    const fallbackArgs = [
      '-i', mp4Path,
      '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos`,
      '-y', gifPath,
    ];
    const fbResult = spawnSync('ffmpeg', fallbackArgs, { stdio: 'inherit' });
    if (fbResult.status !== 0) {
      console.warn(`Warning: GIF export failed`);
    }
    return;
  }

  const gifArgs = [
    '-i', mp4Path,
    '-i', palettePath,
    '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    '-y', gifPath,
  ];

  const gifResult = spawnSync('ffmpeg', gifArgs, { stdio: 'pipe' });
  if (gifResult.status !== 0) {
    console.warn(`Warning: GIF export failed`);
  }

  // Clean up palette
  try {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(palettePath);
  } catch { /* ignore */ }
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
    transition,
    placements,
    totalDurationMs,
    speedRampSegments,
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

  // Background music input
  const musicPath = options.musicPath;
  const hasMusic = musicPath && existsSync(musicPath);
  let musicInputIdx = -1;
  if (musicPath && !existsSync(musicPath)) {
    console.warn(
      `Warning: configured music path "${musicPath}" does not exist. ` +
      `The video will be exported without background music.`
    );
  }
  if (hasMusic) {
    musicInputIdx = nextInput++;
    args.push('-stream_loop', '-1', '-i', musicPath);
  }

  // Build video filter chain
  const filterParts: string[] = [];
  let videoSource = '0:v';
  let audioSource = hasAudio ? '1:a' : undefined;

  const speedRampFilter = speedRampSegments && speedRampSegments.length > 0
    ? buildSpeedRampFilter(speedRampSegments, { video: '0:v', audio: hasAudio ? '1:a' : undefined })
    : null;
  if (speedRampFilter) {
    filterParts.push(speedRampFilter.filterComplex);
    videoSource = speedRampFilter.outputLabels.video;
    audioSource = speedRampFilter.outputLabels.audio;
  }

  const vFilters: string[] = [];
  if (tailPadMs && tailPadMs > 0) {
    vFilters.push(`tpad=stop_mode=clone:stop_duration=${formatSeconds(tailPadMs)}`);
  }
  if (deviceScaleFactor > 1 && outputWidth && outputHeight) {
    vFilters.push(`scale=${outputWidth}:${outputHeight}:flags=lanczos`);
  }

  // Scene transitions
  let transitionComplex: { filterComplex: string; videoOutput: string; audioOutput: string | null } | null = null;
  if (transition && placements && placements.length > 1) {
    const transitionResult = buildTransitionFilters(placements, transition, hasAudio, fps ?? 30);
    if (Array.isArray(transitionResult)) {
      // Simple -vf filters (wipe)
      vFilters.push(...transitionResult);
    } else if (transitionResult.filterComplex) {
      // Complex filter graph (fade/dissolve — split+trim+fade+concat)
      transitionComplex = transitionResult;
    }
  }

  if (transitionComplex) {
    // Fade transitions use filter_complex with split+concat.
    // Apply any vFilters (scale, tpad) before the transition.
    let fc = transitionComplex.filterComplex;
    // Replace default stream refs when upstream filters (speed ramp, camera moves) change the labels
    const hasUpstreamVideo = videoSource !== '0:v';
    const hasUpstreamAudio = audioSource !== '1:a';
    if (hasUpstreamVideo) {
      fc = fc.replace('[0:v]', `[${videoSource}]`);
    }
    if (hasUpstreamAudio && transitionComplex.audioOutput) {
      fc = fc.replace('[1:a]', `[${audioSource}]`);
    }
    if (vFilters.length > 0) {
      // Prepend vFilters to the video input before split
      const inputRef = hasUpstreamVideo ? `[${videoSource}]` : '[0:v]';
      fc = fc.replace(inputRef + 'split=', `${inputRef}${vFilters.join(',')},split=`);
    }
    filterParts.push(fc);
    videoSource = transitionComplex.videoOutput.replace(/[\[\]]/g, '');
    if (hasAudio && transitionComplex.audioOutput) {
      audioSource = transitionComplex.audioOutput.replace(/[\[\]]/g, '');
    }
  } else if (vFilters.length > 0) {
    if (speedRampFilter || filterParts.length > 0) {
      filterParts.push(`[${videoSource}]${vFilters.join(',')}[outvfinal]`);
      videoSource = 'outvfinal';
    } else {
      args.push('-vf', vFilters.join(','));
    }
  }

  // Post-export camera moves (zoom/pan) — applied AFTER transitions so that
  // the time variable `t` is continuous across the concatenated output.
  const cameraMoves = options.cameraMoves;
  if (cameraMoves && cameraMoves.length > 0) {
    const frameW = (outputWidth ?? 1920) * deviceScaleFactor;
    const frameH = (outputHeight ?? 1080) * deviceScaleFactor;
    const sourceFps = getVideoFrameRate(videoPath);
    const camFilter = buildCameraMoveFilter(cameraMoves, frameW, frameH, `[${videoSource}]`, sourceFps);
    if (camFilter) {
      filterParts.push(camFilter.filter);
      videoSource = camFilter.outputLabel;
    }
  }

  // Background music mixing — applied before loudnorm so normalization covers the mix
  if (hasMusic) {
    const musicVol = options.musicVolume ?? 0.15;
    const musicRef = `${musicInputIdx}:a`;

    if (hasAudio && audioSource) {
      // Mix music under narration: lower music volume, combine with amix
      // afade on the music gives a 2s fade-out at the end (duration estimated from total)
      const fadeFilter = totalDurationMs && totalDurationMs > 2000
        ? `,afade=t=out:st=${formatSeconds(totalDurationMs - 2000)}:d=2`
        : '';
      filterParts.push(
        `[${musicRef}]volume=${musicVol}${fadeFilter}[bgm]`,
      );
      filterParts.push(
        `[${audioSource}][bgm]amix=inputs=2:duration=first:dropout_transition=2[amixed]`,
      );
      audioSource = 'amixed';
    } else {
      // No narration — use music as sole audio track
      const fadeFilter = totalDurationMs && totalDurationMs > 2000
        ? `,afade=t=out:st=${formatSeconds(totalDurationMs - 2000)}:d=2`
        : '';
      filterParts.push(
        `[${musicRef}]volume=${musicVol}${fadeFilter}[bgm]`,
      );
      audioSource = 'bgm';
    }
  }

  // Track whether we have any audio output (narration, music, or both)
  const hasAnyAudio = hasAudio || hasMusic;

  // Audio loudnorm — must be added before filter_complex is finalized
  let useLoudnormSimple = false;
  if (hasAnyAudio && audioSource && options.loudnorm) {
    if (filterParts.length > 0) {
      // Append loudnorm inside the filter_complex audio chain
      filterParts.push(`[${audioSource}]loudnorm=I=-16:TP=-1.5:LRA=11[anorm]`);
      audioSource = 'anorm';
    } else {
      useLoudnormSimple = true;
    }
  }

  if (filterParts.length > 0) {
    args.push('-filter_complex', filterParts.join(';\n'));
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
  );
  if (hasAnyAudio) {
    if (useLoudnormSimple) {
      args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    }
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  if (fps !== undefined) {
    args.push('-r', String(fps));
  }

  if (hasChapters) {
    args.push('-map_metadata', String(chapterInputIdx));
  }

  const usesExplicitMaps = hasThumbnail || filterParts.length > 0;
  const mapRef = (label: string) => (label.includes(':') ? label : `[${label}]`);

  if (usesExplicitMaps) {
    args.push('-map', mapRef(videoSource));
    if (hasAnyAudio && audioSource) args.push('-map', mapRef(audioSource));
  }

  if (hasThumbnail) {
    if (!usesExplicitMaps) {
      args.push('-map', '0:v');
      if (hasAnyAudio) args.push('-map', '1:a');
    }
    args.push('-map', `${thumbInputIdx}:v`);
    // Encode thumbnail stream as PNG attached picture
    args.push('-c:v:1', 'png', '-disposition:v:1', 'attached_pic');
    // Skip -shortest: the PNG has 0 duration and would truncate the whole output.
  } else if (hasAnyAudio) {
    args.push('-shortest');
  }

  args.push('-y', outputPath);

  // Use progress bar when we know the total duration
  if (totalDurationMs && totalDurationMs > 0) {
    await runFfmpegWithProgress(args, totalDurationMs);
  } else {
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
  }

  // Export additional formats
  const formats = options.formats ?? [];
  for (const format of formats) {
    if (format === 'gif') {
      const gifPath = outputPath.replace(/\.mp4$/, '.gif');
      console.log(`  Exporting GIF → ${gifPath}`);
      await exportGif(outputPath, gifPath, 10, outputWidth ?? 640);
      continue;
    }

    const suffix = format.replace(':', 'x');
    const formatPath = outputPath.replace(/\.mp4$/, `.${suffix}.mp4`);

    // Compute target dimensions for the format
    const srcH = outputHeight ?? 1080;
    let targetW: number, targetH: number;

    if (format === '1:1') {
      targetW = srcH;
      targetH = srcH;
    } else {
      // 9:16
      targetW = Math.round(srcH * 9 / 16);
      targetH = srcH;
    }

    // Ensure even dimensions (required by libx264)
    targetW = targetW % 2 === 0 ? targetW : targetW + 1;
    targetH = targetH % 2 === 0 ? targetH : targetH + 1;

    // Blur-fill: blurred version of the source fills the background,
    // original scaled-to-fit is overlaid on top. Much better than hard crop.
    const blurFilter = [
      `split[bg][fg]`,
      `[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=20:5[blurred]`,
      `[fg]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[scaled]`,
      `[blurred][scaled]overlay=(W-w)/2:(H-h)/2`,
    ].join(';');

    console.log(`  Exporting ${format} (blur-fill) → ${formatPath}`);
    const formatArgs = [
      '-i', outputPath,
      '-filter_complex', blurFilter,
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
