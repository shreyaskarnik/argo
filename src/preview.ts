/**
 * argo preview — browser-based replay viewer for iterating on voiceover,
 * overlays, and timing without re-recording.
 *
 * Serves a local web page that plays a seekable preview video (preferring MP4
 * over the raw Playwright WebM), overlays audio clips at scene timestamps,
 * renders overlay cues on a DOM layer, and lets the user edit voiceover text
 * + overlay props inline with per-scene TTS regen.
 */

import { execFile, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync, statSync, createReadStream, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { renderTemplate } from './overlays/templates.js';
import { alignClips, schedulePlacements, type ClipInfo, type Placement, type SceneTiming } from './tts/align.js';
import { ClipCache, type ManifestEntry } from './tts/cache.js';
import { createWavBuffer, parseWavHeader } from './tts/engine.js';
import type { OverlayManifestEntry, SceneEffect, Zone } from './overlays/types.js';
import { generateSrt, generateVtt } from './subtitles.js';
import { generateChapterMetadata } from './chapters.js';
import { exportVideo, checkFfmpeg } from './export.js';
import { applySpeedRampToTimeline, remapTimeMs } from './speed-ramp.js';
import {
  exportTimelineRemap,
  remapCameraMoves,
  scaleCameraMoves,
  shiftCameraMoves,
  type CameraMove,
} from './camera-move.js';
import { generateFramePng } from './frame.js';
import { resolveFreezes, adjustPlacementsForFreezes, totalFreezeDurationMs, type FreezeSpec } from './freeze.js';
import { buildOverlayPngsForImport, isImportedVideo, type RenderedOverlayPng } from './overlays/render-to-png.js';
import { renderShaderTransitions, type ShaderTransitionRenderResult } from './transitions/shader-render.js';
import { detectVideoTheme, getVideoDurationMs, probeEdgeColors } from './media.js';
import { computeWaveform } from './preview-waveform.js';
import type { BackgroundTheme } from './overlays/zones.js';

export interface PreviewExportConfig {
  preset?: string;
  crf?: number;
  fps?: number;
  captureWidth?: number;
  captureHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  deviceScaleFactor?: number;
  thumbnailPath?: string;
  formats?: Array<'1:1' | '9:16' | 'gif'>;
  transition?: import('./config.js').TransitionConfig;
  speedRamp?: import('./config.js').SpeedRampConfig;
  loudnorm?: boolean;
  musicPath?: string;
  musicVolume?: number;
  watermark?: import('./config.js').WatermarkConfig;
  sharpen?: boolean | { strength: number };
  frame?: import('./config.js').FrameConfig;
  motionBlur?: boolean | { intensity: number };
  encoder?: 'cpu' | 'gpu';
}

export interface PreviewOptions {
  demoName: string;
  argoDir?: string;
  demosDir?: string;
  outputDir?: string;
  port?: number;
  open?: boolean;
  ttsDefaults?: { voice?: string; speed?: number };
  exportConfig?: PreviewExportConfig;
  regenerateTts?: (args: { manifestPath: string; scene: string }) => Promise<void>;
}

interface PreviewVoiceoverEntry {
  scene: string;
  text: string;
  voice?: string;
  speed?: number;
  lang?: string;
  _hint?: string;
  playbackSpeed?: number;
}

interface PreviewSceneReport {
  totalDurationMs: number;
  overflowMs: number;
  scenes: Array<{ scene: string; startMs: number; endMs: number; durationMs: number }>;
}

interface PreviewData {
  demoName: string;
  timing: Record<string, number>;
  voiceover: PreviewVoiceoverEntry[];
  overlays: OverlayManifestEntry[];
  /** Per-scene effects (confetti, spotlight, etc.). Keyed by scene name. */
  effects: Record<string, SceneEffect[]>;
  sceneDurations: Record<string, number>;
  sceneReport: PreviewSceneReport | null;
  /** Pre-rendered overlay HTML/CSS for each scene (keyed by scene name). */
  renderedOverlays: Record<string, { html: string; styles: Record<string, string>; zone: Zone }>;
  /** Detected overlay theme per scene — 'dark' or 'light' (for UI display). */
  overlayThemes: Record<string, BackgroundTheme>;
  /** Actual video file duration in ms — used as floor for timeline. */
  videoDurationMs: number;
  /** Pipeline metadata from last recording (voices, resolution, engine). */
  pipelineMeta: Record<string, unknown> | null;
  /** Camera moves for post-export zoom/pan effects. */
  cameraMoves: Array<import('./camera-move.js').CameraMove>;
  /** Cursor telemetry for dwell-based camera suggestions. */
  cursorTelemetry: Array<{ cx: number; cy: number; timeMs: number }>;
  /** Head trim offset for un-shifting camera moves on save. */
  headTrimMs: number;
  /** Preview-only background music state. */
  bgm: {
    hasGenerated: boolean;
    hasConfig: boolean;
    include: boolean;
    volume: number;
  };
  /** Current frame config — editable in preview UI. */
  frameConfig: import('./config.js').FrameConfig | null;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
};

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

function ensureSeekablePreviewProxy(rawVideoPath: string, proxyPath: string): string | null {
  try {
    const needsRender = !existsSync(proxyPath) || statSync(proxyPath).mtimeMs < statSync(rawVideoPath).mtimeMs;
    if (!needsRender) return proxyPath;

    checkFfmpeg();
    const result = spawnSync('ffmpeg', [
      '-i', rawVideoPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-y', proxyPath,
    ], {
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString('utf-8').trim();
      console.warn(`Warning: failed to create preview MP4 proxy for ${rawVideoPath}${stderr ? `: ${stderr}` : ''}`);
      return null;
    }

    return proxyPath;
  } catch (err) {
    console.warn(`Warning: failed to prepare seekable preview video: ${(err as Error).message}`);
    return null;
  }
}

function setManifestField(target: Record<string, any>, key: string, value: any): boolean {
  if (value === undefined || value === null || value === '') {
    if (key in target) {
      delete target[key];
      return true;
    }
    return false;
  }
  if (target[key] === value) return false;
  target[key] = value;
  return true;
}

function updatePreviewVoiceoverEntry(target: Record<string, any>, entry: PreviewVoiceoverEntry): boolean {
  let changed = false;
  changed = setManifestField(target, 'text', entry.text) || changed;
  changed = setManifestField(target, 'voice', entry.voice) || changed;
  changed = setManifestField(target, 'speed', entry.speed) || changed;
  changed = setManifestField(target, 'lang', entry.lang) || changed;
  changed = setManifestField(target, '_hint', entry._hint) || changed;
  changed = setManifestField(target, 'playbackSpeed', entry.playbackSpeed) || changed;
  return changed;
}

function updatePreviewOverlayEntry(target: Record<string, any>, overlay: OverlayManifestEntry | undefined): boolean {
  if (!overlay) {
    if ('overlay' in target) {
      delete target.overlay;
      return true;
    }
    return false;
  }

  const overlayTarget = (target.overlay && typeof target.overlay === 'object')
    ? target.overlay as Record<string, any>
    : ((target.overlay = {}) as Record<string, any>);

  let changed = false;
  changed = setManifestField(overlayTarget, 'type', overlay.type) || changed;
  changed = setManifestField(overlayTarget, 'motion', overlay.motion) || changed;
  changed = setManifestField(overlayTarget, 'autoBackground', overlay.autoBackground) || changed;

  if (overlay.placement === 'bottom-center') {
    if (overlayTarget.placement !== undefined && overlayTarget.placement !== 'bottom-center') {
      delete overlayTarget.placement;
      changed = true;
    }
  } else {
    changed = setManifestField(overlayTarget, 'placement', overlay.placement) || changed;
  }

  if (overlay.type === 'lower-third' || overlay.type === 'callout') {
    changed = setManifestField(overlayTarget, 'text', overlay.text) || changed;
    changed = setManifestField(overlayTarget, 'title', undefined) || changed;
    changed = setManifestField(overlayTarget, 'body', undefined) || changed;
    changed = setManifestField(overlayTarget, 'kicker', undefined) || changed;
    changed = setManifestField(overlayTarget, 'src', undefined) || changed;
    // Clear arrow fields
    changed = setManifestField(overlayTarget, 'direction', undefined) || changed;
    changed = setManifestField(overlayTarget, 'label', undefined) || changed;
    changed = setManifestField(overlayTarget, 'color', undefined) || changed;
    changed = setManifestField(overlayTarget, 'size', undefined) || changed;
  } else if (overlay.type === 'arrow') {
    changed = setManifestField(overlayTarget, 'direction', 'direction' in overlay ? overlay.direction : undefined) || changed;
    changed = setManifestField(overlayTarget, 'label', 'label' in overlay ? overlay.label : undefined) || changed;
    changed = setManifestField(overlayTarget, 'color', 'color' in overlay ? overlay.color : undefined) || changed;
    changed = setManifestField(overlayTarget, 'size', 'size' in overlay ? overlay.size : undefined) || changed;
    // Clear non-arrow fields
    changed = setManifestField(overlayTarget, 'text', undefined) || changed;
    changed = setManifestField(overlayTarget, 'title', undefined) || changed;
    changed = setManifestField(overlayTarget, 'body', undefined) || changed;
    changed = setManifestField(overlayTarget, 'kicker', undefined) || changed;
    changed = setManifestField(overlayTarget, 'src', undefined) || changed;
  } else {
    changed = setManifestField(overlayTarget, 'text', undefined) || changed;
    changed = setManifestField(overlayTarget, 'title', 'title' in overlay ? overlay.title : undefined) || changed;
    changed = setManifestField(overlayTarget, 'body', 'body' in overlay ? overlay.body : undefined) || changed;
    changed = setManifestField(overlayTarget, 'kicker', 'kicker' in overlay ? overlay.kicker : undefined) || changed;
    changed = setManifestField(overlayTarget, 'src', 'src' in overlay ? overlay.src : undefined) || changed;
    // Clear arrow fields
    changed = setManifestField(overlayTarget, 'direction', undefined) || changed;
    changed = setManifestField(overlayTarget, 'label', undefined) || changed;
    changed = setManifestField(overlayTarget, 'color', undefined) || changed;
    changed = setManifestField(overlayTarget, 'size', undefined) || changed;
  }

  return changed;
}

function buildRenderedOverlays(
  overlays: OverlayManifestEntry[],
  themeMap?: Record<string, BackgroundTheme>,
): PreviewData['renderedOverlays'] {
  const renderedOverlays: PreviewData['renderedOverlays'] = {};
  for (const entry of overlays) {
    const { scene, ...cue } = entry;
    const zone: Zone = cue.placement ?? 'bottom-center';
    const theme = themeMap?.[scene] ?? 'dark';
    const { contentHtml, styles } = renderTemplate(cue, theme);
    renderedOverlays[scene] = { html: contentHtml, styles, zone };
  }
  return renderedOverlays;
}

function buildPreviewSceneReport(
  timing: Record<string, number>,
  sceneDurations: Record<string, number>,
  persisted?: { totalDurationMs?: number; overflowMs?: number } | null,
): PreviewSceneReport | null {
  const scheduled = Object.entries(timing)
    .filter(([scene]) => sceneDurations[scene] && sceneDurations[scene] > 0)
    .map(([scene, startMs]) => ({ scene, startMs, durationMs: sceneDurations[scene] }));

  if (scheduled.length === 0) return null;

  const placements = schedulePlacements(scheduled);
  return createSceneReportFromPlacements(placements, persisted);
}

function createSceneReportFromPlacements(
  placements: Placement[],
  persisted?: { totalDurationMs?: number; overflowMs?: number } | null,
): PreviewSceneReport {
  const lastEndMs = placements.length > 0 ? placements[placements.length - 1].endMs : 0;
  const baseDurationMs = persisted?.totalDurationMs ?? lastEndMs;
  return {
    totalDurationMs: Math.max(baseDurationMs, lastEndMs),
    overflowMs: Math.max(persisted?.overflowMs ?? 0, lastEndMs - baseDurationMs),
    scenes: placements.map((placement) => ({
      scene: placement.scene,
      startMs: placement.startMs,
      endMs: placement.endMs,
      durationMs: placement.endMs - placement.startMs,
    })),
  };
}

function loadPreviewData(
  demoName: string,
  argoDir: string,
  demosDir: string,
  outputDir: string = 'videos',
  exportConfig?: PreviewExportConfig,
  activeMusicPath?: string,
): PreviewData {
  const demoDir = join(argoDir, demoName);

  // Required files
  const timingPath = join(demoDir, '.timing.json');
  if (!existsSync(timingPath)) {
    throw new Error(`No timing data found at ${timingPath}. Run 'argo pipeline ${demoName}' first.`);
  }
  const rawTiming = readJsonFile<Record<string, number>>(timingPath, {});

  // If the pipeline applied head-trimming, shift timing to match the trimmed MP4
  const metaPath = join(outputDir, `${demoName}.meta.json`);
  const meta = existsSync(metaPath) ? readJsonFile<Record<string, any>>(metaPath, {}) : {};
  const headTrimMs: number = meta?.export?.headTrimMs ?? 0;
  const timing: Record<string, number> = {};
  for (const [scene, ms] of Object.entries(rawTiming)) {
    timing[scene] = ms - headTrimMs;
  }

  // Unified scenes manifest
  const scenesPath = join(demosDir, `${demoName}.scenes.json`);
  const scenes = readJsonFile<Array<any>>(scenesPath, []);

  // Derive voiceover and overlay arrays from unified entries
  const voiceover: PreviewVoiceoverEntry[] = scenes.map((s) => ({
    scene: s.scene,
    text: s.text,
    voice: s.voice,
    speed: s.speed,
    lang: s.lang,
    _hint: s._hint,
    playbackSpeed: s.playbackSpeed,
  }));

  const overlays: OverlayManifestEntry[] = scenes
    .filter((s: any) => s.overlay)
    .map((s: any) => ({ scene: s.scene, ...s.overlay }));

  // Extract effects keyed by scene name
  const effects: Record<string, SceneEffect[]> = {};
  for (const s of scenes) {
    if (Array.isArray(s.effects) && s.effects.length > 0) {
      effects[s.scene] = s.effects;
    }
  }

  // Scene durations
  const sdPath = join(demoDir, '.scene-durations.json');
  const sceneDurations = readJsonFile<Record<string, number>>(sdPath, {});

  // Use persisted report metadata, but derive scene placements from the current
  // timing + scene durations so preview stays in sync after per-scene regen.
  const reportPath = join(demoDir, 'scene-report.json');
  const persistedReport = readJsonFile<{ totalDurationMs?: number; overflowMs?: number } | null>(reportPath, null);
  const sceneReport = buildPreviewSceneReport(timing, sceneDurations, persistedReport);

  // Detect per-scene overlay theme from the video content.
  // Uses ffmpeg to sample frames at each overlay's scene timestamp.
  // Find video file — prefer original extension (imported videos) over .webm
  const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
  let videoPath: string | null = null;
  for (const ext of videoExts) {
    const candidate = join(demoDir, `video${ext}`);
    if (existsSync(candidate)) { videoPath = candidate; break; }
  }
  let overlayThemeMap: Record<string, BackgroundTheme> | undefined;
  if (videoPath && overlays.length > 0) {
    overlayThemeMap = {};
    for (const ov of overlays) {
      const sceneMs = timing[ov.scene] ?? 0;
      // Use next scene start as end bound, or scene + 5s as fallback
      const nextSceneMs = Object.values(timing)
        .filter((ms) => ms > sceneMs)
        .sort((a, b) => a - b)[0];
      const endMs = nextSceneMs ?? sceneMs + 5000;
      overlayThemeMap[ov.scene] = detectVideoTheme(videoPath, sceneMs, endMs);
    }
  }
  const renderedOverlays = buildRenderedOverlays(overlays, overlayThemeMap);

  // Pipeline metadata (reuse meta loaded above for headTrimMs)
  const pipelineMeta = Object.keys(meta).length > 0 ? meta as Record<string, unknown> : null;
  const hasGenerated = Boolean(activeMusicPath && existsSync(activeMusicPath));
  const hasConfig = Boolean(exportConfig?.musicPath);
  const bgm = {
    hasGenerated,
    hasConfig,
    include: hasGenerated || hasConfig,
    volume: exportConfig?.musicVolume ?? 0.15,
  };

  // Get actual video duration as the timeline floor
  let videoDurationMs = 0;
  const videoExtsForDur = ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
  for (const ext of videoExtsForDur) {
    const candidate = join(demoDir, `video${ext}`);
    if (existsSync(candidate)) {
      try { videoDurationMs = getVideoDurationMs(candidate); } catch { /* ignore */ }
      break;
    }
  }
  // Also check the exported MP4
  const exportedMp4 = join(outputDir, `${demoName}.mp4`);
  if (videoDurationMs === 0 && existsSync(exportedMp4)) {
    try { videoDurationMs = getVideoDurationMs(exportedMp4); } catch { /* ignore */ }
  }

  // Load cursor telemetry for dwell-based camera suggestions, shift for head trim
  const cursorTelemetryPath = join(demoDir, '.timing.cursor-telemetry.json');
  const rawCursorTelemetry = readJsonFile<Array<{ cx: number; cy: number; timeMs: number }>>(cursorTelemetryPath, []);
  const cursorTelemetry = headTrimMs > 0
    ? rawCursorTelemetry.map(s => ({ ...s, timeMs: s.timeMs - headTrimMs })).filter(s => s.timeMs >= 0)
    : rawCursorTelemetry;

  // Load camera moves from sidecar file, shift for head trim
  const cameraMovesPath = join(demoDir, '.timing.camera-moves.json');
  let cameraMoves: CameraMove[] = readJsonFile<CameraMove[]>(cameraMovesPath, []);
  if (headTrimMs > 0 && cameraMoves.length > 0) {
    cameraMoves = shiftCameraMoves(cameraMoves, headTrimMs);
  }

  return {
    demoName,
    timing,
    voiceover,
    overlays,
    effects,
    sceneDurations,
    sceneReport,
    renderedOverlays,
    overlayThemes: overlayThemeMap ?? {},
    videoDurationMs,
    pipelineMeta,
    bgm,
    cameraMoves,
    cursorTelemetry,
    headTrimMs,
    frameConfig: readJsonFile<import('./config.js').FrameConfig>(join(demoDir, 'frame-config.json'), null as any)
      ?? exportConfig?.frame
      ?? null,
  };
}

/** List WAV clip files available for a demo. */
function listClips(argoDir: string, demoName: string): string[] {
  const clipsDir = join(argoDir, demoName, 'clips');
  if (!existsSync(clipsDir)) return [];
  return readdirSync(clipsDir).filter((f) => f.endsWith('.wav'));
}

function getPreviewHtml(data: PreviewData): string {
  return PREVIEW_HTML.replace('__PREVIEW_DATA__', JSON.stringify(data));
}

function resolveClipPath(clipsDir: string, clipFile: string): string | null {
  const decoded = decodeURIComponent(clipFile);
  const candidate = resolve(clipsDir, decoded);
  const rel = relative(clipsDir, candidate);
  if (rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return null;
  }
  return candidate;
}

function readClipInfo(clipPath: string, scene: string): ClipInfo {
  const wavBuf = readFileSync(clipPath);
  const header = parseWavHeader(wavBuf);
  const sampleCount = header.dataSize / 4;
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount && header.dataOffset + i * 4 + 3 < wavBuf.length; i++) {
    samples[i] = wavBuf.readFloatLE(header.dataOffset + i * 4);
  }
  return {
    scene,
    durationMs: header.durationMs,
    samples,
  };
}

function refreshPreviewAudioArtifacts(
  demoName: string,
  argoDir: string,
  demosDir: string,
  defaults?: { voice?: string; speed?: number },
): { sceneDurations: Record<string, number>; sceneReport: PreviewSceneReport | null } {
  const demoDir = join(argoDir, demoName);
  const scenesPath = join(demosDir, `${demoName}.scenes.json`);
  const timingPath = join(demoDir, '.timing.json');
  const persistedReportPath = join(demoDir, 'scene-report.json');
  const projectRoot = dirname(resolve(argoDir));
  const cache = new ClipCache(projectRoot);
  const timing = readJsonFile<Record<string, number>>(timingPath, {});
  const persistedReport = readJsonFile<{ totalDurationMs?: number; overflowMs?: number } | null>(persistedReportPath, null);
  const scenesRaw = readJsonFile<Array<any>>(scenesPath, []);
  const manifest: PreviewVoiceoverEntry[] = scenesRaw.map((s) => ({
    scene: s.scene,
    text: s.text,
    voice: s.voice,
    speed: s.speed,
    lang: s.lang,
    _hint: s._hint,
  }));

  const clips: ClipInfo[] = [];
  const sceneDurations: Record<string, number> = {};

  for (const entry of manifest) {
    // Skip silent scenes (no text = no TTS clip)
    if (!entry.text?.trim()) continue;
    const cacheEntry: ManifestEntry = {
      scene: entry.scene,
      text: entry.text,
      voice: entry.voice ?? defaults?.voice,
      speed: entry.speed ?? defaults?.speed,
      lang: entry.lang,
    };
    const clipPath = cache.getClipPath(demoName, cacheEntry);
    if (!existsSync(clipPath)) {
      // Clip not generated yet (e.g., imported video without TTS run) — skip silently
      continue;
    }
    const clipInfo = readClipInfo(clipPath, entry.scene);
    clips.push(clipInfo);
    sceneDurations[entry.scene] = clipInfo.durationMs;
  }

  writeFileSync(join(demoDir, '.scene-durations.json'), JSON.stringify(sceneDurations, null, 2), 'utf-8');

  if (clips.length > 0) {
    const baseReport = buildPreviewSceneReport(timing, sceneDurations, persistedReport);
    const totalDurationMs = baseReport?.totalDurationMs ?? 0;
    const aligned = alignClips(timing, clips, totalDurationMs);
    writeFileSync(join(demoDir, 'narration-aligned.wav'), createWavBuffer(aligned.samples, 24_000));
    return {
      sceneDurations,
      sceneReport: createSceneReportFromPlacements(aligned.placements, persistedReport),
    };
  }

  // Silent mode: no clips, build report from timing marks
  const alignedPath = join(demoDir, 'narration-aligned.wav');
  if (existsSync(alignedPath)) {
    try { unlinkSync(alignedPath); } catch {}
  }
  return {
    sceneDurations,
    sceneReport: buildPreviewSceneReport(timing, sceneDurations, persistedReport),
  };
}

async function runPreviewTtsGenerate(manifestPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('npx', ['argo', 'tts', 'generate', manifestPath], {
      env: process.env,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`TTS regen failed: ${stderr || stdout}`));
      } else {
        resolve();
      }
    });
  });
}

export async function startPreviewServer(options: PreviewOptions): Promise<{ url: string; close: () => void }> {
  const argoDir = options.argoDir ?? '.argo';
  const demosDir = options.demosDir ?? 'demos';
  const outputDir = options.outputDir ?? 'videos';
  const port = options.port ?? 0; // 0 = auto-assign
  const demoName = options.demoName;
  const demoDir = join(argoDir, demoName);
  const importedVideo = isImportedVideo(argoDir, demoName);

  // Raw video path in .argo/<demo>/ — used for duration probing/theme detection and
  // as the source for an optional seekable preview proxy.
  let rawVideoPath: string | null = null;
  for (const rawExt of ['.mp4', '.mov', '.mkv', '.avi', '.webm']) {
    const candidate = join(demoDir, `video${rawExt}`);
    if (existsSync(candidate)) { rawVideoPath = candidate; break; }
  }

  // Prefer exported MP4 (has keyframes for seeking), then original-extension import, then raw WebM
  const exportedMp4 = join(outputDir, `${demoName}.mp4`);
  const previewProxyMp4 = join(demoDir, 'preview.mp4');
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo', '.webm': 'video/webm',
  };
  let videoPath: string | null = null;
  if (existsSync(exportedMp4)) {
    videoPath = exportedMp4;
  } else if (importedVideo && rawVideoPath) {
    videoPath = ensureSeekablePreviewProxy(rawVideoPath, previewProxyMp4) ?? rawVideoPath;
  } else {
    // Find the original-extension video first (correct MIME), fall back to video.webm
    for (const ext of ['.mp4', '.mov', '.mkv', '.avi', '.webm']) {
      const candidate = join(demoDir, `video${ext}`);
      if (existsSync(candidate)) { videoPath = candidate; break; }
    }
  }
  if (!videoPath || !existsSync(videoPath)) {
    throw new Error(
      `No recording found for '${demoName}'. Run 'argo pipeline ${demoName}' or 'argo import' first.`
    );
  }
  const ext = videoPath.slice(videoPath.lastIndexOf('.'));
  let videoMime = mimeMap[ext] ?? 'video/mp4';
  if (!rawVideoPath) rawVideoPath = videoPath; // fallback to served video

  // Track BGM saved from the music generator panel
  let activeMusicPath: string | undefined;
  // Check if a previously saved BGM exists
  const savedBgmPath = join(demoDir, 'music', 'bgm.wav');
  if (existsSync(savedBgmPath)) activeMusicPath = savedBgmPath;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    try {
      // --- API routes ---

      if (url === '/api/data') {
        const data = loadPreviewData(demoName, argoDir, demosDir, outputDir, options.exportConfig, activeMusicPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      if (url === '/api/clips') {
        const clips = listClips(argoDir, demoName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clips));
        return;
      }

      // Downsampled waveform peaks for the timeline strip
      if (url?.startsWith('/api/waveform') && (req.method === 'GET' || req.method === undefined)) {
        const parsed = new URL(req.url ?? '', `http://${req.headers.host}`);
        const requestedBuckets = Number(parsed.searchParams.get('samples')) || 1000;
        const wavPath = join(demoDir, 'narration-aligned.wav');
        const data = computeWaveform(wavPath, requestedBuckets);
        if (!data) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'narration-aligned.wav not found or unreadable' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        });
        res.end(JSON.stringify(data));
        return;
      }

      // Update frame config for live preview + re-export, persist to sidecar
      if (url === '/api/frame-config' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (!options.exportConfig) {
          (options as any).exportConfig = {};
        }
        options.exportConfig!.frame = body as import('./config.js').FrameConfig;
        // Persist to sidecar so config survives server restarts
        const demoDir = join(argoDir, demoName);
        if (!existsSync(demoDir)) mkdirSync(demoDir, { recursive: true });
        writeFileSync(join(demoDir, 'frame-config.json'), JSON.stringify(body, null, 2) + '\n', 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Probe video edge colors for "auto" background
      // Use raw recording (not exported MP4) to match what exportVideo probes
      if (url === '/api/probe-auto-bg' && req.method === 'GET') {
        const probePath = rawVideoPath && existsSync(rawVideoPath) ? rawVideoPath : videoPath;
        if (!probePath || !existsSync(probePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No video available to probe' }));
          return;
        }
        const colors = probeEdgeColors(probePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(colors ?? { color0: '#1a1a2e', color1: '#16213e' }));
        return;
      }

      // Serve a local image file for frame background preview
      if (url?.startsWith('/api/local-file') && req.method === 'GET') {
        const parsed = new URL(req.url ?? '', `http://${req.headers.host}`);
        const filePath = parsed.searchParams.get('path') ?? '';
        // Resolve relative to cwd (where argo.config lives)
        const resolved = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
        if (!filePath || !existsSync(resolved)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = resolved.slice(resolved.lastIndexOf('.')).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        createReadStream(resolved).pipe(res);
        return;
      }

      // Save voiceover fields into unified .scenes.json
      if (url === '/api/voiceover' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as PreviewVoiceoverEntry[];
        const scenesPath = join(demosDir, `${demoName}.scenes.json`);
        const scenes = readJsonFile<Array<any>>(scenesPath, []);
        let changed = false;
        for (const vo of body) {
          const existing = scenes.find((s: any) => s.scene === vo.scene);
          if (existing) {
            changed = updatePreviewVoiceoverEntry(existing, vo) || changed;
          } else {
            // New scene — always create a manifest entry (even without text)
            const newEntry: Record<string, any> = { scene: vo.scene };
            if (vo.text?.trim()) newEntry.text = vo.text;
            if (vo.voice) newEntry.voice = vo.voice;
            if (vo.speed) newEntry.speed = vo.speed;
            if (vo.lang) newEntry.lang = vo.lang;
            if (vo._hint) newEntry._hint = vo._hint;
            scenes.push(newEntry);
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(scenesPath, JSON.stringify(scenes, null, 2) + '\n', 'utf-8');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed }));
        return;
      }

      // Render overlay templates without saving to disk (for live preview)
      if (url === '/api/render-overlays' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as OverlayManifestEntry[];

        // Detect per-scene theme from the video for adaptive overlays
        let liveThemeMap: Record<string, BackgroundTheme> | undefined;
        if (rawVideoPath && existsSync(rawVideoPath) && body.length > 0) {
          const timingFile = join(demoDir, '.timing.json');
          const liveTiming = existsSync(timingFile)
            ? readJsonFile<Record<string, number>>(timingFile, {}) : {};
          liveThemeMap = {};
          for (const ov of body) {
            const sceneMs = liveTiming[ov.scene] ?? 0;
            const nextMs = Object.values(liveTiming)
              .filter((ms) => ms > sceneMs)
              .sort((a, b) => a - b)[0];
            liveThemeMap[ov.scene] = detectVideoTheme(rawVideoPath, sceneMs, nextMs ?? sceneMs + 5000);
          }
        }

        const renderedOverlays = buildRenderedOverlays(body, liveThemeMap);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, renderedOverlays }));
        return;
      }

      // Save overlay fields into unified .scenes.json
      if (url === '/api/overlays' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as OverlayManifestEntry[];
        const scenesPath = join(demosDir, `${demoName}.scenes.json`);
        const scenes = readJsonFile<Array<any>>(scenesPath, []);
        // Build a map of posted overlays keyed by scene
        const ovByScene = new Map<string, OverlayManifestEntry>();
        for (const ov of body) ovByScene.set(ov.scene, ov);
        let changed = false;
        for (const entry of scenes) {
          const posted = ovByScene.get(entry.scene);
          changed = updatePreviewOverlayEntry(entry, posted) || changed;
        }
        if (changed) {
          writeFileSync(scenesPath, JSON.stringify(scenes, null, 2) + '\n', 'utf-8');
        }
        // Reload and re-render overlays
        const data = loadPreviewData(demoName, argoDir, demosDir, outputDir, options.exportConfig, activeMusicPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed, renderedOverlays: data.renderedOverlays }));
        return;
      }

      // Save effects into unified .scenes.json
      if (url === '/api/effects' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, SceneEffect[]>;
        const scenesPath = join(demosDir, `${demoName}.scenes.json`);
        const scenes = readJsonFile<Array<any>>(scenesPath, []);
        let changed = false;
        for (const entry of scenes) {
          const posted = body[entry.scene];
          if (posted && posted.length > 0) {
            const newEffects = JSON.stringify(posted);
            if (JSON.stringify(entry.effects) !== newEffects) {
              entry.effects = JSON.parse(newEffects);
              changed = true;
            }
          } else if (entry.effects) {
            delete entry.effects;
            changed = true;
          }
        }
        if (changed) {
          writeFileSync(scenesPath, JSON.stringify(scenes, null, 2) + '\n', 'utf-8');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed }));
        return;
      }

      // Save camera moves to .timing.camera-moves.json
      if (url === '/api/camera-moves' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const moves = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as CameraMove[];
        const cameraMovesPath = join(demoDir, '.timing.camera-moves.json');
        writeFileSync(cameraMovesPath, JSON.stringify(moves, null, 2) + '\n', 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Save timing marks to .timing.json
      if (url === '/api/save-timing' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const { timing } = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as { timing: Record<string, number> };
        const timingPath = join(demoDir, '.timing.json');
        // Read existing timing to merge (preserves any extra keys)
        const existing = readJsonFile<Record<string, number>>(timingPath, {});
        // If the pipeline applied head-trimming, shift new timing marks back to raw timeline
        const metaPath = join(outputDir, `${demoName}.meta.json`);
        const meta = existsSync(metaPath) ? readJsonFile<Record<string, any>>(metaPath, {}) : {};
        const headTrimMs: number = meta?.export?.headTrimMs ?? 0;
        const rawTiming: Record<string, number> = {};
        for (const [scene, ms] of Object.entries(timing)) {
          rawTiming[scene] = ms + headTrimMs;
        }
        const merged = { ...existing, ...rawTiming };
        writeFileSync(timingPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Regenerate a single TTS clip
      if (url === '/api/regen-clip' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const { scene } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const manifestPath = join(demosDir, `${demoName}.scenes.json`);
        const regenerateTts = options.regenerateTts ?? ((args: { manifestPath: string }) => runPreviewTtsGenerate(args.manifestPath));
        await regenerateTts({ manifestPath, scene });

        const refreshed = refreshPreviewAudioArtifacts(demoName, argoDir, demosDir, options.ttsDefaults);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          scene,
          durationMs: refreshed.sceneDurations[scene] ?? 0,
          sceneDurations: refreshed.sceneDurations,
          sceneReport: refreshed.sceneReport,
        }));
        return;
      }

      // Re-record: run the full pipeline
      if (url === '/api/rerecord' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
        try {
          await new Promise<void>((resolve, reject) => {
            const child = execFile('npx', ['argo', 'pipeline', demoName], {
              env: process.env,
            }, (err, stdout, stderr) => {
              if (err) reject(new Error(stderr || stdout || err.message));
              else resolve();
            });
          });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
        return;
      }

      // Export-only: re-align audio + chapters + subtitles + export MP4 (no re-recording)
      if (url === '/api/export' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
        try {
          checkFfmpeg();
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const bodyText = Buffer.concat(chunks).toString('utf-8').trim();
          const body = bodyText ? JSON.parse(bodyText) as { includeBgm?: boolean; musicVolume?: number } : {};

          // Generate TTS clips for any scenes with text (auto-regen before export)
          const manifestPath = join(demosDir, `${demoName}.scenes.json`);
          try {
            await runPreviewTtsGenerate(manifestPath);
          } catch (ttsErr) {
            console.warn(`Warning: TTS generation failed, exporting without voiceover: ${(ttsErr as Error).message}`);
          }

          // Refresh aligned audio from current clips + timing
          const refreshed = refreshPreviewAudioArtifacts(demoName, argoDir, demosDir, options.ttsDefaults);

          // Read timing for head-trim + placement computation
          const timing = readJsonFile<Record<string, number>>(join(demoDir, '.timing.json'), {});
          const markTimes = Object.values(timing);
          let headTrimMs = 0;
          if (!importedVideo && markTimes.length > 0) {
            const firstMarkMs = Math.min(...markTimes);
            headTrimMs = Math.max(0, firstMarkMs - 200);
            if (headTrimMs <= 500) headTrimMs = 0;
          }

          // Compute shifted placements for chapters + subtitles
          const placements = refreshed.sceneReport?.scenes?.map(s => ({
            scene: s.scene, startMs: s.startMs - headTrimMs, endMs: s.endMs - headTrimMs,
          })) ?? [];

          // Get video duration
          const { execFileSync } = await import('node:child_process');
          const rawDur = execFileSync('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', rawVideoPath,
          ], { encoding: 'utf-8' }).trim();
          const totalDurationMs = Math.round(parseFloat(rawDur) * 1000);
          const shiftedDurationMs = totalDurationMs - headTrimMs;

          // Generate chapters
          const chapterMetadataPath = join(demoDir, 'chapters.txt');
          writeFileSync(chapterMetadataPath, generateChapterMetadata(placements, shiftedDurationMs), 'utf-8');

          // Generate subtitles
          const scenesPath = join(demosDir, `${demoName}.scenes.json`);
          const scenes = readJsonFile<Array<any>>(scenesPath, []);
          const sceneTexts: Record<string, string> = {};
          for (const entry of scenes) {
            if (entry.scene && entry.text) sceneTexts[entry.scene] = entry.text;
          }
          const { mkdirSync } = await import('node:fs');
          mkdirSync(outputDir, { recursive: true });

          // Apply speed ramp to timeline if configured (must happen before
          // chapters/subtitles/export so all artifacts reflect ramped timing)
          const ec = options.exportConfig;
          const includeBgm = body.includeBgm !== false;
          const requestedMusicVolume = typeof body.musicVolume === 'number' && Number.isFinite(body.musicVolume)
            ? Math.max(0, Math.min(1, body.musicVolume))
            : (ec?.musicVolume ?? 0.15);
          const exportMusicPath = includeBgm ? (activeMusicPath ?? ec?.musicPath) : undefined;
          const effectiveSpeedRamp = importedVideo ? undefined : ec?.speedRamp;
          // Read per-scene playback speeds from manifest (same as pipeline)
          const sceneSpeeds: Record<string, number> = {};
          for (const entry of scenes) {
            if (entry.scene && typeof (entry as any).playbackSpeed === 'number' && (entry as any).playbackSpeed !== 1.0) {
              sceneSpeeds[entry.scene] = (entry as any).playbackSpeed;
            }
          }
          const hasSceneSpeeds = Object.keys(sceneSpeeds).length > 0 ? sceneSpeeds : undefined;
          const rampResult = applySpeedRampToTimeline(placements, shiftedDurationMs, effectiveSpeedRamp, hasSceneSpeeds);
          const finalPlacements = rampResult.placements;
          const finalDurationMs = rampResult.totalDurationMs;
          const speedRampSegments = rampResult.segments.length > 0 ? rampResult.segments : undefined;

          // Regenerate chapters/subtitles with ramped timing
          writeFileSync(chapterMetadataPath, generateChapterMetadata(finalPlacements, finalDurationMs), 'utf-8');
          try {
            writeFileSync(join(outputDir, `${demoName}.srt`), generateSrt(finalPlacements, sceneTexts), 'utf-8');
            writeFileSync(join(outputDir, `${demoName}.vtt`), generateVtt(finalPlacements, sceneTexts), 'utf-8');
          } catch { /* subtitles are best-effort */ }

          // Resolve freeze-frame holds from scenes manifest
          const previewFreezeSpecs: FreezeSpec[] = [];
          for (const entry of scenes) {
            if (!entry.scene || !Array.isArray(entry.post)) continue;
            for (const effect of entry.post) {
              if (effect.type === 'freeze' && typeof effect.atMs === 'number' && typeof effect.durationMs === 'number') {
                previewFreezeSpecs.push({ scene: entry.scene, atMs: effect.atMs, durationMs: effect.durationMs });
              }
            }
          }
          const previewResolvedFreezes = resolveFreezes(previewFreezeSpecs, finalPlacements);
          let freezeAdjustedPlacements = finalPlacements;
          let freezeAdjustedDurationMs = finalDurationMs;
          if (previewResolvedFreezes.length > 0) {
            freezeAdjustedPlacements = adjustPlacementsForFreezes(finalPlacements, previewResolvedFreezes);
            freezeAdjustedDurationMs += totalFreezeDurationMs(previewResolvedFreezes);
            // Regenerate chapters/subtitles with freeze-adjusted timing
            writeFileSync(chapterMetadataPath, generateChapterMetadata(freezeAdjustedPlacements, freezeAdjustedDurationMs), 'utf-8');
            try {
              writeFileSync(join(outputDir, `${demoName}.srt`), generateSrt(freezeAdjustedPlacements, sceneTexts), 'utf-8');
              writeFileSync(join(outputDir, `${demoName}.vtt`), generateVtt(freezeAdjustedPlacements, sceneTexts), 'utf-8');
            } catch { /* best-effort */ }
          }

          // Read camera moves if recorded by zoomTo with narration option
          let cameraMoves: CameraMove[] | undefined;
          const cameraMovesPath = join(demoDir, '.timing.camera-moves.json');
          try {
            if (existsSync(cameraMovesPath)) {
              let moves: CameraMove[] = JSON.parse(readFileSync(cameraMovesPath, 'utf-8'));
              if (headTrimMs > 0) moves = shiftCameraMoves(moves, headTrimMs);
              // Same trip the pipeline and CLI paths make; see exportTimelineRemap.
              moves = remapCameraMoves(
                moves,
                exportTimelineRemap(
                  (timeMs) => remapTimeMs(timeMs, speedRampSegments ?? []),
                  previewResolvedFreezes,
                ),
              );
              const captureW = ec?.captureWidth ?? ec?.outputWidth ?? 1920;
              const captureH = ec?.captureHeight ?? ec?.outputHeight ?? 1080;
              const outW = ec?.outputWidth ?? captureW;
              const outH = ec?.outputHeight ?? captureH;
              moves = scaleCameraMoves(moves, outW / captureW, outH / captureH);
              if (moves.length > 0) cameraMoves = moves;
            }
          } catch { /* optional */ }

          // Render overlay PNGs for imported videos (no Playwright recording step).
          const overlayPngs = await buildOverlayPngsForImport({
            argoDir,
            demoName,
            manifestPath: scenesPath,
            placements: freezeAdjustedPlacements,
            videoWidth: ec?.outputWidth ?? 1920,
            videoHeight: ec?.outputHeight ?? 1080,
            deviceScaleFactor: ec?.deviceScaleFactor,
          });

          // Resolve frame config: sidecar overrides repo config (matches loadPreviewData)
          const frameConfig = readJsonFile<import('./config.js').FrameConfig>(
            join(argoDir, demoName, 'frame-config.json'), null as any,
          ) ?? ec?.frame;

          // Pre-render frame PNG if frame config is set (matches pipeline flow)
          // Skip pre-render for 'auto' and 'image' backgrounds — generateFramePng
          // can't handle them; exportVideo resolves auto by probing edge colors,
          // and buildFrameFilter falls back to inline for image.
          let framePngPath: string | undefined;
          const bgType = frameConfig?.background?.type;
          if (frameConfig && (frameConfig.padding ?? 40) > 0 && bgType !== 'auto' && bgType !== 'image') {
            const outW = ec?.outputWidth ?? 1920;
            const outH = ec?.outputHeight ?? 1080;
            const pngPath = join(argoDir, demoName, 'frame.png');
            const pngResult = generateFramePng(pngPath, outW, outH, frameConfig);
            if (pngResult) framePngPath = pngResult;
          }

          // Pre-render shader transition frames when transition type is 'shader'
          let previewShaderTransitions: ShaderTransitionRenderResult[] | undefined;
          if (
            ec?.transition?.type === 'shader' &&
            freezeAdjustedPlacements.length > 1 &&
            rawVideoPath
          ) {
            const shaderTransition = ec.transition;
            // freezeAdjustedPlacements are post-trim; frame extraction needs pre-trim timestamps
            const shaderBoundaries = freezeAdjustedPlacements.slice(1).map(p => ({
              boundarySec: (p.startMs + headTrimMs) / 1000,
              durationMs: shaderTransition.durationMs ?? 800,
            }));
            const rendered = await renderShaderTransitions({
              videoPath: rawVideoPath,
              boundaries: shaderBoundaries,
              shader: shaderTransition.shader,
              width: ec?.outputWidth ?? 1280,
              height: ec?.outputHeight ?? 720,
              fps: ec?.fps ?? 30,
              cacheDir: join(demoDir, 'shaders'),
            });
            // Remap boundarySec to post-trim for the filter_complex splice
            previewShaderTransitions = rendered.map((r, i) => ({
              ...r,
              boundarySec: freezeAdjustedPlacements[i + 1].startMs / 1000,
            }));
          }

          // Export — use full config so output matches argo pipeline
          await exportVideo({
            demoName,
            argoDir,
            outputDir,
            preset: ec?.preset,
            crf: ec?.crf,
            fps: ec?.fps,
            outputWidth: ec?.outputWidth,
            outputHeight: ec?.outputHeight,
            deviceScaleFactor: ec?.deviceScaleFactor,
            thumbnailPath: ec?.thumbnailPath,
            chapterMetadataPath,
            formats: ec?.formats,
            transition: ec?.transition,
            placements: freezeAdjustedPlacements,
            totalDurationMs: freezeAdjustedDurationMs,
            headTrimMs: headTrimMs > 0 ? headTrimMs : undefined,
            speedRampSegments,
            loudnorm: ec?.loudnorm,
            musicPath: exportMusicPath,
            musicVolume: requestedMusicVolume,
            cameraMoves,
            watermark: ec?.watermark,
            sharpen: ec?.sharpen,
            frame: frameConfig,
            framePngPath,
            motionBlur: ec?.motionBlur,
            freezeSpecs: previewResolvedFreezes.length > 0 ? previewResolvedFreezes : undefined,
            overlayPngs,
            shaderTransitions: previewShaderTransitions,
            encoder: ec?.encoder,
            encoderDefault: 'gpu',
          });

          // Switch to serving the new MP4
          const newMp4 = join(outputDir, `${demoName}.mp4`);
          if (existsSync(newMp4)) {
            videoPath = newMp4;
            videoMime = 'video/mp4';
          }
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
        return;
      }

      // Serve the MusicGen Web Worker script (same-origin so ESM imports work)
      if (url === '/musicgen-worker.js') {
        const workerScript = `
import { AutoTokenizer, MusicgenForConditionalGeneration } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0-next.7';

let tokenizer = null;
let model = null;
let backend = null;

const WEBGPU_DTYPE = {
  text_encoder: 'q4',
  decoder_model_merged: 'q4',
  encodec_decode: 'fp32',
};

const WASM_DTYPE = {
  text_encoder: 'q8',
  decoder_model_merged: 'q8',
  encodec_decode: 'fp32',
};

async function ensureTokenizer() {
  if (tokenizer) return;
  self.postMessage({ type: 'progress', message: 'Loading MusicGen tokenizer...' });
  tokenizer = await AutoTokenizer.from_pretrained('Xenova/musicgen-small');
}

async function loadModel(preferredBackend = 'webgpu') {
  await ensureTokenizer();

  if (preferredBackend === 'webgpu' && typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      self.postMessage({ type: 'progress', message: 'Loading model weights (~450MB first time)...' });
      model = await MusicgenForConditionalGeneration.from_pretrained('Xenova/musicgen-small', {
        dtype: WEBGPU_DTYPE,
        device: 'webgpu',
      });
      backend = 'webgpu';
      self.postMessage({ type: 'progress', message: 'Model loaded (WebGPU).' });
      return;
    } catch (err) {
      self.postMessage({
        type: 'progress',
        message: 'WebGPU init failed, falling back to CPU/WASM...',
      });
      model = null;
      backend = null;
    }
  }

  self.postMessage({ type: 'progress', message: 'Loading model weights on CPU/WASM...' });
  model = await MusicgenForConditionalGeneration.from_pretrained('Xenova/musicgen-small', {
    dtype: WASM_DTYPE,
  });
  backend = 'wasm';
  self.postMessage({ type: 'progress', message: 'Model loaded (CPU/WASM).' });
}

function shouldRetryOnWasm(err) {
  const msg = err?.message || String(err);
  return backend === 'webgpu' && /(OrtRun|webgpu|TensorShape|Cannot reduce shape|ERROR_CODE:\\s*1)/i.test(msg);
}

async function generateAudio(prompt, durationSec, guidanceScale, temperature) {
  if (!model) await loadModel();

  const inputs = tokenizer(prompt);
  const maxNewTokens = Math.ceil(durationSec * 50);

  try {
    return await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: true,
      guidance_scale: guidanceScale,
      temperature,
    });
  } catch (err) {
    if (!shouldRetryOnWasm(err)) throw err;

    self.postMessage({
      type: 'progress',
      message: 'WebGPU generation failed, retrying on CPU/WASM...',
    });
    model = null;
    await loadModel('wasm');
    return await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: true,
      guidance_scale: guidanceScale,
      temperature,
    });
  }
}

self.onmessage = async (e) => {
  if (e.data.type === 'generate') {
    try {
      const durationSec = e.data.durationSec || 30;
      const guidanceScale = e.data.guidanceScale || 3;
      const temperature = e.data.temperature || 1.0;
      self.postMessage({ type: 'progress', message: 'Generating ' + durationSec + 's of music...' });
      const output = await generateAudio(
        e.data.prompt,
        durationSec,
        guidanceScale,
        temperature,
      );
      const audioData = output.data instanceof Float32Array ? output.data : new Float32Array(output.data);
      const sampleRate = model?.config?.audio_encoder?.sampling_rate || 32000;
      self.postMessage({ type: 'complete', audioData, sampleRate }, [audioData.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
  }
};
`;
        res.writeHead(200, {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-store',
        });
        res.end(workerScript);
        return;
      }

      // Save generated background music WAV — overwrites previous to avoid orphans
      if (url === '/api/save-music' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const wavData = Buffer.concat(chunks);
        const musicDir = join(demoDir, 'music');
        mkdirSync(musicDir, { recursive: true });
        const filePath = join(musicDir, 'bgm.wav');
        writeFileSync(filePath, wavData);
        // Track the active music path so /api/export uses it
        activeMusicPath = filePath;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: filePath }));
        return;
      }

      // --- Static file serving ---

      // Serve video with Range request support (required for seeking)
      if (url === '/video' || url === '/video.webm') {
        serveFileWithRanges(req, res, videoPath!, videoMime);
        return;
      }

      // Serve narration-aligned.wav
      if (url === '/narration-aligned.wav') {
        serveFile(res, join(demoDir, 'narration-aligned.wav'));
        return;
      }

      // Serve individual clips: /clips/scene-name.wav
      if (url.startsWith('/clips/')) {
        const clipFile = url.slice('/clips/'.length);
        const clipsDir = join(demoDir, 'clips');
        const clipPath = resolveClipPath(clipsDir, clipFile);
        if (clipPath && existsSync(clipPath)) {
          serveFile(res, clipPath);
        } else {
          res.writeHead(404);
          res.end('Clip not found');
        }
        return;
      }

      // Live frame from page.screencast onFrame — populated only while a
      // recording is active. Returns 404 + 'Cache-Control: no-store' when
      // absent so the polling client can reliably probe.
      if (url.startsWith('/live-frame.jpg')) {
        const livePath = join(demoDir, '.live-frame.jpg');
        if (existsSync(livePath)) {
          res.setHeader('Cache-Control', 'no-store');
          serveFile(res, livePath);
        } else {
          res.writeHead(404, { 'Cache-Control': 'no-store' });
          res.end('No live frame');
        }
        return;
      }

      // Per-scene thumbnails captured at narration.mark() time.
      if (url.startsWith('/thumbs/')) {
        const file = url.slice('/thumbs/'.length).split('?')[0];
        // Bound the filename to a single segment + .jpg to prevent traversal.
        if (!/^[a-zA-Z0-9._-]+\.jpg$/.test(file)) {
          res.writeHead(400);
          res.end('Bad thumb name');
          return;
        }
        const thumbPath = join(demoDir, 'thumbs', file);
        if (existsSync(thumbPath)) {
          serveFile(res, thumbPath);
        } else {
          res.writeHead(404);
          res.end('Thumb not found');
        }
        return;
      }

      // Root — serve the preview HTML
      if (url === '/' || url === '/index.html') {
        const data = loadPreviewData(demoName, argoDir, demosDir, outputDir, options.exportConfig, activeMusicPath);
        const html = getPreviewHtml(data);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      const assignedPort = typeof addr === 'object' && addr ? addr.port : port;
      const serverUrl = `http://127.0.0.1:${assignedPort}`;
      resolve({
        url: serverUrl,
        close: () => server.close(),
      });
    });
  });
}

function serveFileWithRanges(req: IncomingMessage, res: ServerResponse, filePath: string, mime: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const stat = statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    let start: number;
    let end: number;

    if (match[1] === '' && match[2] === '') {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    if (match[1] === '') {
      const suffixLength = Number.parseInt(match[2], 10);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` });
        res.end();
        return;
      }
      start = Math.max(0, total - suffixLength);
      end = total - 1;
    } else {
      start = Number.parseInt(match[1], 10);
      end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= total || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    end = Math.min(end, total - 1);
    const chunkSize = end - start + 1;
    const stream = createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end('Failed to read file');
    });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mime,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
    });
    createReadStream(filePath).pipe(res);
  }
}

function serveFile(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
  const content = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
  res.end(content);
}

// ─── Inline HTML for the preview viewer ────────────────────────────────────

const PREVIEW_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Argo Preview</title>
<style>
  :root {
    --bg: #0c0c0c;
    --surface: #161616;
    --surface2: #1e1e1e;
    --surface3: #262626;
    --border: #2a2a2a;
    --border-subtle: #222;
    --text: #e8e8e8;
    --text-muted: #777;
    --text-dim: #555;
    --accent: #6366f1;
    --accent-hover: #818cf8;
    --accent-glow: rgba(99,102,241,0.15);
    --accent-glow-strong: rgba(99,102,241,0.3);
    --success: #22c55e;
    --success-glow: rgba(34,197,94,0.15);
    --warning: #f59e0b;
    --error: #ef4444;
    --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    --sans: system-ui, -apple-system, sans-serif;
    --radius: 6px;
    --transition: 0.15s ease;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f5f5f5;
      --surface: #ffffff;
      --surface2: #f0f0f0;
      --surface3: #e8e8e8;
      --border: #d4d4d4;
      --border-subtle: #e0e0e0;
      --text: #1a1a1a;
      --text-muted: #666;
      --text-dim: #999;
      --accent: #4f46e5;
      --accent-hover: #6366f1;
      --accent-glow: rgba(79,70,229,0.1);
      --accent-glow-strong: rgba(79,70,229,0.2);
      --success: #16a34a;
      --success-glow: rgba(22,163,74,0.1);
      --warning: #d97706;
      --error: #dc2626;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: grid;
    grid-template-columns: 1fr 380px;
    grid-template-rows: auto 1fr;
    gap: 0;
    overflow: hidden;
  }

  /* Header */
  header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 16px; font-weight: 600; }
  header .demo-name { color: var(--accent); }
  header .actions { margin-left: auto; display: flex; gap: 8px; }
  header .trace-link {
    font-size: 12px;
    color: var(--text-muted);
    text-decoration: none;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  header .trace-link:hover { color: var(--text); border-color: var(--text-muted); }

  /* Toggle switches */
  .toggle-switch {
    position: relative;
    width: 32px;
    height: 18px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .toggle-switch input { display: none; }
  .toggle-switch .slider {
    position: absolute;
    inset: 0;
    background: var(--surface3);
    border-radius: 9px;
    transition: background var(--transition);
  }
  .toggle-switch .slider::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: transform var(--transition), background var(--transition);
  }
  .toggle-switch input:checked + .slider { background: var(--accent); }
  .toggle-switch input:checked + .slider::after { transform: translateX(14px); background: white; }
  .toggle-label {
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Main viewer */
  .viewer {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }
  .video-container {
    flex: 1;
    position: relative;
    background: #000;
    display: flex;
    overflow: hidden;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .video-container video {
    max-width: 100%;
    max-height: 100%;
    display: block;
    cursor: pointer;
  }

  /* Overlay preview layer — positioned over the video */
  .overlay-layer {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    pointer-events: none;
  }
  .overlay-cue {
    position: absolute;
    z-index: 10;
    pointer-events: none;
    font-family: system-ui, -apple-system, sans-serif;
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  .overlay-cue.visible { opacity: 1; }
  .overlay-cue .preview-badge {
    position: absolute;
    top: -8px;
    right: -8px;
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: #fff;
    background: var(--accent);
    padding: 2px 6px;
    border-radius: 3px;
    line-height: 1;
    opacity: 0.85;
  }

  /* Zone positioning */
  .overlay-cue[data-zone="bottom-center"] { bottom: 60px; left: 50%; transform: translateX(-50%); }
  .overlay-cue[data-zone="top-left"] { top: 40px; left: 40px; }
  .overlay-cue[data-zone="top-right"] { top: 40px; right: 40px; }
  .overlay-cue[data-zone="bottom-left"] { bottom: 60px; left: 40px; }
  .overlay-cue[data-zone="bottom-right"] { bottom: 60px; right: 40px; }
  .overlay-cue[data-zone="center"] { top: 50%; left: 50%; transform: translate(-50%, -50%); }

  /* Drag-to-snap overlay positioning */
  .overlay-cue.overlay-draggable {
    cursor: grab;
    user-select: none;
    /* pointer-events only on visible overlays — invisible ones must not intercept clicks */
  }
  .overlay-cue.overlay-draggable.visible {
    pointer-events: auto;
  }
  .overlay-cue.overlay-draggable:active {
    cursor: grabbing;
  }
  .overlay-cue.overlay-dragging {
    cursor: grabbing;
    opacity: 0.85;
    z-index: 20;
  }
  .snap-zone {
    position: absolute;
    border: 2px dashed rgba(99, 102, 241, 0.4);
    border-radius: 8px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 15;
  }
  .snap-zone.visible {
    opacity: 1;
  }
  .snap-zone.highlight {
    background: rgba(99, 102, 241, 0.15);
    border-color: rgba(99, 102, 241, 0.8);
  }
  .snap-zone-label {
    position: absolute;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 11px;
    color: rgba(99, 102, 241, 0.8);
    font-family: var(--mono);
    white-space: nowrap;
  }

  /* Timeline bar */
  .timeline {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 12px 20px;
  }
  .waveform-strip {
    position: relative;
    height: 56px;
    background: var(--surface2);
    border-radius: 6px;
    margin-bottom: 6px;
    overflow: hidden;
    cursor: pointer;
  }
  #waveform-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    pointer-events: none;
  }
  .waveform-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--text);
    z-index: 5;
    pointer-events: none;
    transition: left 0.05s linear;
    opacity: 0.85;
  }
  .waveform-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--mono);
    pointer-events: none;
  }
  .waveform-strip.has-data .waveform-empty { display: none; }
  .timeline-bar {
    position: relative;
    height: 32px;
    background: var(--surface2);
    border-radius: 6px;
    cursor: pointer;
    overflow: visible;
  }
  .timeline-progress {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    background: var(--accent);
    border-radius: 6px 0 0 6px;
    opacity: 0.3;
    pointer-events: none;
  }
  .timeline-scene {
    position: absolute;
    top: 0;
    height: 100%;
    display: flex;
    align-items: center;
    padding: 0 8px;
    font-size: 11px;
    font-family: var(--mono);
    font-weight: 500;
    color: var(--text-muted);
    border-left: 2px solid var(--accent);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--accent-glow);
    transition: background var(--transition);
  }
  .timeline-scene:nth-child(odd) { background: rgba(99,102,241,0.08); }
  .timeline-scene:nth-child(even) { background: rgba(99,102,241,0.12); }
  .timeline-scene:hover { color: var(--text); background: var(--accent-glow-strong); }
  .timeline-scene.active { color: var(--text); background: var(--accent-glow-strong); }
  .timeline-scene .has-overlay {
    display: inline-block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    margin-left: 4px;
    vertical-align: middle;
  }
  .timeline-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--text);
    z-index: 5;
    pointer-events: none;
    transition: left 0.05s linear;
  }
  .timeline-time {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    font-family: var(--mono);
    color: var(--text-muted);
    margin-top: 4px;
    padding: 0 4px;
  }

  /* Audio controls */
  .audio-controls {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  .audio-controls .toggle-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Sidebar */
  .sidebar {
    background: var(--surface);
    border-left: 1px solid var(--border);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .sidebar-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-tab {
    flex: 1;
    padding: 10px 16px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
  }
  .sidebar-tab:hover { color: var(--text); }
  .sidebar-tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .sidebar-panel { overflow-y: auto; flex: 1; }

  /* Music panel */
  .music-panel {
    border-top: 1px solid var(--border);
    padding: 0;
  }
  .music-panel-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .music-panel-header:hover { color: var(--text); }
  .music-panel-header .expand-icon {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-dim);
    transition: transform var(--transition);
  }
  .music-panel.expanded .music-panel-header .expand-icon { transform: rotate(90deg); }
  .music-panel-body {
    display: none;
    padding: 0 16px 16px;
  }
  .music-panel.expanded .music-panel-body { display: block; }
  .music-prompt-input {
    width: 100%;
    padding: 8px 10px;
    font-family: var(--sans);
    font-size: 13px;
    color: var(--text);
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    outline: none;
    resize: vertical;
    min-height: 36px;
    margin-bottom: 8px;
  }
  .music-prompt-input:focus { border-color: var(--accent); }
  .music-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 10px;
  }
  .music-preset-btn {
    padding: 4px 8px;
    font-size: 11px;
    font-family: var(--sans);
    color: var(--text-muted);
    background: var(--surface3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  .music-preset-btn:hover { background: var(--accent-glow); color: var(--text); }
  .music-duration-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .music-duration-row input[type="range"] {
    flex: 1;
    accent-color: var(--accent);
  }
  .music-option-row,
  .music-volume-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .music-option-row {
    justify-content: space-between;
  }
  .music-volume-row input[type="range"] {
    flex: 1;
    accent-color: var(--accent);
  }
  .music-volume-value {
    min-width: 40px;
    text-align: right;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text);
  }
  .music-help {
    margin-bottom: 10px;
    font-size: 11px;
    color: var(--text-dim);
    line-height: 1.4;
  }
  .music-duration-row .music-dur-label {
    min-width: 32px;
    text-align: right;
    font-family: var(--mono);
    font-size: 11px;
  }
  .music-generate-btn, .music-save-btn {
    width: 100%;
    padding: 8px 0;
    font-size: 13px;
    font-weight: 600;
    font-family: var(--sans);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background var(--transition), opacity var(--transition);
  }
  .music-generate-btn {
    background: var(--accent);
    color: white;
    margin-bottom: 8px;
  }
  .music-generate-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .music-generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .music-save-btn {
    background: var(--success);
    color: white;
    display: none;
  }
  .music-save-btn:hover:not(:disabled) { opacity: 0.85; }
  .music-save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .music-progress {
    margin-bottom: 8px;
    display: none;
  }
  .music-progress-bar {
    width: 100%;
    height: 4px;
    background: var(--surface3);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 4px;
  }
  .music-progress-fill {
    height: 100%;
    background: var(--accent);
    width: 0%;
    transition: width 0.3s ease;
  }
  .music-progress-text {
    font-size: 11px;
    font-family: var(--mono);
    color: var(--text-muted);
  }
  .music-audio-player {
    width: 100%;
    margin-bottom: 8px;
    display: none;
    height: 36px;
  }
  .music-status {
    font-size: 11px;
    font-family: var(--mono);
    color: var(--text-muted);
    margin-top: 4px;
    min-height: 16px;
  }

  /* Frame & Background panel */
  .frame-panel {
    border-top: 1px solid var(--border);
    padding: 0;
  }
  .frame-panel-header {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .frame-panel-header:hover { color: var(--text); }
  .frame-panel-header .expand-icon {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-dim);
    transition: transform var(--transition);
  }
  .frame-panel.expanded .frame-panel-header .expand-icon { transform: rotate(90deg); }
  .frame-panel-body {
    display: none;
    padding: 0 16px 16px;
  }
  .frame-panel.expanded .frame-panel-body { display: block; }
  .frame-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .frame-row label, .frame-color-row label { min-width: 80px; flex-shrink: 0; cursor: help; }
  .frame-row label[title]:hover, .frame-color-row label[title]:hover { text-decoration: underline dotted; text-underline-offset: 2px; }
  .frame-row input[type="range"] { flex: 1; accent-color: var(--accent); }
  .frame-row .frame-value { min-width: 36px; text-align: right; font-family: var(--mono); font-size: 11px; }
  .frame-bg-type {
    width: 100%;
    padding: 6px 8px;
    font-size: 12px;
    font-family: var(--sans);
    color: var(--text);
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
  }
  .frame-color-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .frame-color-row label { font-size: 12px; color: var(--text-muted); min-width: 80px; }
  .frame-color-row input[type="color"] {
    width: 32px; height: 24px; border: 1px solid var(--border);
    border-radius: 4px; padding: 0; cursor: pointer; background: none;
  }
  .frame-color-row input[type="text"] {
    flex: 1; padding: 4px 8px; font-size: 12px; font-family: var(--mono);
    color: var(--text); background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .frame-gradient-row { margin-bottom: 10px; }
  .frame-gradient-row label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }
  .frame-gradient-stops {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .frame-gradient-stops input[type="color"] {
    width: 32px; height: 24px; border: 1px solid var(--border);
    border-radius: 4px; padding: 0; cursor: pointer; background: none;
  }
  .frame-gradient-stops input[type="number"] {
    width: 56px; padding: 4px 6px; font-size: 12px; font-family: var(--mono);
    color: var(--text); background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .frame-auto-swatch {
    display: inline-block;
    width: 24px; height: 24px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .frame-preview-enabled {
    font-size: 11px;
    color: var(--accent);
    margin-top: 4px;
  }

  /* Live frame preview overlay on video container */
  .video-container.frame-preview {
    background: transparent;
  }
  .frame-preview-bg {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
  }
  .video-container.frame-preview video {
    border-radius: var(--frame-radius, 0px);
    box-shadow: var(--frame-shadow, none);
    z-index: 1;
  }

  .scene-card {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
    border-left: 3px solid transparent;
  }
  .scene-card:hover { background: var(--surface2); }
  .scene-card.active { background: var(--accent-glow); border-left-color: var(--accent); }
  .scene-card.modified { border-left-color: var(--warning); }
  .scene-card.active.modified { border-left-color: var(--warning); }
  .scene-card .scene-body { display: none; }
  .scene-card.expanded .scene-body { display: block; }
  .scene-card .scene-name .expand-icon {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-dim);
    transition: transform var(--transition);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .scene-card .scene-name .expand-icon:hover {
    color: var(--text);
    background: var(--surface3);
  }
  .scene-card.expanded .scene-name .expand-icon { transform: rotate(90deg); }
  .scene-card .scene-name {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scene-card .scene-time {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 400;
  }
  .scene-card .scene-duration {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .add-scene-btn {
    width: 100%;
    padding: 10px;
    margin-bottom: 12px;
    background: var(--bg-card, var(--surface));
    border: 2px dashed var(--border);
    border-radius: 10px;
    color: var(--text-muted);
    cursor: pointer;
    font-family: var(--mono);
    font-size: 0.85rem;
    transition: all 0.2s;
  }
  .add-scene-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* Editable fields */
  .field-group { margin-top: 8px; }
  .field-group label {
    display: block;
    font-size: 11px;
    color: var(--text-muted);
    margin-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .field-group textarea, .field-group input, .field-group select {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
  }
  .field-group textarea { min-height: 50px; }
  .field-group textarea:focus, .field-group input:focus, .field-group select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-glow);
  }
  .hint-text {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    margin-top: 2px;
  }
  .scene-scrub input[type="range"] {
    -webkit-appearance: none;
    width: 100%;
    height: 4px;
    background: var(--surface3);
    border-radius: 2px;
    border: 0;
    padding: 0;
    outline: none;
  }
  .scene-scrub input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--surface);
  }
  .scene-scrub input[type="range"]::-webkit-slider-thumb:hover {
    background: var(--accent-hover);
    transform: scale(1.2);
  }
  .scene-scrub-meta {
    display: flex;
    justify-content: space-between;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface2);
    color: var(--text);
    cursor: pointer;
    transition: all var(--transition);
  }
  .btn:hover:not(:disabled) { border-color: var(--text-muted); transform: translateY(-1px); }
  .btn:active:not(:disabled) { transform: translateY(0); }
  .btn-accent {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .btn-accent:hover { opacity: 0.9; }
  .btn-save {
    background: var(--success);
    border-color: var(--success);
    color: #000;
    font-weight: 600;
  }
  .btn-save:hover:not(:disabled) { background: #16a34a; }
  .btn-save.dirty {
    background: var(--warning);
    border-color: var(--warning);
    color: #000;
    animation: pulse-save 2s ease-in-out infinite;
  }
  @keyframes pulse-save {
    0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
    50% { box-shadow: 0 0 8px 2px rgba(245, 158, 11, 0.3); }
  }
  .btn-save.saved {
    background: transparent;
    border-color: var(--success);
    color: var(--success);
  }
  .btn-undo {
    background: transparent;
    border-color: var(--warning);
    color: var(--warning);
    font-size: 11px;
    padding: 4px 10px;
  }
  .btn-undo:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.1);
  }
  .btn-rerecord {
    background: transparent;
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 500;
  }
  .btn-rerecord:hover:not(:disabled) {
    background: var(--accent-glow);
  }
  .btn-rerecord:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .btn-play {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-row { display: flex; gap: 6px; margin-top: 8px; }
  .btn-group {
    display: inline-flex;
    gap: 0;
  }
  .btn-group .btn {
    border-radius: 0;
  }
  .btn-group .btn:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  .btn-group .btn:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
  .btn-group .btn + .btn { border-left: 0; }

  /* Status indicator */
  .status {
    padding: 8px 16px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    margin-top: auto;
  }
  .status.saving { color: var(--warning); }
  .status.saved { color: var(--success); }
  .status.error { color: var(--error); }

  /* Overlay type selector */
  .overlay-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .overlay-section .section-title {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
  }

  .camera-moves-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .camera-moves-section .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .camera-move-entry { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; padding: 6px 8px; background: var(--card); border-radius: 6px; border: 1px solid var(--border); }
  .camera-move-entry label { font-size: 10px; color: var(--muted); display: block; }
  .camera-move-entry input { width: 60px; }
  .camera-move-entry .btn-target { background: var(--accent); color: #fff; border: none; border-radius: 4px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .camera-move-entry .btn-target.active { background: #ef4444; }
  .timeline-camera-move { position: absolute; bottom: 0; height: 5px; background: rgba(245,158,11,0.4); border-radius: 2px; pointer-events: auto; cursor: pointer; z-index: 2; }
  .timeline-camera-move:hover { background: rgba(245,158,11,0.7); }
  .timeline-camera-chain { position: absolute; bottom: 2px; height: 1px; background: rgba(245,158,11,0.6); pointer-events: none; z-index: 1; }
  .timeline-camera-suggestion { position: absolute; bottom: 0; height: 5px; background: rgba(168,85,247,0.25); border: 1px dashed rgba(168,85,247,0.5); border-radius: 2px; pointer-events: auto; cursor: pointer; z-index: 3; }
  .timeline-camera-suggestion:hover { background: rgba(168,85,247,0.45); }
  .suggestion-tooltip { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 11px; white-space: nowrap; z-index: 20; display: flex; gap: 6px; align-items: center; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .suggestion-tooltip .btn-accept { background: #22c55e; color: #fff; border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  .suggestion-tooltip .btn-dismiss { background: #6b7280; color: #fff; border: none; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; }
  .video-container.target-mode { cursor: crosshair; }
  .camera-region-overlay { position: absolute; border: 2px solid rgba(245,158,11,0.8); background: rgba(245,158,11,0.08); pointer-events: none; z-index: 5; border-radius: 4px; transition: all 0.15s ease-out; }
  .camera-region-overlay.target-preview { border-color: rgba(239,68,68,0.8); background: rgba(239,68,68,0.1); }
  .camera-region-label { position: absolute; top: -18px; left: 0; font-size: 10px; color: rgba(245,158,11,0.9); white-space: nowrap; }
  .effects-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .effects-section .section-title {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .effect-entry { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .effect-entry:last-child { border-bottom: none; }
  .btn-sm { padding: 2px 6px; font-size: 11px; line-height: 1; min-width: auto; }
  .btn-danger { color: var(--error); border-color: var(--error); }
  .btn-danger:hover { background: var(--error); color: #fff; }

  /* Recording overlay */
  .recording-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 99999;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    align-items: center;
    justify-content: center;
  }
  .recording-overlay.active { display: flex; }
  .recording-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 32px 40px 28px;
    text-align: center;
    max-width: 520px;
  }
  /* Live frame from page.screencast onFrame, polled while re-recording. */
  .recording-live {
    width: 440px;
    aspect-ratio: 16 / 9;
    margin: 0 auto 16px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg) center / contain no-repeat;
    display: none;
  }
  .recording-live.has-frame { display: block; }
  .recording-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    margin: 0 auto 20px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .recording-title {
    font-family: var(--mono);
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 8px;
  }
  .recording-subtitle {
    font-size: 13px;
    color: var(--text-muted);
  }
  .recording-overlay.success .recording-spinner {
    border-color: var(--success);
    border-top-color: var(--success);
    animation: none;
  }
  .recording-overlay.error .recording-spinner {
    border-color: var(--error);
    border-top-color: var(--error);
    animation: none;
  }
</style>
</head>
<body>

<header>
  <h1>Argo Preview — <span class="demo-name" id="demo-name"></span></h1>
  <div class="actions">
    <button class="btn btn-save" id="btn-save" title="Save all changes">Save</button>
    <button class="btn btn-rerecord" id="btn-export" title="Re-export video with current audio (no re-recording)">Export</button>
    <button class="btn btn-rerecord" id="btn-rerecord" title="Re-record with current manifest">Re-record</button>
  </div>
</header>

<div class="viewer">
  <div class="video-container">
    <video id="video" src="/video" preload="auto" muted playsinline></video>
    <div class="overlay-layer" id="overlay-layer"></div>
    <div class="camera-region-overlay" id="camera-region" style="display:none"><span class="camera-region-label"></span></div>
    <div class="snap-zone" data-zone="top-left" style="top:10%;left:5%;width:35%;height:35%"><span class="snap-zone-label">top-left</span></div>
    <div class="snap-zone" data-zone="top-right" style="top:10%;right:5%;width:35%;height:35%"><span class="snap-zone-label">top-right</span></div>
    <div class="snap-zone" data-zone="bottom-left" style="bottom:10%;left:5%;width:35%;height:35%"><span class="snap-zone-label">bottom-left</span></div>
    <div class="snap-zone" data-zone="bottom-right" style="bottom:10%;right:5%;width:35%;height:35%"><span class="snap-zone-label">bottom-right</span></div>
    <div class="snap-zone" data-zone="bottom-center" style="bottom:5%;left:25%;width:50%;height:20%"><span class="snap-zone-label">bottom-center</span></div>
    <div class="snap-zone" data-zone="center" style="top:30%;left:25%;width:50%;height:40%"><span class="snap-zone-label">center</span></div>
  </div>

  <div class="timeline">
    <div class="waveform-strip" id="waveform-strip">
      <canvas id="waveform-canvas"></canvas>
      <div class="waveform-playhead" id="waveform-playhead"></div>
      <div class="waveform-empty" id="waveform-empty">No narration audio yet — record or align to see the waveform.</div>
    </div>
    <div class="timeline-bar" id="timeline-bar">
      <div class="timeline-progress" id="timeline-progress"></div>
      <div class="timeline-playhead" id="timeline-playhead"></div>
    </div>
    <div class="timeline-time">
      <span id="time-current">0:00</span>
      <span id="time-total">0:00</span>
    </div>
    <div class="audio-controls">
      <button class="btn btn-play" id="btn-play" title="Play/Pause">
        <svg id="icon-play" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,1 13,8 3,15"/></svg>
        <svg id="icon-pause" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="display:none"><rect x="2" y="1" width="4" height="14"/><rect x="10" y="1" width="4" height="14"/></svg>
      </button>
      <div class="toggle-group">
        <label class="toggle-switch" title="Audio">
          <input type="checkbox" id="cb-audio" checked>
          <span class="slider"></span>
        </label>
        <span class="toggle-label">Audio</span>
      </div>
      <div class="toggle-group">
        <label class="toggle-switch" title="Overlays">
          <input type="checkbox" id="cb-overlays" checked>
          <span class="slider"></span>
        </label>
        <span class="toggle-label">Overlays</span>
      </div>
      <div class="toggle-group">
        <label class="toggle-switch" title="Camera Preview">
          <input type="checkbox" id="cb-camera" checked>
          <span class="slider"></span>
        </label>
        <span class="toggle-label">Camera</span>
      </div>
    </div>
  </div>
</div>

<div class="sidebar">
  <div class="sidebar-tabs">
    <button class="sidebar-tab active" data-tab="scenes">Scenes</button>
    <button class="sidebar-tab" data-tab="metadata">Metadata</button>
  </div>
  <div class="sidebar-panel" id="panel-scenes">
    <button id="add-scene-btn" class="add-scene-btn">+ Add scene at current time</button>
    <div id="scene-list"></div>
    <div class="music-panel" id="music-panel">
      <div class="music-panel-header" id="music-panel-header">
        Background Music
        <span class="expand-icon">&#9654;</span>
      </div>
      <div class="music-panel-body">
        <input type="text" class="music-prompt-input" id="music-prompt" placeholder="Describe the music style..." value="lofi chill ambient">
        <div class="music-presets">
          <button class="music-preset-btn" data-preset="lofi chill">lofi chill</button>
          <button class="music-preset-btn" data-preset="corporate upbeat">corporate upbeat</button>
          <button class="music-preset-btn" data-preset="ambient minimal">ambient minimal</button>
          <button class="music-preset-btn" data-preset="cinematic epic">cinematic epic</button>
          <button class="music-preset-btn" data-preset="acoustic warm">acoustic warm</button>
        </div>
        <div class="music-duration-row">
          <span>Duration</span>
          <input type="range" id="music-duration" min="10" max="60" value="10" step="5">
          <span class="music-dur-label" id="music-dur-label">10s</span>
        </div>
        <button class="music-generate-btn" id="music-generate-btn">Generate Music</button>
        <div class="music-progress" id="music-progress">
          <div class="music-progress-bar"><div class="music-progress-fill" id="music-progress-fill"></div></div>
          <div class="music-progress-text" id="music-progress-text"></div>
        </div>
        <audio class="music-audio-player" id="music-audio" controls></audio>
        <div class="music-option-row">
          <label for="music-include">Include in export</label>
          <input type="checkbox" id="music-include">
        </div>
        <div class="music-volume-row">
          <label for="music-volume">Music volume</label>
          <input type="range" id="music-volume" min="0" max="0.30" value="0.15" step="0.01">
          <span class="music-volume-value" id="music-volume-label">0.15</span>
        </div>
        <div class="music-help" id="music-help">Preview export mixes background music at a fixed low level. No re-record needed.</div>
        <button class="music-save-btn" id="music-save-btn">Use as BGM</button>
        <div class="music-status" id="music-status"></div>
      </div>
    </div>
    <div class="frame-panel" id="frame-panel">
      <div class="frame-panel-header" id="frame-panel-header">
        Frame & Background
        <span class="expand-icon">&#9654;</span>
      </div>
      <div class="frame-panel-body">
        <div class="frame-row">
          <label for="frame-padding" title="Space between the video and the frame edge (px)">Padding</label>
          <input type="range" id="frame-padding" min="0" max="120" value="40" step="2">
          <span class="frame-value" id="frame-padding-value">40</span>
        </div>
        <div class="frame-row">
          <label for="frame-radius" title="Corner rounding for the video window (px)">Radius</label>
          <input type="range" id="frame-radius" min="0" max="40" value="12" step="1">
          <span class="frame-value" id="frame-radius-value">12</span>
        </div>
        <div class="frame-row">
          <label for="frame-shadow" title="Drop shadow intensity behind the video (0 = none, 1 = max)">Shadow</label>
          <input type="range" id="frame-shadow" min="0" max="1" value="0.5" step="0.05">
          <span class="frame-value" id="frame-shadow-value">0.5</span>
        </div>
        <div class="frame-color-row" id="frame-shadow-color-row">
          <label title="Color of the drop shadow">Shadow Color</label>
          <input type="color" id="frame-shadow-color-picker" value="#000000">
          <input type="text" id="frame-shadow-color-hex" value="#000000" maxlength="9" placeholder="#000000">
        </div>
        <div class="frame-row">
          <label title="Background fill behind the framed video">Background</label>
          <select class="frame-bg-type" id="frame-bg-type">
            <option value="solid">Solid Color</option>
            <option value="gradient">Gradient</option>
            <option value="auto">Auto (from video)</option>
            <option value="image">Image</option>
          </select>
        </div>
        <div class="frame-color-row" id="frame-solid-row">
          <label>Color</label>
          <input type="color" id="frame-color-picker" value="#000000">
          <input type="text" id="frame-color-hex" value="#000000" maxlength="9" placeholder="#000000">
        </div>
        <div class="frame-gradient-row" id="frame-gradient-row" style="display:none">
          <label>Gradient (angle + two stops)</label>
          <div class="frame-gradient-stops">
            <input type="color" id="frame-grad-c0" value="#667eea">
            <span style="font-size:11px;color:var(--text-dim)">to</span>
            <input type="color" id="frame-grad-c1" value="#764ba2">
            <input type="number" id="frame-grad-angle" value="135" min="0" max="360" step="5" title="Angle (degrees)">
            <span style="font-size:11px;color:var(--text-dim)">&deg;</span>
          </div>
        </div>
        <div class="frame-color-row" id="frame-auto-row" style="display:none">
          <label>Probed</label>
          <span id="frame-auto-swatch-0" class="frame-auto-swatch"></span>
          <span style="font-size:11px;color:var(--text-dim)">to</span>
          <span id="frame-auto-swatch-1" class="frame-auto-swatch"></span>
          <span id="frame-auto-colors" style="font-size:11px;font-family:var(--mono);color:var(--text-muted)"></span>
        </div>
        <div class="frame-color-row" id="frame-image-row" style="display:none">
          <label>Image Path</label>
          <input type="text" id="frame-image-path" placeholder="assets/bg.png" style="flex:1;padding:4px 8px;font-size:12px;font-family:var(--mono);color:var(--text);background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius);">
        </div>
        <div class="frame-preview-enabled" id="frame-preview-status"></div>
      </div>
    </div>
  </div>
  <div class="sidebar-panel" id="panel-metadata" style="display:none">
    <div id="metadata-content" style="padding:16px;font-family:var(--mono);font-size:12px;color:var(--text-muted);white-space:pre-wrap;word-break:break-word;"></div>
  </div>
  <div class="status" id="status">Ready</div>
</div>

<div class="recording-overlay" id="recording-overlay">
  <div class="recording-card">
    <div class="recording-live" id="recording-live"></div>
    <div class="recording-spinner"></div>
    <div class="recording-title" id="recording-title">Re-recording pipeline...</div>
    <div class="recording-subtitle" id="recording-subtitle">All editing is paused while the pipeline runs.</div>
  </div>
</div>

<script>
// ─── Bootstrap ─────────────────────────────────────────────────────────────
const DATA = __PREVIEW_DATA__;
const video = document.getElementById('video');
const overlayLayer = document.getElementById('overlay-layer');
const timelineBar = document.getElementById('timeline-bar');
const timelineProgress = document.getElementById('timeline-progress');
const sceneList = document.getElementById('scene-list');
const statusEl = document.getElementById('status');

document.getElementById('demo-name').textContent = DATA.demoName;

// Audio context for playing clips alongside video
let audioCtx = null;
let alignedAudioBuffer = null;
let audioSource = null;
let scenePlaybackEndMs = null;
let latestSeekRequest = 0;
const scrubState = new Map();

async function initAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  try {
    const resp = await fetch('/narration-aligned.wav');
    const buf = await resp.arrayBuffer();
    alignedAudioBuffer = await audioCtx.decodeAudioData(buf);
  } catch (e) {
    console.warn('Could not load aligned audio:', e);
  }
}

// ─── Scene data ────────────────────────────────────────────────────────────
// Sort scenes by timing
const scenes = Object.entries(DATA.timing)
  .sort((a, b) => a[1] - b[1])
  .map(([name, startMs]) => ({
    name,
    startMs,
    vo: DATA.voiceover.find(v => v.scene === name),
    playbackSpeed: DATA.voiceover.find(v => v.scene === name)?.playbackSpeed,
    overlay: DATA.overlays.find(o => o.scene === name),
    effects: DATA.effects[name] ?? [],
    rendered: DATA.renderedOverlays[name],
    report: DATA.sceneReport?.scenes?.find(s => s.scene === name),
  }));

let activeScene = null;

function getPreviewDurationMs() {
  const mediaDurationMs = Number.isFinite(video.duration) && video.duration > 0
    ? video.duration * 1000
    : 0;
  return mediaDurationMs || DATA.videoDurationMs || DATA.sceneReport?.totalDurationMs || 0;
}

function moveEndMs(m) {
  return m.startMs + m.durationMs + (m.holdMs ?? 0) + m.durationMs;
}

function renderTimelineMarkers() {
  const totalMs = getPreviewDurationMs();
  if (!totalMs) return;

  timelineBar.querySelectorAll('.timeline-scene').forEach(node => node.remove());
  timelineBar.querySelectorAll('.timeline-camera-move').forEach(node => node.remove());
  timelineBar.querySelectorAll('.timeline-camera-chain').forEach(node => node.remove());

  scenes.forEach((s, i) => {
    const pct = (s.startMs / totalMs) * 100;
    const nextStart = i + 1 < scenes.length ? scenes[i + 1].startMs : totalMs;
    const widthPct = ((nextStart - s.startMs) / totalMs) * 100;

    const marker = document.createElement('div');
    marker.className = 'timeline-scene';
    marker.style.left = pct + '%';
    marker.style.width = Math.max(widthPct, 2) + '%';
    const hasOverlay = s.overlay?.type;
    // Scene name is validated (alphanumeric + hyphens only) so esc() is safe for textContent
    marker.textContent = s.name;
    if (hasOverlay) {
      const dot = document.createElement('span');
      dot.className = 'has-overlay';
      marker.appendChild(dot);
    }
    marker.dataset.scene = s.name;
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      if (justScrubbed) return;
      seekToScene(s);
    });
    timelineBar.appendChild(marker);
  });

  // Camera move markers on timeline
  const moves = DATA.cameraMoves ?? [];
  const CHAIN_GAP_MS = 1500;
  moves.forEach((m, i) => {
    const scale = m.scale ?? 1.5;
    if (scale <= 1.0) return;
    const startPct = (m.startMs / totalMs) * 100;
    const endMs = moveEndMs(m);
    const widthPct = ((endMs - m.startMs) / totalMs) * 100;
    const el = document.createElement('div');
    el.className = 'timeline-camera-move';
    el.style.left = startPct + '%';
    el.style.width = Math.max(widthPct, 0.5) + '%';
    el.title = 'Camera: ' + (m.scene ?? '') + ' (' + scale.toFixed(1) + 'x)';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      video.currentTime = m.startMs / 1000;
    });
    timelineBar.appendChild(el);

    // Chain indicator between connected moves
    if (i + 1 < moves.length) {
      const next = moves[i + 1];
      const gap = next.startMs - endMs;
      if (gap >= 0 && gap <= CHAIN_GAP_MS && (next.scale ?? 1.5) > 1.0) {
        const chainStart = (endMs / totalMs) * 100;
        const chainWidth = ((next.startMs - endMs) / totalMs) * 100;
        const chain = document.createElement('div');
        chain.className = 'timeline-camera-chain';
        chain.style.left = chainStart + '%';
        chain.style.width = chainWidth + '%';
        timelineBar.appendChild(chain);
      }
    }
  });
}

// ─── Timeline ──────────────────────────────────────────────────────────────
video.addEventListener('loadedmetadata', () => {
  const totalMs = getPreviewDurationMs();
  document.getElementById('time-total').textContent = formatTime(totalMs);
  renderTimelineMarkers();
  loadAndRenderWaveform();

  // Create overlay DOM elements
  renderOverlayElements();
});

if (getPreviewDurationMs() > 0) {
  document.getElementById('time-total').textContent = formatTime(getPreviewDurationMs());
  renderTimelineMarkers();
}

// ─── Waveform strip ────────────────────────────────────────────────────────
let waveformSamples = null;

async function loadAndRenderWaveform() {
  const strip = document.getElementById('waveform-strip');
  const canvas = document.getElementById('waveform-canvas');
  const empty = document.getElementById('waveform-empty');
  if (!strip || !canvas) return;
  try {
    const buckets = Math.max(200, Math.min(2000, Math.round(strip.clientWidth * 1.2)));
    const resp = await fetch('/api/waveform?samples=' + buckets);
    if (!resp.ok) {
      strip.classList.remove('has-data');
      if (empty) empty.style.display = '';
      return;
    }
    const data = await resp.json();
    waveformSamples = (data && Array.isArray(data.samples)) ? data.samples : [];
    if (waveformSamples.length === 0) {
      strip.classList.remove('has-data');
      return;
    }
    strip.classList.add('has-data');
    paintWaveform();
  } catch (err) {
    console.warn('[argo] waveform fetch failed:', err);
    strip.classList.remove('has-data');
  }
}

function paintWaveform() {
  const canvas = document.getElementById('waveform-canvas');
  if (!canvas || !waveformSamples) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (cssW === 0 || cssH === 0) return;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  // Resolve accent color from CSS custom property for theme parity.
  const css = getComputedStyle(document.documentElement);
  const accent = (css.getPropertyValue('--accent') || '#6366f1').trim();
  ctx.fillStyle = accent;

  const n = waveformSamples.length;
  const barW = cssW / n;
  const mid = cssH / 2;
  const drawW = Math.max(1, Math.floor(barW));
  for (let i = 0; i < n; i++) {
    const v = waveformSamples[i];
    const h = Math.max(1, v * (cssH * 0.9));
    const x = Math.floor(i * barW);
    const y = mid - h / 2;
    ctx.fillRect(x, y, drawW, h);
  }
}

// Repaint on resize so the waveform stays sharp when the window changes width.
let waveformResizeRaf = 0;
window.addEventListener('resize', () => {
  if (waveformResizeRaf) cancelAnimationFrame(waveformResizeRaf);
  waveformResizeRaf = requestAnimationFrame(() => {
    waveformResizeRaf = 0;
    paintWaveform();
  });
});

// Click on the waveform strip to seek
const waveformStripEl = document.getElementById('waveform-strip');
if (waveformStripEl) {
  waveformStripEl.addEventListener('click', (e) => {
    scrubFromWaveformX(e.clientX);
  });
}

video.addEventListener('timeupdate', () => {
  // Don't update UI during scrubbing — scrubToX handles it directly
  if (isScrubbing) return;
  const totalMs = getPreviewDurationMs();
  const currentMs = video.currentTime * 1000;
  if (scenePlaybackEndMs !== null && currentMs >= scenePlaybackEndMs) {
    const stopAt = scenePlaybackEndMs;
    scenePlaybackEndMs = null;
    video.currentTime = stopAt / 1000;
    video.pause();
    stopAudio();
  }
  timelineProgress.style.width = ((currentMs / totalMs) * 100) + '%';
  const pctStr = ((currentMs / totalMs) * 100) + '%';
  document.getElementById('timeline-playhead').style.left = pctStr;
  const wfPlayhead = document.getElementById('waveform-playhead');
  if (wfPlayhead) wfPlayhead.style.left = pctStr;
  document.getElementById('time-current').textContent = formatTime(currentMs);
  updateSceneScrubUI(currentMs);

  // Update active scene
  let current = null;
  for (let i = scenes.length - 1; i >= 0; i--) {
    if (currentMs >= scenes[i].startMs) {
      current = scenes[i];
      break;
    }
  }
  if (current !== activeScene) {
    activeScene = current;
    updateActiveSceneUI();
    updateOverlayVisibility(currentMs);
  }
  applyCameraTransform(currentMs);
});

// Click and drag on timeline bar to scrub
let isScrubbing = false;
let justScrubbed = false;

function scrubToX(clientX) {
  const rect = timelineBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const dur = video.duration;
  if (!dur || !Number.isFinite(dur)) return;
  const targetSec = pct * dur;
  scenePlaybackEndMs = null;
  // Direct assignment — no async seek during scrubbing
  video.currentTime = targetSec;
  // Update UI immediately
  const ms = targetSec * 1000;
  document.getElementById('time-current').textContent = formatTime(ms);
  const pctStr = (pct * 100) + '%';
  timelineProgress.style.width = pctStr;
  document.getElementById('timeline-playhead').style.left = pctStr;
  const wfPlayhead = document.getElementById('waveform-playhead');
  if (wfPlayhead) wfPlayhead.style.left = pctStr;
}

// Click on waveform strip to seek (mirror timeline-bar scrub behavior)
function scrubFromWaveformX(clientX) {
  const strip = document.getElementById('waveform-strip');
  if (!strip) return;
  const rect = strip.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const dur = video.duration;
  if (!dur || !Number.isFinite(dur)) return;
  video.currentTime = pct * dur;
}

timelineBar.addEventListener('mousedown', (e) => {
  isScrubbing = true;
  video.pause();
  showPlayIcon();
  scrubToX(e.clientX);
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!isScrubbing) return;
  scrubToX(e.clientX);
  e.preventDefault();
});

document.addEventListener('mouseup', () => {
  if (isScrubbing) {
    isScrubbing = false;
    // Prevent the subsequent click event on scene markers from seeking to scene start
    justScrubbed = true;
    setTimeout(() => { justScrubbed = false; }, 50);
  }
});

// Play/pause icon toggling
function showPlayIcon() {
  const p = document.getElementById('icon-play');
  const s = document.getElementById('icon-pause');
  if (p) p.style.display = '';
  if (s) s.style.display = 'none';
}
function showPauseIcon() {
  const p = document.getElementById('icon-play');
  const s = document.getElementById('icon-pause');
  if (p) p.style.display = 'none';
  if (s) s.style.display = '';
}

// Play/pause toggle (shared by button and video click)
async function togglePlayPause() {
  if (video.paused) {
    await video.play();
    if (document.getElementById('cb-audio').checked) await playAudio();
    showPauseIcon();
  } else {
    video.pause();
    stopAudio();
    showPlayIcon();
  }
}
function pausePreview() {
  if (!video.paused) {
    video.pause();
    stopAudio();
    showPlayIcon();
  }
  scenePlaybackEndMs = null;
}

document.getElementById('btn-play').addEventListener('click', togglePlayPause);
video.addEventListener('click', togglePlayPause);

video.addEventListener('pause', () => {
  if (!video.ended) {
    stopAudio();
    showPlayIcon();
  }
});

video.addEventListener('ended', () => {
  stopAudio();
  showPlayIcon();
});

// Audio checkbox
document.getElementById('cb-audio').addEventListener('change', async (e) => {
  if (e.target.checked && !video.paused) {
    await playAudio();
  } else {
    stopAudio();
  }
});

async function playAudio() {
  if (!audioCtx || !alignedAudioBuffer) await initAudio();
  if (!audioCtx || !alignedAudioBuffer) return;
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  stopAudio();
  audioSource = audioCtx.createBufferSource();
  audioSource.buffer = alignedAudioBuffer;
  audioSource.connect(audioCtx.destination);
  audioSource.start(0, video.currentTime);
}

function stopAudio() {
  if (audioSource) {
    try { audioSource.stop(); } catch {}
    audioSource = null;
  }
}

function syncAudio() {
  if (!video.paused && document.getElementById('cb-audio').checked) {
    void playAudio();
  }
}

// ─── Overlay rendering ────────────────────────────────────────────────────
function renderOverlayElements() {
  overlayLayer.innerHTML = '';
  for (const s of scenes) {
    if (!s.rendered) continue;
    const el = document.createElement('div');
    el.className = 'overlay-cue';
    el.dataset.scene = s.name;
    el.dataset.zone = s.rendered.zone;
    el.innerHTML = '<span class="preview-badge">PREVIEW</span>' + s.rendered.html;
    Object.assign(el.style, s.rendered.styles);
    overlayLayer.appendChild(el);
    makeOverlayDraggable(el);
  }
}

function updateOverlayVisibility(currentMs) {
  if (!document.getElementById('cb-overlays').checked) {
    overlayLayer.querySelectorAll('.overlay-cue').forEach(el => el.classList.remove('visible'));
    return;
  }

  for (const s of scenes) {
    const el = overlayLayer.querySelector('[data-scene="' + s.name + '"]');
    if (!el) continue;

    // Show overlay during this scene's time range.
    // For scenes without TTS (endMs === startMs), extend to the next scene's start or video end.
    const { startMs, endMs } = getSceneBounds(s);
    const sceneIdx = scenes.indexOf(s);
    const nextStart = sceneIdx + 1 < scenes.length ? scenes[sceneIdx + 1].startMs : getPreviewDurationMs();
    const effectiveEnd = endMs > startMs ? endMs : nextStart;
    const isActive = currentMs >= startMs && currentMs < effectiveEnd;
    el.classList.toggle('visible', isActive);
  }
}

document.getElementById('cb-overlays').addEventListener('change', () => {
  updateOverlayVisibility(video.currentTime * 1000);
});

document.getElementById('cb-camera').addEventListener('change', () => {
  cameraPreviewEnabled = document.getElementById('cb-camera').checked;
  applyCameraTransform(video.currentTime * 1000);
});

// ─── Drag-to-snap overlay positioning ──────────────────────────────────────
const SNAP_ZONES = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'bottom-center', 'center'];
const snapZoneEls = document.querySelectorAll('.snap-zone');

// Zone center positions as fractions of the container
const ZONE_CENTERS = {
  'top-left':      { x: 0.05 + 0.35 / 2, y: 0.10 + 0.35 / 2 },
  'top-right':     { x: 1 - 0.05 - 0.35 / 2, y: 0.10 + 0.35 / 2 },
  'bottom-left':   { x: 0.05 + 0.35 / 2, y: 1 - 0.10 - 0.35 / 2 },
  'bottom-right':  { x: 1 - 0.05 - 0.35 / 2, y: 1 - 0.10 - 0.35 / 2 },
  'bottom-center': { x: 0.25 + 0.50 / 2, y: 1 - 0.05 - 0.20 / 2 },
  'center':        { x: 0.25 + 0.50 / 2, y: 0.30 + 0.40 / 2 },
};

let dragState = null;
let isOverlayDragging = false;

function showSnapZones() {
  snapZoneEls.forEach(el => el.classList.add('visible'));
}

function hideSnapZones() {
  snapZoneEls.forEach(el => {
    el.classList.remove('visible', 'highlight');
  });
}

function highlightNearestZone(fracX, fracY) {
  let nearest = null;
  let minDist = Infinity;
  for (const zone of SNAP_ZONES) {
    const c = ZONE_CENTERS[zone];
    const d = Math.hypot(fracX - c.x, fracY - c.y);
    if (d < minDist) {
      minDist = d;
      nearest = zone;
    }
  }
  snapZoneEls.forEach(el => {
    el.classList.toggle('highlight', el.dataset.zone === nearest);
  });
  return nearest;
}

function makeOverlayDraggable(el) {
  el.classList.add('overlay-draggable');

  el.addEventListener('mousedown', (e) => {
    // Only primary button
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const container = el.closest('.video-container');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    // Store original zone positioning styles so we can restore if needed
    const sceneName = el.dataset.scene;

    dragState = {
      el,
      sceneName,
      container,
      containerRect,
      // Offset from mouse to element top-left
      offsetX: e.clientX - elRect.left,
      offsetY: e.clientY - elRect.top,
      nearestZone: null,
    };

    // Switch to fixed positioning for free drag
    isOverlayDragging = true;
    el.classList.add('overlay-dragging');
    el.style.position = 'absolute';
    el.style.left = (elRect.left - containerRect.left) + 'px';
    el.style.top = (elRect.top - containerRect.top) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';

    showSnapZones();
  });
}

document.addEventListener('mousemove', (e) => {
  if (!dragState) return;
  e.preventDefault();

  const { el, container, containerRect, offsetX, offsetY } = dragState;
  const rect = containerRect;

  const newLeft = e.clientX - rect.left - offsetX;
  const newTop = e.clientY - rect.top - offsetY;

  el.style.left = newLeft + 'px';
  el.style.top = newTop + 'px';

  // Calculate overlay center as fraction of container
  const elRect = el.getBoundingClientRect();
  const centerX = (elRect.left + elRect.width / 2 - rect.left) / rect.width;
  const centerY = (elRect.top + elRect.height / 2 - rect.top) / rect.height;

  dragState.nearestZone = highlightNearestZone(centerX, centerY);
});

document.addEventListener('mouseup', (e) => {
  if (!dragState) return;

  const { el, sceneName, nearestZone } = dragState;
  const zone = nearestZone || 'bottom-center';

  // Remove drag styles — let CSS zone positioning take over
  el.classList.remove('overlay-dragging');
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.right = '';
  el.style.bottom = '';
  el.style.transform = '';

  // Update the data-zone attribute so CSS positioning applies
  el.dataset.zone = zone;

  // Update s.overlay (single source of truth)
  const s = scenes.find(sc => sc.name === sceneName);
  if (s && s.overlay) {
    s.overlay.placement = zone;
  }

  // Update the placement dropdown for visual consistency
  const placeEl = document.querySelector('select[data-scene="' + sceneName + '"][data-field="overlay-placement"]');
  if (placeEl) {
    placeEl.value = zone;
  }

  // Update rendered data so renderOverlayElements stays in sync
  if (DATA.renderedOverlays[sceneName]) {
    DATA.renderedOverlays[sceneName].zone = zone;
  }

  hideSnapZones();
  markDirty();
  isOverlayDragging = false;
  dragState = null;
});

// ─── Scene list (sidebar) ──────────────────────────────────────────────────
function renderSceneList() {
  sceneList.innerHTML = '';
  for (const s of scenes) {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.dataset.scene = s.name;

    const durationMs = DATA.sceneDurations[s.name] ?? s.report?.durationMs ?? 0;

    // scene-name and scene-duration use esc() — safe for innerHTML
    card.innerHTML = \`
      <div class="scene-name">
        \${esc(s.name)}
        <span class="scene-time">\${formatTime(s.startMs)}</span>
        \${durationMs ? '<span class="scene-duration">' + (durationMs / 1000).toFixed(1) + 's</span>' : ''}
        <span class="expand-icon">&#9654;</span>
      </div>
      <div class="scene-body">
      <div class="field-group">
        <label>Voiceover text</label>
        <textarea data-field="text" data-scene="\${esc(s.name)}">\${esc(s.vo?.text ?? '')}</textarea>
        \${s.vo?._hint ? '<div class="hint-text">hint: ' + esc(s.vo._hint) + '</div>' : ''}
      </div>
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Voice</label>
          <input data-field="voice" data-scene="\${esc(s.name)}" value="\${esc(s.vo?.voice ?? '')}" placeholder="default">
        </div>
        <div style="flex:1">
          <label>Speed</label>
          <input data-field="speed" data-scene="\${esc(s.name)}" type="number" step="0.1" min="0.5" max="2" value="\${s.vo?.speed ?? ''}\" placeholder="1.0">
        </div>
        <div style="flex:0 0 80px">
          <label title="Video playback speed (not TTS)">Playback</label>
          <input data-field="playbackSpeed" data-scene="\${esc(s.name)}" type="number" step="0.25" min="0.25" max="4" value="\${s.playbackSpeed ?? ''}" placeholder="1.0">
        </div>
      </div>
      \${renderOverlayFields(s)}
      \${renderEffectsFields(s)}
      \${renderCameraMovesFields(s)}
      <div class="btn-row">
        <button class="btn btn-undo" data-scene="\${esc(s.name)}" onclick="undoScene('\${esc(s.name)}')" style="display:none" title="Revert to last saved state">Undo</button>
        <span class="btn-group"><button class="btn" onclick="previewScene('\${esc(s.name)}')" title="Play this scene">&#9654;</button><button class="btn" onclick="pausePreview()" title="Pause">&#9646;&#9646;</button></span>
        <span class="btn-group"><button class="btn" onclick="nudgeScene('\${esc(s.name)}', -250)">-250ms</button><button class="btn" onclick="nudgeScene('\${esc(s.name)}', 250)">+250ms</button></span>
        <button class="btn btn-accent" onclick="regenClip('\${esc(s.name)}', this)">Regen TTS</button>
      </div>
      <div class="field-group scene-scrub">
        <label>Scene scrub</label>
        <input
          type="range"
          min="0"
          max="\${durationMs}"
          step="25"
          value="0"
          data-field="scene-scrub"
          data-scene="\${esc(s.name)}"
          \${durationMs ? '' : 'disabled'}
        >
        <div class="scene-scrub-meta">
          <span data-scene-scrub-current="\${esc(s.name)}">0.0s</span>
          <span data-scene-scrub-total="\${esc(s.name)}">\${(durationMs / 1000).toFixed(1)}s</span>
        </div>
      </div>
      </div>
    \`;

    // Click on scene header row toggles expand/collapse + seeks
    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' ||
          e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      if (e.target.closest('.scene-body')) return;
      const willCollapse = card.classList.contains('expanded');
      card.classList.toggle('expanded');
      if (willCollapse) {
        manuallyCollapsed.add(s.name);
      } else {
        manuallyCollapsed.delete(s.name);
        seekToScene(s);
      }
    });

    const scrub = card.querySelector('[data-field="scene-scrub"]');
    if (scrub) {
      scrub.addEventListener('input', (event) => {
        handleSceneScrubInput(s.name, event.target.value);
      });
      scrub.addEventListener('change', (event) => {
        handleSceneScrubCommit(s.name, event.target.value);
      });
    }

    sceneList.appendChild(card);

    // Wire overlay + effect listeners AFTER appendChild so document.querySelector can find the card
    wireOverlayListeners(s.name);
    wireEffectListeners(s.name);
  }

  // Trigger overlay preview after rendering so existing overlays appear on the video
  previewOverlays();
}

// ─── Add Scene button ────────────────────────────────────────────────────
document.getElementById('add-scene-btn').addEventListener('click', () => {
  // Generate a unique scene name
  let idx = scenes.length + 1;
  let name = 'scene-' + idx;
  const existingNames = new Set(scenes.map(s => s.name));
  while (existingNames.has(name)) {
    idx++;
    name = 'scene-' + idx;
  }

  // Timestamp from current video position
  const startMs = Math.round(video.currentTime * 1000);

  // Add to timing data
  DATA.timing[name] = startMs;
  DATA.sceneDurations[name] = 0;
  DATA.voiceover.push({ scene: name, text: '' });

  // Insert scene into the sorted array at the right position
  const newScene = {
    name,
    startMs,
    vo: { scene: name, text: '' },
    overlay: undefined,
    effects: [],
    rendered: undefined,
    report: undefined,
  };
  // Find insertion index to keep sorted by startMs
  let insertIdx = scenes.length;
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].startMs > startMs) {
      insertIdx = i;
      break;
    }
  }
  scenes.splice(insertIdx, 0, newScene);

  // Capture current form values before re-render wipes the DOM
  syncFormValuesToScenes();

  // Re-render scene list
  renderSceneList();
  snapshotAllScenes();
  markDirty();

  // Auto-scroll to the new card and expand it
  const newCard = document.querySelector('.scene-card[data-scene="' + name + '"]');
  if (newCard) {
    newCard.classList.add('expanded');
    newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});

function renderDynamicOverlayFields(sceneName, type, ov) {
  if (!type) return '';
  let fields = '';
  if (type === 'lower-third' || type === 'callout') {
    fields += \`
      <div class="field-group">
        <label>Text</label>
        <input data-field="overlay-text" data-scene="\${esc(sceneName)}" value="\${esc(ov?.text ?? '')}">
      </div>\`;
  } else if (type === 'headline-card') {
    fields += \`
      <div class="field-group">
        <label>Title</label>
        <input data-field="overlay-text" data-scene="\${esc(sceneName)}" value="\${esc(ov?.title ?? '')}">
      </div>
      <div class="field-group">
        <label>Body</label>
        <input data-field="overlay-body" data-scene="\${esc(sceneName)}" value="\${esc(ov?.body ?? '')}" placeholder="optional">
      </div>
      <div class="field-group">
        <label>Kicker</label>
        <input data-field="overlay-kicker" data-scene="\${esc(sceneName)}" value="\${esc(ov?.kicker ?? '')}" placeholder="optional">
      </div>\`;
  } else if (type === 'image-card') {
    fields += \`
      <div class="field-group">
        <label>Title</label>
        <input data-field="overlay-text" data-scene="\${esc(sceneName)}" value="\${esc(ov?.title ?? '')}" placeholder="optional">
      </div>
      <div class="field-group">
        <label>Body</label>
        <input data-field="overlay-body" data-scene="\${esc(sceneName)}" value="\${esc(ov?.body ?? '')}" placeholder="optional">
      </div>
      <div class="field-group">
        <label>Src</label>
        <input data-field="overlay-src" data-scene="\${esc(sceneName)}" value="\${esc(ov?.src ?? '')}" placeholder="assets/example.png">
      </div>\`;
  } else if (type === 'arrow') {
    fields += \`
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Direction</label>
          <select data-field="overlay-direction" data-scene="\${esc(sceneName)}">
            \${['up','down','left','right','up-left','up-right','down-left','down-right'].map(d =>
              \`<option value="\${d}" \${(ov?.direction ?? 'down') === d ? 'selected' : ''}>\${d}</option>\`
            ).join('')}
          </select>
        </div>
        <div style="flex:1">
          <label>Color</label>
          <input type="color" data-field="overlay-color" data-scene="\${esc(sceneName)}" value="\${ov?.color ?? '#ef4444'}">
        </div>
      </div>
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Label</label>
          <input data-field="overlay-text" data-scene="\${esc(sceneName)}" value="\${esc(ov?.label ?? '')}" placeholder="optional">
        </div>
        <div style="flex:0 0 80px">
          <label>Size</label>
          <input type="number" data-field="overlay-size" data-scene="\${esc(sceneName)}" value="\${ov?.size ?? 48}" min="16" max="128" step="4">
        </div>
      </div>\`;
  }
  return fields;
}

function renderOverlayFields(s) {
  const ov = s.overlay;
  const type = ov?.type ?? '';
  return \`
    <div class="overlay-section">
      <div class="section-title">Overlay</div>
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Type</label>
          <select data-field="overlay-type" data-scene="\${esc(s.name)}">
            <option value="">none</option>
            <option value="lower-third" \${type === 'lower-third' ? 'selected' : ''}>lower-third</option>
            <option value="headline-card" \${type === 'headline-card' ? 'selected' : ''}>headline-card</option>
            <option value="callout" \${type === 'callout' ? 'selected' : ''}>callout</option>
            <option value="image-card" \${type === 'image-card' ? 'selected' : ''}>image-card</option>
            <option value="arrow" \${type === 'arrow' ? 'selected' : ''}>arrow</option>
          </select>
        </div>
        \${type ? \`<div style="flex:1">
          <label>Zone</label>
          <select data-field="overlay-placement" data-scene="\${esc(s.name)}">
            <option value="bottom-center" \${(ov?.placement ?? 'bottom-center') === 'bottom-center' ? 'selected' : ''}>bottom-center</option>
            <option value="top-left" \${ov?.placement === 'top-left' ? 'selected' : ''}>top-left</option>
            <option value="top-right" \${ov?.placement === 'top-right' ? 'selected' : ''}>top-right</option>
            <option value="bottom-left" \${ov?.placement === 'bottom-left' ? 'selected' : ''}>bottom-left</option>
            <option value="bottom-right" \${ov?.placement === 'bottom-right' ? 'selected' : ''}>bottom-right</option>
            <option value="center" \${ov?.placement === 'center' ? 'selected' : ''}>center</option>
          </select>
        </div>
        <div style="flex:0 0 auto; display:flex; align-items:flex-end; padding-bottom:2px;">
          <span class="overlay-theme-badge" data-scene="\${esc(s.name)}" title="Auto-detected overlay theme"
            style="font-size:11px; padding:2px 6px; border-radius:3px;
              background:\${(DATA.overlayThemes[s.name] ?? 'dark') === 'light' ? '#fff' : '#333'};
              color:\${(DATA.overlayThemes[s.name] ?? 'dark') === 'light' ? '#333' : '#ccc'};
              border:1px solid #555;">\${DATA.overlayThemes[s.name] ?? 'dark'}</span>
        </div>\` : ''}
      </div>
      \${type ? \`<div class="field-group">
        <label>Motion</label>
        <select data-field="overlay-motion" data-scene="\${esc(s.name)}">
          <option value="none" \${(ov?.motion ?? 'none') === 'none' ? 'selected' : ''}>none</option>
          <option value="fade-in" \${ov?.motion === 'fade-in' ? 'selected' : ''}>fade-in</option>
          <option value="slide-in" \${ov?.motion === 'slide-in' ? 'selected' : ''}>slide-in</option>
        </select>
      </div>\` : ''}
      \${type ? \`<div class="field-group" style="display:flex;align-items:center;gap:8px">
        <label style="margin:0"><input type="checkbox" data-field="overlay-autoBackground" data-scene="\${esc(s.name)}" \${ov?.autoBackground ? 'checked' : ''}> Auto theme</label>
      </div>\` : ''}
      <div class="overlay-fields-dynamic" data-scene="\${esc(s.name)}">
        \${renderDynamicOverlayFields(s.name, type, ov)}
      </div>
    </div>
  \`;
}

function updateOverlayFieldsForScene(sceneName) {
  const typeEl = document.querySelector('select[data-scene="' + sceneName + '"][data-field="overlay-type"]');
  const type = typeEl?.value ?? '';
  const s = scenes.find(sc => sc.name === sceneName);
  if (s) {
    if (!type) s.overlay = undefined;
    else s.overlay = { ...(s.overlay ?? {}), type };
  }
  const ov = s?.overlay;
  const container = document.querySelector('.overlay-fields-dynamic[data-scene="' + sceneName + '"]');
  if (!container) return;
  // Re-render the dynamic fields — values come from esc() so safe for innerHTML
  container.innerHTML = renderDynamicOverlayFields(sceneName, type, ov);
  // Re-render the full overlay section to show/hide zone+motion
  const section = container.closest('.overlay-section');
  if (section) {
    // Temporarily build a fake scene object with updated overlay type for re-render
    const fakeOv = type ? { ...(ov ?? {}), type } : null;
    const fakeScene = { name: sceneName, overlay: fakeOv };
    section.outerHTML = renderOverlayFields(fakeScene);
    // Re-wire event listeners for the new overlay fields
    wireOverlayListeners(sceneName);
    // Trigger preview to show the overlay immediately after type change
    renderSingleSceneOverlay(sceneName);
  }
}

function wireOverlayListeners(sceneName) {
  const card = document.querySelector('.scene-card[data-scene="' + sceneName + '"]');
  if (!card) return;
  let debounceTimer;

  // Type change — special: re-renders the dynamic fields
  const typeSelect = card.querySelector('select[data-field="overlay-type"]');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      const s = scenes.find(sc => sc.name === sceneName);
      if (!s) return;
      const type = typeSelect.value;
      if (!type) {
        s.overlay = undefined;
      } else {
        s.overlay = { ...(s.overlay ?? {}), type };
      }
      updateOverlayFieldsForScene(sceneName);
    });
  }

  // All other overlay fields — update s.overlay directly
  card.querySelectorAll('[data-field^="overlay-"]').forEach(input => {
    const field = input.dataset.field;
    if (field === 'overlay-type') return; // handled above

    const handler = () => {
      const s = scenes.find(sc => sc.name === sceneName);
      if (!s || !s.overlay) return;

      // Map field name to overlay property
      if (field === 'overlay-placement') s.overlay.placement = input.value;
      else if (field === 'overlay-motion') {
        if (input.value && input.value !== 'none') s.overlay.motion = input.value;
        else delete s.overlay.motion;
      }
      else if (field === 'overlay-text') {
        if (s.overlay.type === 'lower-third' || s.overlay.type === 'callout') {
          s.overlay.text = input.value;
        } else if (s.overlay.type === 'arrow') {
          s.overlay.label = input.value || undefined;
        } else {
          s.overlay.title = input.value;
        }
      }
      else if (field === 'overlay-body') s.overlay.body = input.value || undefined;
      else if (field === 'overlay-kicker') s.overlay.kicker = input.value || undefined;
      else if (field === 'overlay-src') s.overlay.src = input.value || undefined;
      else if (field === 'overlay-direction') s.overlay.direction = input.value || undefined;
      else if (field === 'overlay-color') s.overlay.color = input.value || undefined;
      else if (field === 'overlay-size') s.overlay.size = input.value ? parseInt(input.value, 10) : undefined;
      else if (field === 'overlay-autoBackground') {
        if (input.checked) s.overlay.autoBackground = true;
        else delete s.overlay.autoBackground;
      }

      markDirty();

      // Skip render during drag
      if (isOverlayDragging) return;

      // Debounce per-scene render
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => renderSingleSceneOverlay(sceneName), 300);
    };

    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  });
}

async function renderSingleSceneOverlay(sceneName) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s?.overlay?.type) return;

  const ov = [{ ...s.overlay, scene: sceneName }];
  const resp = await fetch('/api/render-overlays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ov),
  });
  const result = await resp.json();
  if (result.renderedOverlays?.[sceneName]) {
    DATA.renderedOverlays[sceneName] = result.renderedOverlays[sceneName];
    s.rendered = result.renderedOverlays[sceneName];
    renderOverlayElements();
    updateOverlayVisibility(video.currentTime * 1000);
  }
}

// ─── Effects section ────────────────────────────────────────────────────────
const EFFECT_TYPES = ['confetti', 'spotlight', 'focus-ring', 'dim-around', 'zoom-to'];
const CONFETTI_SPREADS = ['burst', 'rain'];

function renderEffectsFields(s) {
  const fx = (s.effects || []);
  return \`
    <div class="effects-section">
      <div class="section-title">Effects <button class="btn btn-sm" onclick="addEffect('\${esc(s.name)}')" title="Add effect">+</button></div>
      <div class="effects-list" data-scene="\${esc(s.name)}">
        \${fx.map((e, i) => renderSingleEffect(s.name, e, i)).join('')}
      </div>
    </div>
  \`;
}

function renderSingleEffect(sceneName, effect, index) {
  const type = effect.type || '';
  let fields = '';

  if (type === 'confetti') {
    fields = \`
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Spread</label>
          <select data-field="effect-spread" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}">
            \${CONFETTI_SPREADS.map(s => '<option value="' + s + '"' + (effect.spread === s || (!effect.spread && s === 'burst') ? ' selected' : '') + '>' + s + '</option>').join('')}
          </select>
        </div>
        <div style="flex:1">
          <label>Pieces</label>
          <input data-field="effect-pieces" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}" type="number" min="10" max="500" step="10" value="\${effect.pieces ?? 150}" placeholder="150">
        </div>
        <div style="flex:1">
          <label>Duration</label>
          <input data-field="effect-duration" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}" type="number" min="500" max="10000" step="500" value="\${effect.duration ?? 3000}" placeholder="3000">
        </div>
      </div>\`;
  } else if (type === 'spotlight' || type === 'focus-ring' || type === 'dim-around' || type === 'zoom-to') {
    fields = \`
      <div class="field-group">
        <label>Selector</label>
        <input data-field="effect-selector" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}" value="\${esc(effect.selector ?? '')}" placeholder="CSS selector">
      </div>
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Duration</label>
          <input data-field="effect-duration" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}" type="number" min="500" max="10000" step="500" value="\${effect.duration ?? 3000}" placeholder="3000">
        </div>
        \${type === 'spotlight' ? '<div style="flex:1"><label>Padding</label><input data-field="effect-padding" data-scene="' + esc(sceneName) + '" data-effect-idx="' + index + '" type="number" min="0" max="50" value="' + (effect.padding ?? 12) + '"></div>' : ''}
        \${type === 'focus-ring' ? '<div style="flex:1"><label>Color</label><input data-field="effect-color" data-scene="' + esc(sceneName) + '" data-effect-idx="' + index + '" type="text" value="' + esc(effect.color ?? '#3b82f6') + '" placeholder="#3b82f6"></div>' : ''}
        \${type === 'zoom-to' ? '<div style="flex:1"><label>Scale</label><input data-field="effect-scale" data-scene="' + esc(sceneName) + '" data-effect-idx="' + index + '" type="number" step="0.5" min="1" max="5" value="' + (effect.scale ?? 2) + '"></div>' : ''}
      </div>\`;
  }

  return \`
    <div class="effect-entry" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}">
      <div class="field-group" style="display:flex;gap:8px;align-items:end">
        <div style="flex:1">
          <label>Effect</label>
          <select data-field="effect-type" data-scene="\${esc(sceneName)}" data-effect-idx="\${index}">
            \${EFFECT_TYPES.map(t => '<option value="' + t + '"' + (type === t ? ' selected' : '') + '>' + t + '</option>').join('')}
          </select>
        </div>
        <button class="btn btn-sm btn-danger" onclick="removeEffect('\${esc(sceneName)}', \${index})" title="Remove effect">&times;</button>
        <button class="btn btn-sm" onclick="previewEffect('\${esc(sceneName)}', \${index})" title="Preview effect">&#9654;</button>
      </div>
      \${fields}
    </div>
  \`;
}

function addEffect(sceneName) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s) return;
  s.effects = s.effects || [];
  s.effects.push({ type: 'confetti' });
  refreshEffectsUI(sceneName);
  markDirty();
}

function removeEffect(sceneName, index) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s || !s.effects) return;
  s.effects.splice(index, 1);
  refreshEffectsUI(sceneName);
  markDirty();
}

function refreshEffectsUI(sceneName) {
  const container = document.querySelector('.effects-list[data-scene="' + sceneName + '"]');
  if (!container) return;
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s) return;
  container.innerHTML = (s.effects || []).map((e, i) => renderSingleEffect(sceneName, e, i)).join('');
  wireEffectListeners(sceneName);
}

function wireEffectListeners(sceneName) {
  const container = document.querySelector('.effects-list[data-scene="' + sceneName + '"]');
  if (!container) return;
  container.querySelectorAll('[data-field="effect-type"]').forEach(select => {
    select.addEventListener('change', () => {
      const idx = Number(select.dataset.effectIdx);
      const s = scenes.find(sc => sc.name === sceneName);
      if (s?.effects?.[idx]) {
        const newType = select.value;
        s.effects[idx] = { type: newType };
        refreshEffectsUI(sceneName);
      }
      markDirty();
    });
  });
  container.querySelectorAll('[data-field^="effect-"]').forEach(input => {
    if (input.dataset.field === 'effect-type') return;
    input.addEventListener('input', () => markDirty());
    input.addEventListener('change', () => {
      collectEffectValues(sceneName);
      markDirty();
    });
  });
}

function collectEffectValues(sceneName) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s?.effects) return;
  for (let i = 0; i < s.effects.length; i++) {
    const entry = {};
    const container = document.querySelector('.effects-list[data-scene="' + sceneName + '"]');
    if (!container) continue;
    const typeEl = container.querySelector('[data-field="effect-type"][data-effect-idx="' + i + '"]');
    entry.type = typeEl?.value ?? s.effects[i].type;
    const fields = ['spread', 'pieces', 'duration', 'selector', 'padding', 'color', 'scale'];
    for (const f of fields) {
      const el = container.querySelector('[data-field="effect-' + f + '"][data-effect-idx="' + i + '"]');
      if (el) {
        const v = el.value;
        if (f === 'pieces' || f === 'duration' || f === 'padding' || f === 'scale') {
          const n = Number(v);
          if (Number.isFinite(n)) entry[f] = n;
        } else if (v) {
          entry[f] = v;
        }
      }
    }
    s.effects[i] = entry;
  }
}

function collectAllEffects() {
  const result = {};
  for (const s of scenes) {
    collectEffectValues(s.name);
    if (s.effects && s.effects.length > 0) {
      result[s.name] = s.effects;
    }
  }
  return result;
}

async function saveEffects() {
  const fx = collectAllEffects();
  await fetch('/api/effects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fx),
  });
}

// ─── Camera Moves UI ─────────────────────────────────────────────────────

function getMovesForScene(sceneName) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s) return [];
  const nextScene = scenes[scenes.indexOf(s) + 1];
  const sceneEnd = nextScene ? nextScene.startMs : getPreviewDurationMs();
  return (DATA.cameraMoves ?? []).filter(m => m.startMs >= s.startMs && m.startMs < sceneEnd);
}

function renderCameraMovesFields(s) {
  const moves = getMovesForScene(s.name);
  const items = moves.map((m, i) => {
    const globalIdx = (DATA.cameraMoves ?? []).indexOf(m);
    return \`<div class="camera-move-entry">
      <div><label>Scale</label><input type="number" data-cm-field="scale" data-cm-idx="\${globalIdx}" step="0.1" min="1" max="5" value="\${m.scale ?? 1.5}"></div>
      <div><label>Duration</label><input type="number" data-cm-field="durationMs" data-cm-idx="\${globalIdx}" step="100" min="100" value="\${m.durationMs}"></div>
      <div><label>Hold</label><input type="number" data-cm-field="holdMs" data-cm-idx="\${globalIdx}" step="100" min="0" value="\${m.holdMs ?? 0}"></div>
      <div><label>Target</label><button class="btn-target" onclick="enterTargetMode(\${globalIdx})" title="Click on video to set zoom target">Set</button></div>
      <button class="btn btn-sm btn-danger" onclick="removeCameraMove(\${globalIdx})" title="Remove">&times;</button>
    </div>\`;
  }).join('');

  return \`<div class="camera-moves-section">
    <div class="section-title">
      <span>Camera Moves (\${moves.length})</span>
      <button class="btn btn-sm" onclick="addCameraMove('\${esc(s.name)}')">+ Add</button>
    </div>
    <div class="camera-moves-list" data-scene="\${esc(s.name)}">\${items}</div>
  </div>\`;
}

function refreshCameraMovesUI(sceneName) {
  const container = document.querySelector('.camera-moves-list[data-scene="' + sceneName + '"]');
  if (!container) return;
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s) return;
  const moves = getMovesForScene(sceneName);
  container.innerHTML = moves.map((m, i) => {
    const globalIdx = (DATA.cameraMoves ?? []).indexOf(m);
    return \`<div class="camera-move-entry">
      <div><label>Scale</label><input type="number" data-cm-field="scale" data-cm-idx="\${globalIdx}" step="0.1" min="1" max="5" value="\${m.scale ?? 1.5}"></div>
      <div><label>Duration</label><input type="number" data-cm-field="durationMs" data-cm-idx="\${globalIdx}" step="100" min="100" value="\${m.durationMs}"></div>
      <div><label>Hold</label><input type="number" data-cm-field="holdMs" data-cm-idx="\${globalIdx}" step="100" min="0" value="\${m.holdMs ?? 0}"></div>
      <div><label>Target</label><button class="btn-target" onclick="enterTargetMode(\${globalIdx})" title="Click on video to set zoom target">Set</button></div>
      <button class="btn btn-sm btn-danger" onclick="removeCameraMove(\${globalIdx})" title="Remove">&times;</button>
    </div>\`;
  }).join('');
  // Update count in header
  const section = container.closest('.camera-moves-section');
  const header = section?.querySelector('.section-title span');
  if (header) header.textContent = 'Camera Moves (' + moves.length + ')';
  wireCameraMoveListeners();
  renderTimelineMarkers();
}

function wireCameraMoveListeners() {
  document.querySelectorAll('[data-cm-field]').forEach(input => {
    input.addEventListener('change', () => {
      const idx = Number(input.dataset.cmIdx);
      const field = input.dataset.cmField;
      const move = DATA.cameraMoves?.[idx];
      if (!move) return;
      const val = parseFloat(input.value);
      if (!Number.isFinite(val)) return;
      if (field === 'scale') move.scale = val;
      else if (field === 'durationMs') move.durationMs = val;
      else if (field === 'holdMs') move.holdMs = val;
      markDirty();
      renderTimelineMarkers();
      applyCameraTransform(video.currentTime * 1000);
    });
  });
}

function addCameraMove(sceneName) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s) return;
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  if (!DATA.cameraMoves) DATA.cameraMoves = [];
  DATA.cameraMoves.push({
    scene: sceneName,
    startMs: s.startMs + 500,
    durationMs: 400,
    x: Math.round(vw / 2),
    y: Math.round(vh / 2),
    w: Math.round(vw / 3),
    h: Math.round(vh / 3),
    scale: 1.5,
    holdMs: 1000,
  });
  DATA.cameraMoves.sort((a, b) => a.startMs - b.startMs);
  refreshCameraMovesUI(sceneName);
  markDirty();
  applyCameraTransform(video.currentTime * 1000);
}

function removeCameraMove(globalIdx) {
  const move = DATA.cameraMoves?.[globalIdx];
  if (!move) return;
  const sceneName = move.scene ?? scenes.find(s => move.startMs >= s.startMs)?.name;
  DATA.cameraMoves.splice(globalIdx, 1);
  if (sceneName) refreshCameraMovesUI(sceneName);
  markDirty();
  applyCameraTransform(video.currentTime * 1000);
}

let targetModeIdx = -1;

function enterTargetMode(globalIdx) {
  targetModeIdx = globalIdx;
  document.querySelector('.video-container')?.classList.add('target-mode');
  document.querySelectorAll('.btn-target').forEach(b => b.classList.remove('active'));
  const activeBtn = document.querySelector('[onclick="enterTargetMode(' + globalIdx + ')"]');
  if (activeBtn) activeBtn.classList.add('active');
}

// Drag-to-select zoom region (macOS ⌘⇧4 style)
let dragStart = null; // { x, y } in video pixels
let isDraggingRegion = false;

const videoContainer = document.querySelector('.video-container');

videoContainer?.addEventListener('mousedown', (e) => {
  if (targetModeIdx < 0) return;
  e.preventDefault();
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  dragStart = {
    x: Math.round(((e.clientX - rect.left) / rect.width) * vw),
    y: Math.round(((e.clientY - rect.top) / rect.height) * vh),
  };
  isDraggingRegion = true;
  const regionEl = document.getElementById('camera-region');
  if (regionEl) { regionEl.classList.add('target-preview'); regionEl.style.display = 'block'; }
});

videoContainer?.addEventListener('mousemove', (e) => {
  if (!isDraggingRegion || targetModeIdx < 0 || !dragStart) return;
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const curX = Math.round(((e.clientX - rect.left) / rect.width) * vw);
  const curY = Math.round(((e.clientY - rect.top) / rect.height) * vh);

  // Draw the selection rectangle
  const x1 = Math.max(0, Math.min(dragStart.x, curX));
  const y1 = Math.max(0, Math.min(dragStart.y, curY));
  const x2 = Math.min(vw, Math.max(dragStart.x, curX));
  const y2 = Math.min(vh, Math.max(dragStart.y, curY));
  const w = Math.max(20, x2 - x1);
  const h = Math.max(20, y2 - y1);

  const scaleX = rect.width / vw;
  const scaleY = rect.height / vh;
  const regionEl = document.getElementById('camera-region');
  if (regionEl) {
    const videoOffset = video.offsetLeft || 0;
    const videoTop = video.offsetTop || 0;
    regionEl.style.left = (videoOffset + x1 * scaleX) + 'px';
    regionEl.style.top = (videoTop + y1 * scaleY) + 'px';
    regionEl.style.width = (w * scaleX) + 'px';
    regionEl.style.height = (h * scaleY) + 'px';
    const scale = Math.max(1.1, Math.min(5, vw / w));
    const label = regionEl.querySelector('.camera-region-label');
    if (label) label.textContent = scale.toFixed(1) + 'x zoom';
  }
});

videoContainer?.addEventListener('mouseup', (e) => {
  if (!isDraggingRegion || targetModeIdx < 0 || !dragStart) return;
  isDraggingRegion = false;
  const move = DATA.cameraMoves?.[targetModeIdx];
  if (!move) { dragStart = null; return; }

  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const endX = Math.round(((e.clientX - rect.left) / rect.width) * vw);
  const endY = Math.round(((e.clientY - rect.top) / rect.height) * vh);

  const x1 = Math.max(0, Math.min(dragStart.x, endX));
  const y1 = Math.max(0, Math.min(dragStart.y, endY));
  const x2 = Math.min(vw, Math.max(dragStart.x, endX));
  const y2 = Math.min(vh, Math.max(dragStart.y, endY));
  const w = Math.max(50, x2 - x1);
  const h = Math.max(50, y2 - y1);

  // Set camera move from the drawn region
  move.x = Math.round(x1 + w / 2); // center x
  move.y = Math.round(y1 + h / 2); // center y
  move.w = w;
  move.h = h;
  move.scale = Math.max(1.1, Math.min(5, Math.round((vw / w) * 10) / 10));

  // Update the scale input in the sidebar
  const scaleInput = document.querySelector('[data-cm-field="scale"][data-cm-idx="' + targetModeIdx + '"]');
  if (scaleInput) scaleInput.value = String(move.scale);

  // Keep region visible
  const regionEl = document.getElementById('camera-region');
  if (regionEl) regionEl.classList.remove('target-preview');
  updateCameraRegionOverlay({ scale: move.scale, x: move.x, y: move.y });

  document.querySelector('.video-container')?.classList.remove('target-mode');
  document.querySelectorAll('.btn-target').forEach(b => b.classList.remove('active'));
  targetModeIdx = -1;
  dragStart = null;
  markDirty();
  renderTimelineMarkers();
});

// Cancel drag if mouse released outside video container
document.addEventListener('mouseup', () => {
  if (isDraggingRegion) {
    isDraggingRegion = false;
    dragStart = null;
    if (targetModeIdx >= 0) {
      document.querySelector('.video-container')?.classList.remove('target-mode');
      document.querySelectorAll('.btn-target').forEach(b => b.classList.remove('active'));
      const regionEl = document.getElementById('camera-region');
      if (regionEl) { regionEl.classList.remove('target-preview'); regionEl.style.display = 'none'; }
      targetModeIdx = -1;
    }
  }
});

async function saveCameraMoves() {
  // Un-shift camera moves back to original (pre-trim) timeline for storage
  const trim = DATA.headTrimMs ?? 0;
  const moves = (DATA.cameraMoves ?? []).map(m => ({
    ...m,
    startMs: m.startMs + trim,
  }));
  await fetch('/api/camera-moves', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(moves),
  });
}

// ─── Cursor-Dwell Camera Suggestions ────────────────────────────────────

const DWELL_MOVE_THRESHOLD = 0.02; // 2% of viewport
const MIN_DWELL_MS = 450;
const MAX_DWELL_MS = 2600;
const dismissedSuggestions = new Set();

function detectDwells(telemetry) {
  if (!telemetry || telemetry.length < 2) return [];
  const sorted = [...telemetry].sort((a, b) => a.timeMs - b.timeMs);
  const dwells = [];
  let runStart = 0;

  for (let i = 1; i <= sorted.length; i++) {
    const broke = i === sorted.length ||
      Math.hypot(sorted[i].cx - sorted[i - 1].cx, sorted[i].cy - sorted[i - 1].cy) > DWELL_MOVE_THRESHOLD;
    if (broke) {
      const runLen = i - runStart;
      if (runLen >= 2) {
        const duration = sorted[i - 1].timeMs - sorted[runStart].timeMs;
        if (duration >= MIN_DWELL_MS && duration <= MAX_DWELL_MS) {
          let sumX = 0, sumY = 0;
          for (let j = runStart; j < i; j++) {
            sumX += sorted[j].cx;
            sumY += sorted[j].cy;
          }
          dwells.push({
            cx: sumX / runLen,
            cy: sumY / runLen,
            startMs: sorted[runStart].timeMs,
            durationMs: duration,
            id: runStart + '-' + duration,
          });
        }
      }
      runStart = i;
    }
  }
  return dwells;
}

function renderSuggestionMarkers() {
  timelineBar.querySelectorAll('.timeline-camera-suggestion').forEach(n => n.remove());
  const telemetry = DATA.cursorTelemetry ?? [];
  if (telemetry.length === 0) return;

  const totalMs = getPreviewDurationMs();
  if (!totalMs) return;

  const dwells = detectDwells(telemetry);
  const existingMoves = DATA.cameraMoves ?? [];

  for (const dwell of dwells) {
    if (dismissedSuggestions.has(dwell.id)) continue;
    // Skip if a camera move already exists near this dwell
    const hasMove = existingMoves.some(m =>
      Math.abs(m.startMs - dwell.startMs) < 1000 &&
      (m.scale ?? 1.5) > 1.0
    );
    if (hasMove) continue;

    const pct = (dwell.startMs / totalMs) * 100;
    const widthPct = (dwell.durationMs / totalMs) * 100;
    const el = document.createElement('div');
    el.className = 'timeline-camera-suggestion';
    el.style.left = pct + '%';
    el.style.width = Math.max(widthPct, 0.5) + '%';
    el.title = 'Suggested camera beat (' + (dwell.durationMs / 1000).toFixed(1) + 's dwell)';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showSuggestionTooltip(el, dwell);
    });
    timelineBar.appendChild(el);
  }
}

function showSuggestionTooltip(markerEl, dwell) {
  // Remove existing tooltips
  document.querySelectorAll('.suggestion-tooltip').forEach(t => t.remove());

  const tooltip = document.createElement('div');
  tooltip.className = 'suggestion-tooltip';

  const label = document.createElement('span');
  label.textContent = 'Add camera beat?';
  tooltip.appendChild(label);

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'btn-accept';
  acceptBtn.textContent = 'Accept';
  acceptBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    acceptSuggestion(dwell);
    tooltip.remove();
    markerEl.remove();
  });
  tooltip.appendChild(acceptBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'btn-dismiss';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissedSuggestions.add(dwell.id);
    tooltip.remove();
    markerEl.remove();
  });
  tooltip.appendChild(dismissBtn);

  markerEl.appendChild(tooltip);
}

function acceptSuggestion(dwell) {
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  if (!DATA.cameraMoves) DATA.cameraMoves = [];
  DATA.cameraMoves.push({
    startMs: Math.round(dwell.startMs),
    durationMs: 400,
    x: Math.round(dwell.cx * vw),
    y: Math.round(dwell.cy * vh),
    w: Math.round(vw / 1.5),
    h: Math.round(vh / 1.5),
    scale: 1.5,
    holdMs: Math.round(Math.min(dwell.durationMs, 2000)),
  });
  DATA.cameraMoves.sort((a, b) => a.startMs - b.startMs);
  // Refresh the scene that contains this timestamp
  const scene = scenes.find((s, i) => {
    const next = scenes[i + 1];
    return dwell.startMs >= s.startMs && (!next || dwell.startMs < next.startMs);
  });
  if (scene) refreshCameraMovesUI(scene.name);
  renderTimelineMarkers();
  renderSuggestionMarkers();
  markDirty();
}

// Render suggestions on load
setTimeout(renderSuggestionMarkers, 500);

// ─── CSS Transform Camera Preview ───────────────────────────────────────

function computeCameraTransform(currentMs) {
  const moves = DATA.cameraMoves ?? [];
  if (moves.length === 0) return null;
  const CHAIN_GAP = 1500;

  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    const scale = m.scale ?? 1.5;
    if (scale <= 1.0) continue;

    const fadeIn = m.durationMs;
    const hold = m.holdMs ?? 0;
    const fadeOut = fadeIn;
    const start = m.startMs;
    const zoomInEnd = start + fadeIn;
    const holdEnd = zoomInEnd + hold;
    const zoomOutEnd = holdEnd + fadeOut;

    // Check for chained next move
    const next = moves[i + 1];
    const nextScale = next?.scale ?? 1.5;
    const isChained = next && nextScale > 1.0 && (next.startMs - zoomOutEnd) >= 0 && (next.startMs - zoomOutEnd) <= CHAIN_GAP;

    // Zoom in
    if (currentMs >= start && currentMs < zoomInEnd) {
      const t = (currentMs - start) / fadeIn;
      const s = 1 + t * (scale - 1);
      return { scale: s, x: m.x, y: m.y };
    }
    // Hold
    if (currentMs >= zoomInEnd && currentMs < holdEnd) {
      return { scale, x: m.x, y: m.y };
    }
    // Chained pan or zoom out
    if (isChained) {
      const panDur = Math.max(100, Math.min(1000, next.startMs - holdEnd + next.durationMs));
      const panEnd = holdEnd + panDur;
      if (currentMs >= holdEnd && currentMs < panEnd) {
        const t = (currentMs - holdEnd) / panDur;
        const eased = 1 - Math.pow(1 - t, 3);
        const s = scale + (nextScale - scale) * eased;
        const x = m.x + (next.x - m.x) * eased;
        const y = m.y + (next.y - m.y) * eased;
        return { scale: s, x, y };
      }
      if (currentMs >= panEnd && currentMs < next.startMs + next.durationMs) {
        return { scale: nextScale, x: next.x, y: next.y };
      }
    } else if (currentMs >= holdEnd && currentMs < zoomOutEnd) {
      const t = 1 - (currentMs - holdEnd) / fadeOut;
      const s = 1 + t * (scale - 1);
      return { scale: s, x: m.x, y: m.y };
    }
  }
  return null;
}

let cameraPreviewEnabled = true;

function updateCameraRegionOverlay(cam) {
  const regionEl = document.getElementById('camera-region');
  if (!regionEl) return;
  if (!cam || cam.scale <= 1.01) {
    regionEl.style.display = 'none';
    return;
  }
  const rect = video.getBoundingClientRect();
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const scaleX = rect.width / vw;
  const scaleY = rect.height / vh;

  // Region size: what portion of the frame is visible at this zoom
  const regionW = vw / cam.scale;
  const regionH = vh / cam.scale;
  // Region position: centered on focus point, clamped to frame
  const regionX = Math.max(0, Math.min(cam.x - regionW / 2, vw - regionW));
  const regionY = Math.max(0, Math.min(cam.y - regionH / 2, vh - regionH));

  // Convert to CSS pixels relative to video element
  const videoOffset = video.offsetLeft || 0;
  const videoTop = video.offsetTop || 0;
  regionEl.style.display = 'block';
  regionEl.style.left = (videoOffset + regionX * scaleX) + 'px';
  regionEl.style.top = (videoTop + regionY * scaleY) + 'px';
  regionEl.style.width = (regionW * scaleX) + 'px';
  regionEl.style.height = (regionH * scaleY) + 'px';

  const label = regionEl.querySelector('.camera-region-label');
  if (label) label.textContent = cam.scale.toFixed(1) + 'x zoom';
}

function applyCameraTransform(currentMs) {
  const regionEl = document.getElementById('camera-region');
  if (!cameraPreviewEnabled) {
    video.style.transform = '';
    if (regionEl) regionEl.style.display = 'none';
    return;
  }
  const cam = computeCameraTransform(currentMs);
  if (!cam || cam.scale <= 1.01) {
    video.style.transform = '';
    video.style.transformOrigin = '';
    if (regionEl) regionEl.style.display = 'none';
    return;
  }
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const originX = (cam.x / vw) * 100;
  const originY = (cam.y / vh) * 100;
  video.style.transformOrigin = originX + '% ' + originY + '%';
  video.style.transform = 'scale(' + cam.scale.toFixed(3) + ')';
  updateCameraRegionOverlay(cam);
}

async function saveTiming() {
  const timing = {};
  for (const s of scenes) {
    timing[s.name] = s.startMs;
  }
  await fetch('/api/save-timing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timing }),
  });
}

function previewEffect(sceneName, index) {
  const s = scenes.find(sc => sc.name === sceneName);
  if (!s?.effects?.[index]) return;
  collectEffectValues(sceneName);
  const effect = s.effects[index];
  if (effect.type === 'confetti') {
    fireConfettiPreview(effect);
  }
  // Camera effects need a target in the recorded page — show status hint
  if (['spotlight', 'focus-ring', 'dim-around', 'zoom-to'].includes(effect.type)) {
    setStatus('Camera effects are applied during recording — re-record to see changes', 'saving');
    setTimeout(() => { statusEl.textContent = 'Ready'; statusEl.className = 'status'; }, 2500);
  }
}

function fireConfettiPreview(effect) {
  const spread = effect.spread ?? 'burst';
  const pieces = effect.pieces ?? 150;
  const duration = effect.duration ?? 3000;
  const fadeOut = 800;
  const colors = ['#3b82f6', '#06b6d4', '#4ade80', '#f59e0b', '#ef4444', '#a78bfa'];
  const id = 'argo-confetti-preview';
  document.getElementById(id)?.remove();

  const videoContainer = document.querySelector('.video-container');
  const canvas = document.createElement('canvas');
  canvas.id = id;
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10';
  videoContainer.appendChild(canvas);
  canvas.width = videoContainer.offsetWidth;
  canvas.height = videoContainer.offsetHeight;
  const ctx = canvas.getContext('2d');

  const particles = [];
  for (let i = 0; i < pieces; i++) {
    const color = colors[Math.floor(Math.random() * colors.length)];
    const w = 6 + Math.random() * 8;
    const h = 4 + Math.random() * 6;
    const rot = Math.random() * Math.PI * 2;
    const rv = (Math.random() - 0.5) * 0.2;
    if (spread === 'burst') {
      const cx = canvas.width / 2;
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
      const speed = 4 + Math.random() * 8;
      particles.push({ x: cx + (Math.random() - 0.5) * 40, y: -10, w, h, color, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, rot, rv });
    } else {
      particles.push({ x: Math.random() * canvas.width, y: -Math.random() * canvas.height, w, h, color, vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * 4, rot, rv });
    }
  }

  const startTime = performance.now();
  function frame() {
    const elapsed = performance.now() - startTime;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.rot += p.rv; p.vy += 0.15;
      if (spread === 'burst') p.vx *= 0.99;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed >= duration) {
      const fadeProgress = Math.min(1, (elapsed - duration) / fadeOut);
      canvas.style.opacity = String(1 - fadeProgress);
      if (fadeProgress >= 1) { canvas.remove(); return; }
    }
    if (particles.some(p => p.y < canvas.height + 50) || elapsed < duration + fadeOut) {
      requestAnimationFrame(frame);
    } else { canvas.remove(); }
  }
  requestAnimationFrame(frame);
}

const manuallyCollapsed = new Set();

// ─── Actions ───────────────────────────────────────────────────────────────
function seekToScene(s) {
  scenePlaybackEndMs = null;
  void seekAbsoluteMs(getSceneBounds(s).startMs);
  activeScene = s;
  updateActiveSceneUI();
}

function updateActiveSceneUI() {
  document.querySelectorAll('.scene-card').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.timeline-scene').forEach(m => m.classList.remove('active'));
  if (activeScene) {
    const card = document.querySelector('.scene-card[data-scene="' + activeScene.name + '"]');
    if (card) {
      card.classList.add('active');
      // Auto-expand active scene (unless user manually collapsed it), collapse others
      document.querySelectorAll('.scene-card.expanded').forEach(c => {
        if (c !== card) c.classList.remove('expanded');
      });
      if (!manuallyCollapsed.has(activeScene.name)) {
        card.classList.add('expanded');
      }
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    const marker = document.querySelector('.timeline-scene[data-scene="' + activeScene.name + '"]');
    if (marker) marker.classList.add('active');
  }
}

function getSceneBounds(s) {
  const startMs = s.report?.startMs ?? s.startMs;
  const endMs = s.report?.endMs ?? (startMs + (DATA.sceneDurations[s.name] ?? 0));
  return {
    startMs,
    endMs,
    durationMs: Math.max(0, endMs - startMs),
  };
}

async function seekAbsoluteMs(absoluteMs) {
  const targetMs = Math.max(0, absoluteMs);
  const targetSec = targetMs / 1000;
  const requestId = ++latestSeekRequest;


  if (video.readyState < 1) {
    await new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true }));
  }

  if (Math.abs(video.currentTime - targetSec) > 0.01 || video.seeking) {
    await new Promise(resolve => {
      const onSeeked = () => resolve();
      video.addEventListener('seeked', onSeeked, { once: true });
      video.currentTime = targetSec;
    });
  } else {
  }

  if (requestId !== latestSeekRequest) {
    return;
  }

  const totalMs = getPreviewDurationMs();
  if (totalMs > 0) {
    const pct = (targetMs / totalMs) * 100;
    timelineProgress.style.width = pct + '%';
    document.getElementById('timeline-playhead').style.left = pct + '%';
  }
  document.getElementById('time-current').textContent = formatTime(targetMs);
  updateOverlayVisibility(targetMs);
  updateSceneScrubUI(targetMs);
  syncAudio();
}

function updateSceneScrubUI(currentMs = video.currentTime * 1000) {
  for (const s of scenes) {
    const { startMs, durationMs } = getSceneBounds(s);
    const localMs = Math.max(0, Math.min(durationMs, currentMs - startMs));
    const scrub = document.querySelector('[data-field="scene-scrub"][data-scene="' + s.name + '"]');
    if (scrub) {
      scrub.max = String(durationMs);
      scrub.value = String(localMs);
      scrub.disabled = durationMs <= 0;
    }
    const currentLabel = document.querySelector('[data-scene-scrub-current="' + s.name + '"]');
    const totalLabel = document.querySelector('[data-scene-scrub-total="' + s.name + '"]');
    if (currentLabel) currentLabel.textContent = formatSeconds(localMs);
    if (totalLabel) totalLabel.textContent = formatSeconds(durationMs);
  }
}

async function handleSceneScrubInput(sceneName, rawValue) {
  const s = scenes.find((scene) => scene.name === sceneName);
  if (!s) return;
  if (!scrubState.has(sceneName)) {
    scrubState.set(sceneName, { resumeAfter: !video.paused });
    video.pause();
  }
  const { startMs, durationMs } = getSceneBounds(s);
  const offsetMs = Math.max(0, Math.min(durationMs, Number(rawValue) || 0));
  scenePlaybackEndMs = null;
  activeScene = s;
  updateActiveSceneUI();
  await seekAbsoluteMs(startMs + offsetMs);
}

async function handleSceneScrubCommit(sceneName, rawValue) {
  await handleSceneScrubInput(sceneName, rawValue);
  const state = scrubState.get(sceneName);
  scrubState.delete(sceneName);
  if (state?.resumeAfter) {
    void video.play().then(async () => {
      if (document.getElementById('cb-audio').checked) {
        await playAudio();
      }
      showPauseIcon();
    });
  }
}

function nudgeScene(sceneName, deltaMs) {
  const s = scenes.find(s => s.name === sceneName);
  if (!s) return;
  const scrub = document.querySelector('[data-field="scene-scrub"][data-scene="' + sceneName + '"]');
  const currentMs = scrub ? Number(scrub.value) || 0 : 0;
  void handleSceneScrubCommit(sceneName, currentMs + deltaMs);
}

async function previewScene(sceneName) {
  await initAudio();
  const s = scenes.find(s => s.name === sceneName);
  if (!s) return;
  const { startMs, endMs, durationMs } = getSceneBounds(s);
  if (!durationMs) return;
  // Pause first to prevent timeupdate race, then seek, then play
  video.pause();
  stopAudio();
  scenePlaybackEndMs = null;
  await seekAbsoluteMs(startMs);
  // Verify seek landed — some browsers reset on play()
  if (Math.abs(video.currentTime - startMs / 1000) > 0.1) {
    video.currentTime = startMs / 1000;
    await new Promise(r => video.addEventListener('seeked', r, { once: true }));
  }
  activeScene = s;
  updateActiveSceneUI();
  scenePlaybackEndMs = endMs;
  await video.play();
  if (document.getElementById('cb-audio').checked) await playAudio();
  showPauseIcon();
}

async function regenClip(sceneName, btn) {
  btn.disabled = true;
  btn.textContent = 'Generating...';
  setStatus('Regenerating TTS for ' + sceneName + '...', 'saving');

  try {
    // Save current voiceover + timing state first (new scenes need timing marks)
    await saveVoiceover();
    await saveTiming();

    const resp = await fetch('/api/regen-clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: sceneName }),
    });
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error);

    // Update local duration data
    if (result.sceneDurations) DATA.sceneDurations = result.sceneDurations;
    if (result.sceneReport) DATA.sceneReport = result.sceneReport;

    // Reload aligned audio
    await initAudio();
    // Update scene objects
    for (const s of scenes) {
      s.vo = DATA.voiceover.find(v => v.scene === s.name);
      s.overlay = DATA.overlays.find(o => o.scene === s.name);
      s.rendered = DATA.renderedOverlays[s.name];
      s.report = DATA.sceneReport?.scenes?.find(r => r.scene === s.name);
    }
    updateSceneDuration(sceneName);
    updateSceneScrubUI(video.currentTime * 1000);

    setStatus('TTS regenerated for ' + sceneName, 'saved');
  } catch (err) {
    setStatus('Regen failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regen TTS';
  }
}

// Sync DOM form values back to in-memory scenes array.
// Called before renderSceneList() to preserve user edits.
function syncFormValuesToScenes() {
  for (const s of scenes) {
    const textEl = document.querySelector('textarea[data-scene="' + s.name + '"][data-field="text"]');
    if (textEl && textEl.value) {
      if (!s.vo) s.vo = { scene: s.name, text: '' };
      s.vo.text = textEl.value;
    }
    const voiceEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="voice"]');
    if (voiceEl?.value && s.vo) s.vo.voice = voiceEl.value;
    const speedEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="speed"]');
    if (speedEl?.value && s.vo) s.vo.speed = parseFloat(speedEl.value);
    const pbSpeedEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="playbackSpeed"]');
    const pbVal = pbSpeedEl?.value ? parseFloat(pbSpeedEl.value) : undefined;
    s.playbackSpeed = (Number.isFinite(pbVal) && pbVal !== 1.0) ? pbVal : undefined;
  }
}


function collectVoiceover() {
  return scenes.map(s => {
    const textEl = document.querySelector('textarea[data-scene="' + s.name + '"][data-field="text"]');
    const voiceEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="voice"]');
    const speedEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="speed"]');
    const entry = { ...(s.vo ?? { scene: s.name }), scene: s.name, text: textEl?.value ?? '' };
    if (voiceEl?.value) entry.voice = voiceEl.value;
    else delete entry.voice;

    const speed = speedEl?.value ? parseFloat(speedEl.value) : undefined;
    if (Number.isFinite(speed)) entry.speed = speed;
    else delete entry.speed;

    const pbSpeedEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="playbackSpeed"]');
    const pbSpeed = pbSpeedEl?.value ? parseFloat(pbSpeedEl.value) : undefined;
    if (Number.isFinite(pbSpeed) && pbSpeed !== 1.0) entry.playbackSpeed = pbSpeed;
    else delete entry.playbackSpeed;

    return entry;
  });
}

function collectOverlays() {
  // Serialize from s.overlay (single source of truth) — no DOM reading
  return scenes
    .filter(s => s.overlay?.type)
    .map(s => ({ ...s.overlay, scene: s.name }));
}

async function saveVoiceover() {
  const vo = collectVoiceover();
  await fetch('/api/voiceover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(vo),
  });
}

// Render-only preview (no disk write) — called on overlay field edits
async function previewOverlays() {
  const ov = collectOverlays();
  const resp = await fetch('/api/render-overlays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ov),
  });
  const result = await resp.json();
  if (result.renderedOverlays) {
    DATA.renderedOverlays = result.renderedOverlays;
    for (const s of scenes) {
      s.rendered = DATA.renderedOverlays[s.name];
    }
    renderOverlayElements();
    updateOverlayVisibility(video.currentTime * 1000);
  }
}

// Persist to disk — called only by Save button
async function saveOverlays() {
  const ov = collectOverlays();
  const resp = await fetch('/api/overlays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ov),
  });
  const result = await resp.json();
  if (result.renderedOverlays) {
    DATA.renderedOverlays = result.renderedOverlays;
    for (const s of scenes) {
      s.rendered = DATA.renderedOverlays[s.name];
    }
    renderOverlayElements();
    updateOverlayVisibility(video.currentTime * 1000);
  }
}

// ─── Scene snapshots (for per-scene undo) ──────────────────────────────────
const sceneSnapshots = new Map();

function snapshotAllScenes() {
  for (const s of scenes) {
    sceneSnapshots.set(s.name, {
      text: s.vo?.text ?? '',
      voice: s.vo?.voice ?? '',
      speed: s.vo?.speed ?? '',
      playbackSpeed: s.playbackSpeed ?? '',
      overlay: s.overlay ? JSON.parse(JSON.stringify(s.overlay)) : null,
      effects: s.effects?.length ? JSON.parse(JSON.stringify(s.effects)) : [],
      cameraMoves: JSON.parse(JSON.stringify(getMovesForScene(s.name))),
    });
  }
}

function getSceneSnapshot(sceneName) {
  return sceneSnapshots.get(sceneName);
}

function isSceneModified(sceneName) {
  const snap = getSceneSnapshot(sceneName);
  if (!snap) return false;
  const card = document.querySelector('.scene-card[data-scene="' + sceneName + '"]');
  if (!card) return false;
  const text = card.querySelector('[data-field="text"]')?.value ?? '';
  const voice = card.querySelector('[data-field="voice"]')?.value ?? '';
  const speed = card.querySelector('[data-field="speed"]')?.value ?? '';
  const pbSpeed = card.querySelector('[data-field="playbackSpeed"]')?.value ?? '';
  if (text !== snap.text || voice !== snap.voice || String(speed) !== String(snap.speed) || String(pbSpeed) !== String(snap.playbackSpeed)) return true;
  // Check overlay and effects from s.overlay / s.effects (single source of truth)
  const s = scenes.find(sc => sc.name === sceneName);
  const currentOverlay = s?.overlay;
  const snapOverlay = snap.overlay;
  if (JSON.stringify(currentOverlay ?? null) !== JSON.stringify(snapOverlay ?? null)) return true;
  // Check effects
  const currentEffects = JSON.stringify(s?.effects ?? []);
  const snapEffects = JSON.stringify(snap.effects ?? []);
  if (currentEffects !== snapEffects) return true;
  // Check camera moves
  const currentMoves = JSON.stringify(getMovesForScene(sceneName));
  const snapMoves = JSON.stringify(snap.cameraMoves ?? []);
  if (currentMoves !== snapMoves) return true;
  return false;
}

function updateUndoButton(sceneName) {
  const btn = document.querySelector('.btn-undo[data-scene="' + sceneName + '"]');
  const card = document.querySelector('.scene-card[data-scene="' + sceneName + '"]');
  const modified = isSceneModified(sceneName);
  if (btn) btn.style.display = modified ? '' : 'none';
  if (card) card.classList.toggle('modified', modified);
}

function updateAllUndoButtons() {
  for (const s of scenes) updateUndoButton(s.name);
}

function undoScene(sceneName) {
  const snap = getSceneSnapshot(sceneName);
  if (!snap) return;
  const card = document.querySelector('.scene-card[data-scene="' + sceneName + '"]');
  if (!card) return;
  // Restore voiceover fields
  const textEl = card.querySelector('[data-field="text"]');
  if (textEl) textEl.value = snap.text;
  const voiceEl = card.querySelector('[data-field="voice"]');
  if (voiceEl) voiceEl.value = snap.voice;
  const speedEl = card.querySelector('[data-field="speed"]');
  if (speedEl) speedEl.value = snap.speed;
  const pbSpeedEl = card.querySelector('[data-field="playbackSpeed"]');
  if (pbSpeedEl) pbSpeedEl.value = snap.playbackSpeed;
  // Restore effects
  const s = scenes.find(sc => sc.name === sceneName);
  if (s) {
    s.effects = snap.effects?.length ? JSON.parse(JSON.stringify(snap.effects)) : [];
    refreshEffectsUI(sceneName);
  }
  // Restore camera moves
  if (s && snap.cameraMoves) {
    // Remove current moves for this scene and replace with snapshot
    const currentMoves = getMovesForScene(sceneName);
    for (const m of currentMoves) {
      const idx = (DATA.cameraMoves ?? []).indexOf(m);
      if (idx >= 0) DATA.cameraMoves.splice(idx, 1);
    }
    const restored = JSON.parse(JSON.stringify(snap.cameraMoves));
    if (!DATA.cameraMoves) DATA.cameraMoves = [];
    DATA.cameraMoves.push(...restored);
    DATA.cameraMoves.sort((a, b) => a.startMs - b.startMs);
    refreshCameraMovesUI(sceneName);
    renderTimelineMarkers();
  }
  // Restore overlay from snapshot into s.overlay (single source of truth)
  if (s) {
    s.overlay = snap.overlay ? JSON.parse(JSON.stringify(snap.overlay)) : undefined;
  }
  // Restore overlay type (triggers field re-render via updateOverlayFieldsForScene)
  const typeEl = card.querySelector('[data-field="overlay-type"]');
  if (typeEl) {
    typeEl.value = snap.overlay?.type ?? '';
    updateOverlayFieldsForScene(sceneName);
  }
  // Restore overlay field values in DOM after re-render
  setTimeout(() => {
    const so = snap.overlay || {};
    const textField = card.querySelector('[data-field="overlay-text"]');
    if (textField) {
      textField.value = so.type === 'lower-third' || so.type === 'callout' ? (so.text ?? '') : so.type === 'arrow' ? (so.label ?? '') : (so.title ?? '');
    }
    const bodyField = card.querySelector('[data-field="overlay-body"]');
    if (bodyField) bodyField.value = so.body ?? '';
    const kickerField = card.querySelector('[data-field="overlay-kicker"]');
    if (kickerField) kickerField.value = so.kicker ?? '';
    const srcField = card.querySelector('[data-field="overlay-src"]');
    if (srcField) srcField.value = so.src ?? '';
    const dirField = card.querySelector('[data-field="overlay-direction"]');
    if (dirField) dirField.value = so.direction ?? 'down';
    const colorField = card.querySelector('[data-field="overlay-color"]');
    if (colorField) colorField.value = so.color ?? '#ef4444';
    const sizeField = card.querySelector('[data-field="overlay-size"]');
    if (sizeField) sizeField.value = String(so.size ?? 48);
    const autoBgField = card.querySelector('[data-field="overlay-autoBackground"]');
    if (autoBgField) autoBgField.checked = !!so.autoBackground;
    const placementField = card.querySelector('[data-field="overlay-placement"]');
    if (placementField) placementField.value = so.placement ?? 'bottom-center';
    const motionField = card.querySelector('[data-field="overlay-motion"]');
    if (motionField) motionField.value = so.motion ?? 'none';
    // Re-render overlay preview for this scene only
    renderSingleSceneOverlay(sceneName);
    updateUndoButton(sceneName);
    // Check if all scenes are back to saved state
    const anyModified = scenes.some(s => isSceneModified(s.name));
    if (!anyModified) clearDirty();
  }, 0);
}

// ─── Dirty state ───────────────────────────────────────────────────────────
let isDirty = false;

function markDirty() {
  isDirty = true;
  const saveBtn = document.getElementById('btn-save');
  saveBtn.classList.add('dirty');
  saveBtn.textContent = '\\u25cf Save';
  updateAllUndoButtons();
}

function clearDirty() {
  isDirty = false;
  const saveBtn = document.getElementById('btn-save');
  saveBtn.classList.remove('dirty');
  saveBtn.textContent = 'Save';
  snapshotAllScenes();
  updateAllUndoButtons();
}

// Save button
document.getElementById('btn-save').addEventListener('click', async () => {
  const saveBtn = document.getElementById('btn-save');
  setStatus('Saving...', 'saving');
  try {
    await saveVoiceover();
    await saveOverlays();
    await saveEffects();
    await saveCameraMoves();
    await saveTiming();
    clearDirty();
    setStatus('All changes saved', 'saved');
    saveBtn.textContent = '\\u2713 Saved';
    saveBtn.classList.add('saved');
    setTimeout(() => {
      if (!isDirty) {
        saveBtn.textContent = 'Save';
        saveBtn.classList.remove('saved');
      }
    }, 2000);
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'error');
  }
});

// Export button (re-align audio + export MP4, no re-recording)
document.getElementById('btn-export').addEventListener('click', async () => {
  // Always save before export to ensure timing marks + voiceover are persisted
  await saveVoiceover();
  await saveOverlays();
  await saveEffects();
  await saveCameraMoves();
  await saveTiming();
  clearDirty();
  const overlay = document.getElementById('recording-overlay');
  const title = document.getElementById('recording-title');
  const subtitle = document.getElementById('recording-subtitle');
  overlay.classList.remove('success', 'error');
  overlay.classList.add('active');
  title.textContent = 'Exporting video...';
  subtitle.textContent = 'Re-aligning audio and exporting MP4.';
  video.pause();
  stopAudio();
  showPlayIcon();
  try {
    const musicInclude = document.getElementById('music-include');
    const musicVolume = document.getElementById('music-volume');
    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        includeBgm: musicInclude ? musicInclude.checked : true,
        musicVolume: musicVolume ? Number(musicVolume.value) : undefined,
      }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error);
    overlay.classList.add('success');
    title.textContent = 'Export complete!';
    subtitle.textContent = 'Reloading preview...';
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    overlay.classList.add('error');
    title.textContent = 'Export failed';
    subtitle.textContent = err.message;
    setTimeout(() => overlay.classList.remove('active', 'error'), 5000);
  }
});

// Re-record button
document.getElementById('btn-rerecord').addEventListener('click', async () => {
  if (isDirty && !confirm('You have unsaved changes. Save before re-recording?')) return;
  if (isDirty) {
    await saveVoiceover();
    await saveOverlays();
    await saveEffects();
    await saveCameraMoves();
    await saveTiming();
    clearDirty();
  }
  const overlay = document.getElementById('recording-overlay');
  const title = document.getElementById('recording-title');
  const subtitle = document.getElementById('recording-subtitle');
  const live = document.getElementById('recording-live');
  overlay.classList.remove('success', 'error');
  overlay.classList.add('active');
  title.textContent = 'Re-recording pipeline...';
  subtitle.textContent = 'All editing is paused while the pipeline runs.';
  live.classList.remove('has-frame');
  live.style.backgroundImage = '';
  video.pause();
  stopAudio();
  showPlayIcon();

  // Poll the screencast onFrame output (.live-frame.jpg) while the pipeline runs.
  // Cache-bust with a timestamp; the server already sets no-store but some
  // proxies are stubborn.
  const livePoll = setInterval(async () => {
    try {
      const r = await fetch('/live-frame.jpg?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      // Revoke the previous URL on next tick to avoid leaking blobs.
      const prev = live.dataset.prevUrl;
      live.dataset.prevUrl = url;
      live.style.backgroundImage = 'url(' + url + ')';
      live.classList.add('has-frame');
      if (prev) URL.revokeObjectURL(prev);
    } catch { /* ignore — polling is best-effort */ }
  }, 750);

  try {
    const resp = await fetch('/api/rerecord', { method: 'POST' });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error);
    overlay.classList.add('success');
    title.textContent = 'Recording complete!';
    subtitle.textContent = 'Reloading preview...';
    setTimeout(() => location.reload(), 1500);
  } catch (err) {
    overlay.classList.add('error');
    title.textContent = 'Recording failed';
    subtitle.textContent = err.message;
    setTimeout(() => overlay.classList.remove('active', 'error'), 5000);
  } finally {
    clearInterval(livePoll);
    const prev = live.dataset.prevUrl;
    if (prev) { URL.revokeObjectURL(prev); delete live.dataset.prevUrl; }
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m + ':' + String(s % 60).padStart(2, '0');
}

function formatSeconds(ms) {
  return (Math.max(0, ms) / 1000).toFixed(1) + 's';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (cls || '');
  if (cls === 'saved') setTimeout(() => { statusEl.textContent = 'Ready'; statusEl.className = 'status'; }, 3000);
}

function updateSceneDuration(sceneName) {
  const badge = document.querySelector('.scene-card[data-scene="' + sceneName + '"] .scene-duration');
  const durationMs = DATA.sceneDurations[sceneName];
  if (!badge || !durationMs) return;
  badge.textContent = (durationMs / 1000).toFixed(1) + 's';
}

// ─── Sidebar tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.sidebar-panel').forEach(p => p.style.display = 'none');
    document.getElementById('panel-' + tab.dataset.tab).style.display = '';
  });
});

// Render metadata if available
if (DATA.pipelineMeta) {
  const meta = DATA.pipelineMeta;
  const lines = [];
  lines.push('Created: ' + (meta.createdAt || 'unknown'));
  lines.push('');
  if (meta.tts) {
    lines.push('TTS Engine');
    const tts = meta.tts;
    for (const [k, v] of Object.entries(tts)) {
      lines.push('  ' + k + ': ' + v);
    }
    lines.push('');
  }
  if (meta.video) {
    lines.push('Video');
    const vid = meta.video;
    lines.push('  resolution: ' + vid.width + 'x' + vid.height);
    lines.push('  fps: ' + vid.fps);
    lines.push('  browser: ' + vid.browser);
    if (vid.deviceScaleFactor > 1) lines.push('  scale: ' + vid.deviceScaleFactor + 'x');
    lines.push('');
  }
  if (meta.export) {
    lines.push('Export');
    lines.push('  preset: ' + meta.export.preset);
    lines.push('  crf: ' + meta.export.crf);
    lines.push('');
  }
  if (meta.scenes) {
    lines.push('Scenes');
    for (const s of meta.scenes) {
      const dur = s.durationMs ? ' (' + (s.durationMs / 1000).toFixed(1) + 's)' : '';
      lines.push('  ' + s.scene + ': voice=' + (s.voice || 'default') + ' speed=' + (s.speed || 1) + dur);
    }
  }
  document.getElementById('metadata-content').textContent = lines.join('\\n');
} else {
  document.getElementById('metadata-content').textContent = 'No pipeline metadata found.\\n\\nRun argo pipeline to generate metadata.';
}

// ─── Background Music (MusicGen via Transformers.js) ───────────────────────
(function initMusicPanel() {
  const musicPanel = document.getElementById('music-panel');
  const musicHeader = document.getElementById('music-panel-header');
  const musicPrompt = document.getElementById('music-prompt');
  const musicDuration = document.getElementById('music-duration');
  const musicDurLabel = document.getElementById('music-dur-label');
  const musicGenerateBtn = document.getElementById('music-generate-btn');
  const musicProgress = document.getElementById('music-progress');
  const musicProgressFill = document.getElementById('music-progress-fill');
  const musicProgressText = document.getElementById('music-progress-text');
  const musicAudio = document.getElementById('music-audio');
  const musicInclude = document.getElementById('music-include');
  const musicVolume = document.getElementById('music-volume');
  const musicVolumeLabel = document.getElementById('music-volume-label');
  const musicHelp = document.getElementById('music-help');
  const musicSaveBtn = document.getElementById('music-save-btn');
  const musicStatus = document.getElementById('music-status');

  let generatedWavBlob = null;
  let hasGeneratedBgm = DATA.bgm?.hasGenerated ?? false;
  const hasConfigBgm = DATA.bgm?.hasConfig ?? false;

  function updateMusicVolumeLabel() {
    musicVolumeLabel.textContent = Number(musicVolume.value).toFixed(2);
  }

  function updateMusicHelp() {
    const source = hasGeneratedBgm ? 'generated BGM' : (hasConfigBgm ? 'config music' : 'no music source');
    musicHelp.textContent = musicInclude.checked
      ? 'Export will include ' + source + ' at a fixed mix level. No re-record needed.'
      : 'Export will skip background music. No re-record needed.';
  }

  // Toggle panel
  musicHeader.addEventListener('click', () => {
    musicPanel.classList.toggle('expanded');
  });

  // Preset buttons
  document.querySelectorAll('.music-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      musicPrompt.value = btn.dataset.preset;
    });
  });

  // Duration slider
  musicDuration.addEventListener('input', () => {
    musicDurLabel.textContent = musicDuration.value + 's';
  });
  musicInclude.checked = DATA.bgm?.include ?? false;
  musicVolume.value = String(DATA.bgm?.volume ?? 0.15);
  updateMusicVolumeLabel();
  updateMusicHelp();
  musicInclude.addEventListener('change', updateMusicHelp);
  musicVolume.addEventListener('input', updateMusicVolumeLabel);
  musicVolume.addEventListener('change', updateMusicHelp);

  // WAV encoder (Float32, mono)
  function encodeWavFloat32(samples, sampleRate) {
    const numSamples = samples.length;
    const byteRate = sampleRate * 4; // Float32 = 4 bytes
    const blockAlign = 4;
    const dataSize = numSamples * 4;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    // RIFF header
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    view.setUint32(8, 0x57415645, false); // "WAVE"
    // fmt chunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 3, true); // format = IEEE Float
    view.setUint16(22, 1, true); // channels = 1
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 32, true); // bits per sample
    // data chunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, dataSize, true);
    const floatView = new Float32Array(buffer, 44);
    floatView.set(samples);
    return new Blob([buffer], { type: 'audio/wav' });
  }

  // MusicGen runs in a Web Worker served from /musicgen-worker.js (same-origin).
  // This avoids blob URL cross-origin import restrictions and keeps the UI responsive.
  let musicWorker = null;

  function createMusicWorker() {
    const w = new Worker('/musicgen-worker.js', { type: 'module' });
    return w;
  }

  function showProgress(msg) {
    musicProgress.style.display = 'block';
    musicProgressText.textContent = msg;
  }

  function setProgressBar(pct) {
    musicProgressFill.style.width = Math.min(100, Math.max(0, pct)) + '%';
  }

  // Generate button
  musicGenerateBtn.addEventListener('click', () => {
    const prompt = musicPrompt.value.trim();
    if (!prompt) {
      musicStatus.textContent = 'Please enter a music prompt.';
      return;
    }
    const durationSec = parseInt(musicDuration.value, 10);

    musicGenerateBtn.disabled = true;
    musicSaveBtn.style.display = 'none';
    musicAudio.style.display = 'none';
    generatedWavBlob = null;
    showProgress('Initializing...');
    setProgressBar(10);
    musicStatus.textContent = '';

    if (!musicWorker) {
      musicWorker = createMusicWorker();
      musicWorker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          showProgress(msg.message);
          if (msg.message.includes('tokenizer')) setProgressBar(20);
          else if (msg.message.includes('Model loaded')) setProgressBar(50);
          else if (msg.message.includes('Generating')) setProgressBar(60);
        } else if (msg.type === 'complete') {
          setProgressBar(100);
          showProgress('Done!');
          generatedWavBlob = encodeWavFloat32(msg.audioData, msg.sampleRate);
          const url = URL.createObjectURL(generatedWavBlob);
          musicAudio.src = url;
          musicAudio.style.display = 'block';
          musicSaveBtn.style.display = 'inline-block';
          musicGenerateBtn.disabled = false;
          setTimeout(() => { musicProgress.style.display = 'none'; }, 1500);
        } else if (msg.type === 'error') {
          musicGenerateBtn.disabled = false;
          musicProgress.style.display = 'none';
          musicStatus.textContent = 'Error: ' + msg.message;
        }
      };
      musicWorker.onerror = (err) => {
        musicGenerateBtn.disabled = false;
        musicProgress.style.display = 'none';
        musicStatus.textContent = 'Worker error: ' + (err.message || 'Unknown error');
      };
    }
    musicWorker.postMessage({
      type: 'generate',
      prompt: prompt,
      durationSec: durationSec,
    });
  });

  // Save button
  musicSaveBtn.addEventListener('click', async () => {
    if (!generatedWavBlob) return;
    musicSaveBtn.disabled = true;
    musicStatus.textContent = 'Saving...';
    try {
      const resp = await fetch('/api/save-music', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: generatedWavBlob,
      });
      const result = await resp.json();
      if (result.ok) {
        hasGeneratedBgm = true;
        musicInclude.checked = true;
        updateMusicHelp();
        musicStatus.textContent = 'Saved to ' + result.path;
      } else {
        musicStatus.textContent = 'Save failed.';
      }
    } catch (err) {
      musicStatus.textContent = 'Save error: ' + err.message;
    } finally {
      musicSaveBtn.disabled = false;
    }
  });
})();

// ─── Frame & Background Panel ─────────────────────────────────────────────
(function initFramePanel() {
  const panel = document.getElementById('frame-panel');
  const header = document.getElementById('frame-panel-header');
  const paddingSlider = document.getElementById('frame-padding');
  const paddingValue = document.getElementById('frame-padding-value');
  const radiusSlider = document.getElementById('frame-radius');
  const radiusValue = document.getElementById('frame-radius-value');
  const shadowSlider = document.getElementById('frame-shadow');
  const shadowValue = document.getElementById('frame-shadow-value');
  const shadowColorPicker = document.getElementById('frame-shadow-color-picker');
  const shadowColorHex = document.getElementById('frame-shadow-color-hex');
  const bgType = document.getElementById('frame-bg-type');
  const solidRow = document.getElementById('frame-solid-row');
  const gradientRow = document.getElementById('frame-gradient-row');
  const autoRow = document.getElementById('frame-auto-row');
  const imageRow = document.getElementById('frame-image-row');
  const imagePath = document.getElementById('frame-image-path');
  const colorPicker = document.getElementById('frame-color-picker');
  const colorHex = document.getElementById('frame-color-hex');
  const gradC0 = document.getElementById('frame-grad-c0');
  const gradC1 = document.getElementById('frame-grad-c1');
  const gradAngle = document.getElementById('frame-grad-angle');
  const autoSwatch0 = document.getElementById('frame-auto-swatch-0');
  const autoSwatch1 = document.getElementById('frame-auto-swatch-1');
  const autoColorsLabel = document.getElementById('frame-auto-colors');
  const statusEl = document.getElementById('frame-preview-status');
  const videoContainer = document.querySelector('.video-container');
  let autoColors = null; // cached {color0, color1} from probeEdgeColors

  // Load initial config from DATA
  const fc = DATA.frameConfig || {};
  paddingSlider.value = String(fc.padding ?? 40);
  paddingValue.textContent = paddingSlider.value;
  radiusSlider.value = String(fc.borderRadius ?? 12);
  radiusValue.textContent = radiusSlider.value;
  shadowSlider.value = String(fc.shadow ?? 0.5);
  shadowValue.textContent = shadowSlider.value;

  // Shadow color
  const sc = fc.shadowColor || '#000000';
  shadowColorPicker.value = sc.length === 4 ? sc + sc.slice(1) : sc;
  shadowColorHex.value = sc;

  const bg = fc.background || { type: 'solid', value: '#000000' };
  function showBgRowFor(type) {
    solidRow.style.display = type === 'solid' ? 'flex' : 'none';
    gradientRow.style.display = type === 'gradient' ? 'block' : 'none';
    autoRow.style.display = type === 'auto' ? 'flex' : 'none';
    imageRow.style.display = type === 'image' ? 'flex' : 'none';
  }
  if (bg.type === 'gradient') {
    bgType.value = 'gradient';
    const colors = (bg.value || '').match(/#[0-9a-fA-F]{3,8}/g);
    if (colors && colors[0]) gradC0.value = colors[0];
    if (colors && colors[1]) gradC1.value = colors[1];
    const angleMatch = (bg.value || '').match(/(\\d+)deg/);
    if (angleMatch) gradAngle.value = angleMatch[1];
  } else if (bg.type === 'auto') {
    bgType.value = 'auto';
  } else if (bg.type === 'image') {
    bgType.value = 'image';
    imagePath.value = bg.value || '';
  } else {
    bgType.value = 'solid';
    const color = bg.value || '#000000';
    colorPicker.value = color.length === 4 ? color + color.slice(1) : color;
    colorHex.value = color;
  }
  showBgRowFor(bgType.value);

  // Toggle expand
  header.addEventListener('click', () => panel.classList.toggle('expanded'));

  // If frame config exists, auto-expand
  if (fc.padding > 0 || fc.borderRadius > 0) panel.classList.add('expanded');

  let saveTimer = null;
  function scheduleFrameSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistFrameConfig, 500);
  }

  function getFrameConfig() {
    const padding = Number(paddingSlider.value);
    const borderRadius = Number(radiusSlider.value);
    const shadow = Number(shadowSlider.value);
    const shadowColor = shadowColorHex.value || '#000000';
    let background;
    if (bgType.value === 'gradient') {
      const angle = Number(gradAngle.value) || 135;
      background = {
        type: 'gradient',
        value: 'linear-gradient(' + angle + 'deg, ' + gradC0.value + ', ' + gradC1.value + ')',
      };
    } else if (bgType.value === 'auto') {
      background = { type: 'auto' };
    } else if (bgType.value === 'image') {
      background = { type: 'image', value: imagePath.value || '' };
    } else {
      background = { type: 'solid', value: colorHex.value || '#000000' };
    }
    return { padding, borderRadius, shadow, shadowColor, background };
  }

  function persistFrameConfig() {
    const config = getFrameConfig();
    fetch('/api/frame-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    }).catch(() => {});
  }

  function updateLivePreview() {
    const padding = Number(paddingSlider.value);
    const borderRadius = Number(radiusSlider.value);
    const shadow = Number(shadowSlider.value);

    if (padding <= 0) {
      videoContainer.classList.remove('frame-preview');
      // Remove background overlay if exists
      const existing = videoContainer.querySelector('.frame-preview-bg');
      if (existing) existing.remove();
      videoContainer.style.removeProperty('--frame-radius');
      videoContainer.style.removeProperty('--frame-shadow');
      video.style.removeProperty('max-width');
      video.style.removeProperty('max-height');
      statusEl.textContent = '';
      return;
    }

    videoContainer.classList.add('frame-preview');

    // Compute relative padding as a percentage of the container
    // We approximate the video frame look by shrinking the video and adding border/bg
    const containerRect = videoContainer.getBoundingClientRect();
    const padPctW = (padding / (DATA.pipelineMeta?.export?.outputWidth || 1920)) * 100;
    const padPctH = (padding / (DATA.pipelineMeta?.export?.outputHeight || 1080)) * 100;

    video.style.maxWidth = (100 - 2 * padPctW) + '%';
    video.style.maxHeight = (100 - 2 * padPctH) + '%';
    videoContainer.style.setProperty('--frame-radius', borderRadius + 'px');

    // Shadow with custom color
    const shadowBlur = Math.round(shadow * 40);
    const shadowSpread = Math.round(shadow * 8);
    const shadowAlpha = Math.min(shadow * 0.8, 0.7).toFixed(2);
    if (shadow > 0) {
      const sc = shadowColorHex.value || '#000000';
      const r = parseInt(sc.slice(1,3), 16), g = parseInt(sc.slice(3,5), 16), b = parseInt(sc.slice(5,7), 16);
      videoContainer.style.setProperty('--frame-shadow', '0 ' + Math.round(shadow * 10) + 'px ' + shadowBlur + 'px ' + shadowSpread + 'px rgba(' + r + ',' + g + ',' + b + ',' + shadowAlpha + ')');
    } else {
      videoContainer.style.setProperty('--frame-shadow', 'none');
    }

    // Background
    let bgCss;
    if (bgType.value === 'gradient') {
      const angle = Number(gradAngle.value) || 135;
      bgCss = 'linear-gradient(' + angle + 'deg, ' + gradC0.value + ', ' + gradC1.value + ')';
    } else if (bgType.value === 'auto' && autoColors) {
      bgCss = 'linear-gradient(135deg, ' + autoColors.color0 + ', ' + autoColors.color1 + ')';
    } else if (bgType.value === 'auto') {
      bgCss = '#1a1a2e'; // placeholder until probe returns
    } else if (bgType.value === 'image') {
      bgCss = imagePath.value ? 'url(/api/local-file?path=' + encodeURIComponent(imagePath.value) + ')' : '#1a1a2e';
    } else {
      bgCss = colorHex.value || '#000000';
    }

    let bgEl = videoContainer.querySelector('.frame-preview-bg');
    if (!bgEl) {
      bgEl = document.createElement('div');
      bgEl.className = 'frame-preview-bg';
      videoContainer.insertBefore(bgEl, videoContainer.firstChild);
    }
    bgEl.style.background = bgCss;

    statusEl.textContent = 'Live preview — export to apply to video';
  }

  // Wire up controls
  paddingSlider.addEventListener('input', () => {
    paddingValue.textContent = paddingSlider.value;
    updateLivePreview();
    scheduleFrameSave();
  });
  radiusSlider.addEventListener('input', () => {
    radiusValue.textContent = radiusSlider.value;
    updateLivePreview();
    scheduleFrameSave();
  });
  shadowSlider.addEventListener('input', () => {
    shadowValue.textContent = Number(shadowSlider.value).toFixed(2);
    updateLivePreview();
    scheduleFrameSave();
  });

  function fetchAutoColors() {
    fetch('/api/probe-auto-bg').then(r => r.json()).then(data => {
      autoColors = data;
      autoSwatch0.style.background = data.color0;
      autoSwatch1.style.background = data.color1;
      autoColorsLabel.textContent = data.color0 + ' \u2192 ' + data.color1;
      updateLivePreview();
    }).catch(() => {
      autoColorsLabel.textContent = 'probe failed';
    });
  }

  bgType.addEventListener('change', () => {
    showBgRowFor(bgType.value);
    if (bgType.value === 'auto' && !autoColors) fetchAutoColors();
    updateLivePreview();
    scheduleFrameSave();
  });

  // If auto was the initial bg type, probe immediately
  if (bgType.value === 'auto') fetchAutoColors();

  shadowColorPicker.addEventListener('input', () => {
    shadowColorHex.value = shadowColorPicker.value;
    updateLivePreview();
    scheduleFrameSave();
  });
  shadowColorHex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(shadowColorHex.value)) {
      shadowColorPicker.value = shadowColorHex.value;
    }
    updateLivePreview();
    scheduleFrameSave();
  });
  colorPicker.addEventListener('input', () => {
    colorHex.value = colorPicker.value;
    updateLivePreview();
    scheduleFrameSave();
  });
  colorHex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) {
      colorPicker.value = colorHex.value;
    }
    updateLivePreview();
    scheduleFrameSave();
  });
  gradC0.addEventListener('input', () => { updateLivePreview(); scheduleFrameSave(); });
  gradC1.addEventListener('input', () => { updateLivePreview(); scheduleFrameSave(); });
  gradAngle.addEventListener('input', () => { updateLivePreview(); scheduleFrameSave(); });
  imagePath.addEventListener('input', () => { updateLivePreview(); scheduleFrameSave(); });

  // Initial render
  updateLivePreview();
})();

// ─── Init ──────────────────────────────────────────────────────────────────
renderSceneList();
snapshotAllScenes();
initAudio();
updateSceneScrubUI(0);

// Mark dirty on any voiceover field edit (text, voice, speed)
sceneList.addEventListener('input', (e) => {
  const field = e.target?.dataset?.field;
  if (field === 'text' || field === 'voice' || field === 'speed') markDirty();
});
</script>
</body>
</html>`;
