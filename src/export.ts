import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Placement } from './tts/align.js';
import type { TransitionConfig, WatermarkConfig, FrameConfig } from './config.js';
import { buildTransitionFilters } from './transitions.js';
import { buildShaderSpliceFilter } from './transitions/shader-splice.js';
import { runFfmpegWithProgress } from './progress.js';
import { buildSpeedRampFilter, type Segment } from './speed-ramp.js';
import { buildCameraMoveFilter, buildMotionBlurFilter, type CameraMove } from './camera-move.js';
import { buildFreezeFilter, type ResolvedFreeze } from './freeze.js';
import { getVideoFrameRate } from './media.js';
import { buildOverlayPngFilters, isImportedVideo, type RenderedOverlayPng } from './overlays/render-to-png.js';
import { buildHfBlockFilters, type RenderedHfBlock } from './hf/block-filter.js';
import { buildFrameFilter } from './frame.js';
import { getGpuEncoderName, resolveEncoder, type GpuEncoder } from './gpu-encoder.js';

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
  /** Music volume level (0.0 to 1.0). Default: 0.15. Mixed at a constant level. */
  musicVolume?: number;
  /** Extra audio tracks (typically from hyperframes compositions whose
   * `<audio>` elements aren't captured by CDP screencast). Each track is
   * delayed to its `startMs`, volume-scaled, and amix'd with the narration. */
  extraAudioTracks?: Array<{
    src: string;
    startMs: number;
    volume?: number;
  }>;
  /** Post-export camera moves (zoom/pan) recorded during Playwright session. */
  cameraMoves?: CameraMove[];
  /** Resolved freeze-frame holds — applied BEFORE transitions (they change the timeline). */
  freezeSpecs?: ResolvedFreeze[];
  /** Watermark/brand bug overlay config. */
  watermark?: WatermarkConfig;
  /** Pre-rendered overlay PNGs to composite onto the video (for imported videos). */
  overlayPngs?: RenderedOverlayPng[];
  /** Pre-rendered hyperframes block PNG sequences composited as cutaway overlays. */
  hfBlocks?: RenderedHfBlock[];
  /** Apply contrast-adaptive sharpening (CAS) to restore text crispness.
   * true = strength 0.5. { strength: 0.0-1.0 } to tune. */
  sharpen?: boolean | { strength: number };
  /** Frame the recording with padding, rounded corners, drop shadow, and background. */
  frame?: FrameConfig;
  /** Path to a pre-rendered frame PNG (from generateFramePng). Speeds up encoding. */
  framePngPath?: string;
  /** Apply motion blur during camera move transitions.
   * true = intensity 0.5. { intensity: 0.0-1.0 } to tune. */
  motionBlur?: boolean | { intensity: number };
  /** Pre-rendered shader transitions — paths to PNG sequence dirs per boundary. */
  shaderTransitions?: Array<{ boundarySec: number; durationMs: number; pngDir: string; frameCount: number }>;
  /** Encoder preference for the final mux step. `'cpu'` → libx264 (slower,
   * cleaner dark regions); `'gpu'` → platform GPU encoder (faster, more
   * banding on videotoolbox). When unset, the caller's default applies
   * (pipeline/cli pass 'cpu'; preview re-export passes 'gpu'). The
   * `ARGO_USE_GPU` env var still wins as an override. */
  encoder?: 'cpu' | 'gpu';
  /** Default encoder preference if `encoder` is unset. Set by callers. */
  encoderDefault?: 'cpu' | 'gpu';
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
  const audioPath = join(demoDir, 'narration-aligned.wav');
  const importedVideo = isImportedVideo(argoDir, demoName);

  // Find the video file — prefer original extension (imported videos), fall back to .webm
  let videoPath = join(demoDir, 'video.webm');
  for (const vExt of ['.mp4', '.mov', '.mkv', '.avi']) {
    const candidate = join(demoDir, `video${vExt}`);
    if (existsSync(candidate)) { videoPath = candidate; break; }
  }
  if (!existsSync(videoPath)) {
    throw new Error(`No video found in ${demoDir}. Expected video.webm or video.mp4.`);
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

  // GPU encoder detection — done before args construction so VAAPI can insert device flag
  const gpuEncoder: GpuEncoder = await resolveEncoder(options.encoder, options.encoderDefault ?? 'cpu');
  const codecName = getGpuEncoderName(gpuEncoder, 'h264');

  const args: string[] = [];

  // VAAPI requires a device flag BEFORE the first -i input
  if (gpuEncoder === 'vaapi') {
    args.push('-vaapi_device', '/dev/dri/renderD128');
  }

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

  // Extra audio tracks (typically from hyperframes compositions whose
  // <audio> children play SFX during the GSAP timeline). Each track gets
  // its own ffmpeg input, gets adelayed to its scene start, volume-scaled,
  // then amix'd with narration in the audio mixing block below.
  const extraAudioTracks = (options.extraAudioTracks ?? []).filter((t) => existsSync(t.src));
  const extraAudioInputs = extraAudioTracks.map((t) => {
    const idx = nextInput++;
    args.push('-i', t.src);
    return { ...t, inputIdx: idx };
  });

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

  // Freeze-frame holds — applied BEFORE transitions (they shift the timeline)
  const freezeSpecs = options.freezeSpecs;
  if (freezeSpecs && freezeSpecs.length > 0) {
    const freezeResult = buildFreezeFilter(
      freezeSpecs,
      options.totalDurationMs ?? 0,
      videoSource,
    );
    if (freezeResult) {
      filterParts.push(freezeResult.filter);
      videoSource = freezeResult.outputLabel;
    }
  }

  const vFilters: string[] = [];
  if (tailPadMs && tailPadMs > 0) {
    vFilters.push(`tpad=stop_mode=clone:stop_duration=${formatSeconds(tailPadMs)}`);
  }
  if (deviceScaleFactor > 1 && outputWidth && outputHeight) {
    vFilters.push(`scale=${outputWidth}:${outputHeight}:flags=lanczos`);
  }
  // Chrome renders full-range RGB (0-255); H.264 expects TV range (16-235).
  // Convert so blacks don't clip and contrast matches on compliant players.
  vFilters.push('scale=in_range=pc:out_range=tv');
  // setparams is added here for the simple -vf path (no compositing). When
  // overlay/composite steps run later (frame, watermark, overlayPNGs), they strip
  // color params from the top layer, so we re-inject setparams after all compositing
  // is done. See the setparams re-injection block below (after sharpen).
  vFilters.push('setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');

  // Note: VAAPI format=nv12,hwupload is deferred to AFTER all software filters
  // (transitions, camera moves, watermark, sharpen, etc.) — see below.

  // Scene transitions
  let transitionComplex: { filterComplex: string; videoOutput: string; audioOutput: string | null } | null = null;
  if (transition && placements && placements.length > 1) {
    if (transition.type === 'shader' && options.shaderTransitions && options.shaderTransitions.length > 0) {
      // Shader transitions: register each PNG sequence as a new ffmpeg input,
      // then build a splice filter_complex. PNG inputs are inserted here (before
      // overlay PNGs / frame / watermark) so their extraInputIndex values are stable.

      // If vFilters exist (scale, tpad, setparams), apply them before the splice
      // by prepending a filter graph node that consumes videoSource and emits a
      // labelled output the splice can reference.
      let shaderVideoLabel = videoSource;
      if (vFilters.length > 0) {
        const shaderPreLabel = 'svpre';
        filterParts.push(`[${videoSource}]${vFilters.join(',')}[${shaderPreLabel}]`);
        shaderVideoLabel = shaderPreLabel;
        vFilters.length = 0; // consumed — prevent double-emit via -vf below
      }

      const shaderInputIndices: number[] = [];
      for (const st of options.shaderTransitions) {
        const idx = nextInput++;
        shaderInputIndices.push(idx);
        args.push(
          '-framerate', String(fps ?? 30),
          '-i', join(st.pngDir, 'frame_%04d.png'),
        );
      }
      const spliceResult = buildShaderSpliceFilter({
        totalDurationSec: (totalDurationMs ?? 0) / 1000,
        boundaries: options.shaderTransitions.map((st, i) => ({
          boundarySec: st.boundarySec,
          durationMs: st.durationMs,
          extraInputIndex: shaderInputIndices[i],
        })),
        videoInputLabel: `[${shaderVideoLabel}]`,
        audioInputLabel: hasAudio ? `[${audioSource}]` : null,
        fps: fps ?? 30,
      });
      transitionComplex = {
        filterComplex: spliceResult.filterComplex,
        videoOutput: spliceResult.videoOutput,
        audioOutput: spliceResult.audioOutput,
      };
    } else {
      const transitionResult = buildTransitionFilters(placements, transition, hasAudio, fps ?? 30);
      if (Array.isArray(transitionResult)) {
        // Simple -vf filters (wipe)
        vFilters.push(...transitionResult);
      } else if ('filterComplex' in transitionResult) {
        // Complex filter graph (fade/dissolve — split+trim+fade+concat)
        transitionComplex = transitionResult;
      }
      // else: shaderDeferred sentinel — no shaderTransitions provided yet
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
    // Anticipate whether downstream stages will add inputs or filter_complex
    // nodes. Any stage that pushes a new `-i` requires vFilters to flow through
    // filter_complex — otherwise ffmpeg rejects with "Option vf cannot be
    // applied to input url" because the new `-i` lands after the `-vf`. Covers
    // frame (adds PNG input), watermark (adds PNG input), overlayPngs (adds
    // PNG inputs), hfBlocks (adds image2 sequence inputs), cameraMoves
    // (filter_complex only), and sharpen (which routes via filter_complex
    // once other filters are present).
    const downstreamWillUseFilterComplex =
      (options.cameraMoves && options.cameraMoves.length > 0) ||
      (options.overlayPngs && options.overlayPngs.length > 0) ||
      (options.hfBlocks && options.hfBlocks.length > 0) ||
      Boolean(options.frame) ||
      Boolean(options.watermark && options.watermark.src && existsSync(options.watermark.src)) ||
      Boolean(options.sharpen);
    if (speedRampFilter || filterParts.length > 0 || downstreamWillUseFilterComplex) {
      filterParts.push(`[${videoSource}]${vFilters.join(',')}[outvfinal]`);
      videoSource = 'outvfinal';
    } else {
      args.push('-vf', vFilters.join(','));
    }
  }

  // Track videoSource after vFilters are applied. Compositing steps (camera moves,
  // overlayPNGs, frame, watermark, sharpen) may run next — if any of them change
  // videoSource, setparams will need to be re-applied as the final graph node.
  const videoSourceAfterVFilters = videoSource;

  // Post-export camera moves (zoom/pan) — applied AFTER transitions so that
  // the time variable `t` is continuous across the concatenated output.
  const cameraMoves = options.cameraMoves;
  if (cameraMoves && cameraMoves.length > 0) {
    // Camera-move runs AFTER the early svpre/vFilters downscale to outputWidth ×
    // outputHeight, so the zoompan filter sees output-dim frames. Coords are kept
    // at CSS pixels (no `* deviceScaleFactor`) — pipeline.ts no longer upscales them.
    const frameW = outputWidth ?? 1920;
    const frameH = outputHeight ?? 1080;
    const sourceFps = getVideoFrameRate(videoPath);
    const camFilter = buildCameraMoveFilter(cameraMoves, frameW, frameH, `[${videoSource}]`, sourceFps);
    if (camFilter) {
      filterParts.push(camFilter.filter);
      videoSource = camFilter.outputLabel;
    }

    // Motion blur — applied immediately after camera moves to blur zoom/pan transitions
    const motionBlur = options.motionBlur;
    if (motionBlur) {
      const intensity = typeof motionBlur === 'object' ? motionBlur.intensity : 0.5;
      const mblurFilter = buildMotionBlurFilter(`[${videoSource}]`, intensity, cameraMoves, sourceFps);
      if (mblurFilter) {
        filterParts.push(mblurFilter.filter);
        videoSource = mblurFilter.outputLabel;
      }
    }
  }

  // Overlay PNGs for imported videos — composited AFTER transitions/camera moves,
  // BEFORE watermark (same layer priority as recorded overlays would have).
  const overlayPngs = options.overlayPngs;
  if (overlayPngs && overlayPngs.length > 0) {
    const ovlResult = buildOverlayPngFilters(overlayPngs, nextInput, videoSource);
    args.push(...ovlResult.inputArgs);
    filterParts.push(...ovlResult.filterParts);
    videoSource = ovlResult.videoSource;
    nextInput = ovlResult.nextInput;
  }

  // Pre-rendered hyperframes block PNG sequences — composited immediately after
  // overlay PNGs (same layer priority: after transitions/camera moves, before
  // frame/watermark) as cutaway overlays with an `enable`-gated timeline window.
  const hfBlocks = options.hfBlocks;
  if (hfBlocks && hfBlocks.length > 0) {
    const hfResult = buildHfBlockFilters(hfBlocks, nextInput, videoSource, outputWidth ?? 1920, outputHeight ?? 1080);
    args.push(...hfResult.inputArgs);
    filterParts.push(...hfResult.filterParts);
    videoSource = hfResult.videoSource;
    nextInput = hfResult.nextInput;
  }

  // Frame effect — padding, rounded corners, shadow, background
  // Applied AFTER all content processing, BEFORE watermark
  let frame = options.frame;
  if (frame && frame.background?.type === 'auto') {
    // Resolve 'auto' background by probing video edge colors
    const { probeEdgeColors } = await import('./media.js');
    const edgeColors = probeEdgeColors(videoPath);
    frame = {
      ...frame,
      background: edgeColors
        ? { type: 'gradient' as const, value: `linear-gradient(135deg, ${edgeColors.color0}, ${edgeColors.color1})` }
        : { type: 'solid' as const, value: '#000000' },
    };
  }
  if (frame) {
    const outW = outputWidth ?? 1920;
    const outH = outputHeight ?? 1080;
    const frameResult = buildFrameFilter(videoSource, outW, outH, frame, nextInput, options.framePngPath);
    if (frameResult) {
      args.push(...frameResult.inputArgs);
      filterParts.push(...frameResult.filterParts);
      videoSource = frameResult.videoSource;
      nextInput += frameResult.addedInputs;
    }
  }

  // Watermark overlay — applied AFTER all other video filters (last in chain)
  const watermark = options.watermark;
  if (watermark && watermark.src) {
    if (!existsSync(watermark.src)) {
      console.warn(
        `Warning: watermark image "${watermark.src}" does not exist. ` +
        `The video will be exported without a watermark.`
      );
    } else {
      const wmInputIdx = nextInput++;
      args.push('-i', watermark.src);

      const wmPosition = watermark.position ?? 'bottom-right';
      const wmMargin = watermark.margin ?? 20;
      const wmOpacity = watermark.opacity ?? 0.7;

      // Position expressions for ffmpeg overlay filter
      const positionMap: Record<string, string> = {
        'top-left': `x=${wmMargin}:y=${wmMargin}`,
        'top-right': `x=W-w-${wmMargin}:y=${wmMargin}`,
        'bottom-left': `x=${wmMargin}:y=H-h-${wmMargin}`,
        'bottom-right': `x=W-w-${wmMargin}:y=H-h-${wmMargin}`,
      };
      const posExpr = positionMap[wmPosition];

      // Build watermark filter chain. When `scale` is set, resample the
      // watermark BEFORE applying opacity so the alpha channel is honored
      // through the scale (`scale` defaults to bicubic sampling). Required
      // when exporting at higher resolutions than the source PNG was
      // designed for — at 4K, a 200×60 logo built for 1080p would otherwise
      // render at 200×60 on a 3840-wide canvas, visually half the size.
      let wmRef: string = `${wmInputIdx}:v`;
      const wmScale = watermark.scale;
      if (typeof wmScale === 'number' && wmScale > 0 && wmScale !== 1) {
        filterParts.push(
          `[${wmRef}]scale=iw*${wmScale}:ih*${wmScale}:flags=bicubic[wmscaled]`,
        );
        wmRef = 'wmscaled';
      }
      const needsOpacity = wmOpacity < 1.0;
      if (needsOpacity) {
        filterParts.push(`[${wmRef}]colorchannelmixer=aa=${wmOpacity}[wm]`);
      }
      const wmLabel = needsOpacity ? 'wm' : wmRef;
      filterParts.push(`[${videoSource}][${wmLabel}]overlay=${posExpr}:format=auto[outwm]`);
      videoSource = 'outwm';
    }
  }

  // Contrast-adaptive sharpening — applied AFTER all compositing (last video filter)
  const sharpen = options.sharpen;
  if (sharpen) {
    const strength = typeof sharpen === 'object' ? sharpen.strength : 0.5;
    const clampedStrength = Math.max(0, Math.min(1, strength));
    if (filterParts.length > 0 || videoSource !== '0:v') {
      filterParts.push(`[${videoSource}]cas=${clampedStrength}[outcas]`);
      videoSource = 'outcas';
    } else {
      args.push('-vf', `cas=${clampedStrength}`);
    }
  }

  // setparams re-injection — only needed when compositing occurred AFTER vFilters were
  // consumed. Overlay compositing (frame PNG + watermark + overlay PNGs + camera moves)
  // inherits color params from the bottom layer and strips them from the top layer, so
  // the setparams in vFilters (above) has no effect once compositing runs. Re-apply it
  // as the final graph node when videoSource moved past where vFilters left off.
  if (videoSource !== videoSourceAfterVFilters) {
    const setparamsFilter = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';
    filterParts.push(`[${videoSource}]${setparamsFilter}[vtagged]`);
    videoSource = 'vtagged';
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

  // Extra audio tracks (composition SFX) — adelay each to its scene start,
  // apply volume, then amix all surviving audio sources together. Done AFTER
  // the music mix so loudnorm picks up the full mix.
  if (extraAudioInputs.length > 0) {
    const extraLabels: string[] = [];
    for (let i = 0; i < extraAudioInputs.length; i++) {
      const t = extraAudioInputs[i];
      const vol = t.volume ?? 0.7;
      const delayMs = Math.max(0, Math.round(t.startMs));
      const label = `xa${i}`;
      filterParts.push(
        `[${t.inputIdx}:a]adelay=${delayMs}|${delayMs},volume=${vol}[${label}]`,
      );
      extraLabels.push(`[${label}]`);
    }
    if (audioSource) {
      // Mix existing narration/music with extras
      const inputs = [`[${audioSource}]`, ...extraLabels].join('');
      filterParts.push(
        `${inputs}amix=inputs=${1 + extraLabels.length}:duration=longest:dropout_transition=0,volume=${1 + extraLabels.length * 0.5}[xamixed]`,
      );
      audioSource = 'xamixed';
    } else {
      // No prior audio — extras become the only audio. amix them together.
      const inputs = extraLabels.join('');
      filterParts.push(
        `${inputs}amix=inputs=${extraLabels.length}:duration=longest:dropout_transition=0[xamixed]`,
      );
      audioSource = 'xamixed';
    }
  }
  const hasExtraAudio = extraAudioInputs.length > 0;

  // Track whether we have any audio output (narration, music, or both)
  const hasAnyAudio = hasAudio || hasMusic || hasExtraAudio;

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

  // VAAPI: hwupload must come AFTER all software filters (trim, fade, scale, sharpen, etc.)
  // because VAAPI surfaces cannot pass through software filter chains.
  // Inject as the final video filter in the graph, just before the encoder.
  // If we already have a -vf arg (simple path, no filter_complex), append to the last
  // -vf value rather than pushing a second one (ffmpeg only accepts one -vf).
  if (gpuEncoder === 'vaapi') {
    if (filterParts.length > 0 || videoSource !== '0:v') {
      // filter_complex path: add as last graph node so it runs after all sw filters
      filterParts.push(`[${videoSource}]format=nv12,hwupload[vaapi_ready]`);
      videoSource = 'vaapi_ready';
    } else {
      // Simple -vf path: check if vFilters were already emitted via -vf
      const vfArgIdx = args.lastIndexOf('-vf');
      if (vfArgIdx >= 0) {
        // Append to existing -vf chain (scale=in_range=pc... already there)
        args[vfArgIdx + 1] += ',format=nv12,hwupload';
      } else {
        args.push('-vf', 'format=nv12,hwupload');
      }
    }
  }

  if (filterParts.length > 0) {
    args.push('-filter_complex', filterParts.join(';\n'));
  }

  args.push('-c:v', codecName);
  args.push('-pix_fmt', gpuEncoder === 'vaapi' ? 'vaapi_vld' : 'yuv420p');

  // Per-encoder quality/preset flags
  switch (gpuEncoder) {
    case 'nvenc':
      args.push('-preset', preset, '-cq', String(crf));
      break;
    case 'videotoolbox': {
      const vtQ = Math.max(0, Math.min(100, 100 - crf * 2));
      args.push('-q:v', String(vtQ), '-allow_sw', '1');
      break;
    }
    case 'vaapi':
      args.push('-qp', String(crf));
      break;
    case 'qsv':
      args.push('-preset', preset, '-global_quality', String(crf));
      break;
    default:
      // libx264 fallback
      args.push('-preset', preset, '-crf', String(crf));
      break;
  }

  // aq-mode=3 redistributes bits to dark flat regions (kills gradient banding),
  // deblock softens macroblock edges. BT.709 params embed color-space VUI in H.264.
  // These flags are libx264-only — GPU encoders use their own rate control internals.
  if (!gpuEncoder) {
    args.push(
      '-x264-params',
      'aq-mode=3:aq-strength=0.8:deblock=1,1:colorprim=bt709:transfer=bt709:colormatrix=bt709',
    );
  }

  // Container-level color space tags — picked up by Safari, modern TVs, and
  // standards-compliant players. Chrome screenshots are sRGB which maps to BT.709.
  // These apply to all encoders (container metadata, not codec-internal VUI).
  args.push(
    '-colorspace:v', 'bt709',
    '-color_primaries:v', 'bt709',
    '-color_trc:v', 'bt709',
    '-color_range', 'tv',
  );

  // Fixed 90kHz timescale prevents A/V timing drift across platforms.
  args.push('-video_track_timescale', '90000');
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
    // Skip -shortest when:
    // - Freeze-frame holds extend the video beyond the audio
    // - Overlay PNGs are present (imported videos where audio may be shorter than video)
    // - hf-block PNG sequences are present (same reasoning as overlay PNGs — these
    //   are finite image2 sequences with eof_action=pass, so they can't hang the
    //   encode, but -shortest could still truncate the video against a shorter
    //   audio track when they're the reason overlayPngs would otherwise be absent)
    // - Imported videos have narration shorter than the full source video
    const hasFreezes = freezeSpecs && freezeSpecs.length > 0;
    const hasOverlayPngs = options.overlayPngs && options.overlayPngs.length > 0;
    const hasHfBlocks = options.hfBlocks && options.hfBlocks.length > 0;
    const importedNarrationVideo = importedVideo && hasAudio;
    if (!hasFreezes && !hasOverlayPngs && !hasHfBlocks && !importedNarrationVideo) {
      args.push('-shortest');
    }
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
    // Range conversion applied to the composited output so both bg and fg inherit it.
    const blurFilter = [
      `split[bg][fg]`,
      `[bg]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},boxblur=20:5[blurred]`,
      `[fg]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease[scaled]`,
      `[blurred][scaled]overlay=(W-w)/2:(H-h)/2,scale=in_range=pc:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`,
    ].join(';');

    console.log(`  Exporting ${format} (blur-fill) → ${formatPath}`);
    const formatArgs: string[] = [];

    // VAAPI needs device flag before -i
    if (gpuEncoder === 'vaapi') {
      formatArgs.push('-vaapi_device', '/dev/dri/renderD128');
    }

    // VAAPI blur-fill: append hw upload filters after range conversion in the graph
    const blurFilterFinal = gpuEncoder === 'vaapi'
      ? blurFilter + ',format=nv12,hwupload'
      : blurFilter;

    formatArgs.push(
      '-i', outputPath,
      '-filter_complex', blurFilterFinal,
      '-c:v', codecName,
      '-pix_fmt', gpuEncoder === 'vaapi' ? 'vaapi_vld' : 'yuv420p',
    );

    // Per-encoder quality flags
    switch (gpuEncoder) {
      case 'nvenc':
        formatArgs.push('-preset', preset, '-cq', String(crf));
        break;
      case 'videotoolbox': {
        const vtQ = Math.max(0, Math.min(100, 100 - crf * 2));
        formatArgs.push('-q:v', String(vtQ), '-allow_sw', '1');
        break;
      }
      case 'vaapi':
        formatArgs.push('-qp', String(crf));
        break;
      case 'qsv':
        formatArgs.push('-preset', preset, '-global_quality', String(crf));
        break;
      default:
        formatArgs.push('-preset', preset, '-crf', String(crf));
        if (!gpuEncoder) {
          formatArgs.push(
            '-x264-params',
            'aq-mode=3:aq-strength=0.8:deblock=1,1:colorprim=bt709:transfer=bt709:colormatrix=bt709',
          );
        }
        break;
    }

    formatArgs.push(
      '-colorspace:v', 'bt709',
      '-color_primaries:v', 'bt709',
      '-color_trc:v', 'bt709',
      '-color_range', 'tv',
      '-video_track_timescale', '90000',
      '-c:a', 'copy',
      '-y', formatPath,
    );

    const fmtResult = spawnSync('ffmpeg', formatArgs, { stdio: 'inherit' });
    if (fmtResult.status !== 0) {
      console.warn(`Warning: failed to export ${format} format to ${formatPath}`);
    }
  }

  return outputPath;
}
