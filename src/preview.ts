/**
 * argo preview — browser-based replay viewer for iterating on voiceover,
 * overlays, and timing without re-recording.
 *
 * Serves a local web page that plays a seekable preview video (preferring MP4
 * over the raw Playwright WebM), overlays audio clips at scene timestamps,
 * renders overlay cues on a DOM layer, and lets the user edit voiceover text
 * + overlay props inline with per-scene TTS regen.
 */

import { execFile } from 'node:child_process';
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
import { applySpeedRampToTimeline } from './speed-ramp.js';
import { shiftCameraMoves, scaleCameraMoves, type CameraMove } from './camera-move.js';
import { resolveFreezes, adjustPlacementsForFreezes, totalFreezeDurationMs, type FreezeSpec } from './freeze.js';

export interface PreviewExportConfig {
  preset?: string;
  crf?: number;
  fps?: number;
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
  /** Pipeline metadata from last recording (voices, resolution, engine). */
  pipelineMeta: Record<string, unknown> | null;
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
  } else {
    changed = setManifestField(overlayTarget, 'text', undefined) || changed;
    changed = setManifestField(overlayTarget, 'title', 'title' in overlay ? overlay.title : undefined) || changed;
    changed = setManifestField(overlayTarget, 'body', 'body' in overlay ? overlay.body : undefined) || changed;
    changed = setManifestField(overlayTarget, 'kicker', 'kicker' in overlay ? overlay.kicker : undefined) || changed;
    changed = setManifestField(overlayTarget, 'src', 'src' in overlay ? overlay.src : undefined) || changed;
  }

  return changed;
}

function buildRenderedOverlays(overlays: OverlayManifestEntry[]): PreviewData['renderedOverlays'] {
  const renderedOverlays: PreviewData['renderedOverlays'] = {};
  for (const entry of overlays) {
    const { scene, ...cue } = entry;
    const zone: Zone = cue.placement ?? 'bottom-center';
    const { contentHtml, styles } = renderTemplate(cue, 'dark');
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

function loadPreviewData(demoName: string, argoDir: string, demosDir: string, outputDir: string = 'videos'): PreviewData {
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
  const renderedOverlays = buildRenderedOverlays(overlays);

  // Pipeline metadata (reuse meta loaded above for headTrimMs)
  const pipelineMeta = Object.keys(meta).length > 0 ? meta as Record<string, unknown> : null;

  return { demoName, timing, voiceover, overlays, effects, sceneDurations, sceneReport, renderedOverlays, pipelineMeta };
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
      throw new Error(
        `Expected regenerated clip for scene "${entry.scene}" at ${clipPath}, but it was not found. ` +
        `Try running: argo tts generate ${scenesPath}`
      );
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

  // Prefer exported MP4 (has keyframes for seeking) over raw WebM (no cue points)
  const webmPath = join(demoDir, 'video.webm');
  const mp4Path = join(outputDir, `${demoName}.mp4`);
  let videoPath = existsSync(mp4Path) ? mp4Path : webmPath;
  if (!existsSync(videoPath)) {
    throw new Error(
      `No recording found for '${demoName}'. Run 'argo pipeline ${demoName}' first.`
    );
  }
  let videoMime = videoPath.endsWith('.mp4') ? 'video/mp4' : 'video/webm';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    try {
      // --- API routes ---

      if (url === '/api/data') {
        const data = loadPreviewData(demoName, argoDir, demosDir, outputDir);
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
        const renderedOverlays = buildRenderedOverlays(body);
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
        const data = loadPreviewData(demoName, argoDir, demosDir, outputDir);
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

          // Refresh aligned audio from current clips + timing
          const refreshed = refreshPreviewAudioArtifacts(demoName, argoDir, demosDir, options.ttsDefaults);

          // Read timing for head-trim + placement computation
          const timing = readJsonFile<Record<string, number>>(join(demoDir, '.timing.json'), {});
          const markTimes = Object.values(timing);
          let headTrimMs = 0;
          if (markTimes.length > 0) {
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
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webmPath,
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
          const rampResult = applySpeedRampToTimeline(placements, shiftedDurationMs, ec?.speedRamp);
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
              moves = scaleCameraMoves(moves, ec?.deviceScaleFactor ?? 1);
              if (moves.length > 0) cameraMoves = moves;
            }
          } catch { /* optional */ }

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
            musicPath: ec?.musicPath,
            musicVolume: ec?.musicVolume,
            cameraMoves,
            watermark: ec?.watermark,
            freezeSpecs: previewResolvedFreezes.length > 0 ? previewResolvedFreezes : undefined,
          });

          // Switch to serving the new MP4
          if (existsSync(mp4Path)) {
            videoPath = mp4Path;
            videoMime = 'video/mp4';
          }
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        }
        return;
      }

      // Save generated background music WAV
      if (url === '/api/save-music' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const wavData = Buffer.concat(chunks);
        const musicDir = join(demoDir, 'music');
        mkdirSync(musicDir, { recursive: true });
        const timestamp = Date.now();
        const fileName = `generated-${timestamp}.wav`;
        const filePath = join(musicDir, fileName);
        writeFileSync(filePath, wavData);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: join('.argo', demoName, 'music', fileName) }));
        return;
      }

      // --- Static file serving ---

      // Serve video with Range request support (required for seeking)
      if (url === '/video' || url === '/video.webm') {
        serveFileWithRanges(req, res, videoPath, videoMime);
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

      // Serve trace.zip (for Playwright trace viewer link)
      if (url === '/trace.zip') {
        const tracePath = join(demoDir, 'trace.zip');
        if (existsSync(tracePath)) {
          serveFile(res, tracePath);
        } else {
          res.writeHead(404);
          res.end('No trace captured');
        }
        return;
      }

      // Root — serve the preview HTML
      if (url === '/' || url === '/index.html') {
        const data = loadPreviewData(demoName, argoDir, demosDir, outputDir);
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

  /* Timeline bar */
  .timeline {
    background: var(--surface);
    border-top: 1px solid var(--border);
    padding: 12px 20px;
  }
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
    padding: 40px 48px;
    text-align: center;
    max-width: 400px;
  }
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
    <a class="trace-link" id="trace-link" href="https://trace.playwright.dev" target="_blank">Open Trace Viewer</a>
    <button class="btn btn-save" id="btn-save" title="Save all changes">Save</button>
    <button class="btn btn-rerecord" id="btn-export" title="Re-export video with current audio (no re-recording)">Export</button>
    <button class="btn btn-rerecord" id="btn-rerecord" title="Re-record with current manifest">Re-record</button>
  </div>
</header>

<div class="viewer">
  <div class="video-container">
    <video id="video" src="/video" preload="auto" muted playsinline></video>
    <div class="overlay-layer" id="overlay-layer"></div>
  </div>

  <div class="timeline">
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
    </div>
  </div>
</div>

<div class="sidebar">
  <div class="sidebar-tabs">
    <button class="sidebar-tab active" data-tab="scenes">Scenes</button>
    <button class="sidebar-tab" data-tab="metadata">Metadata</button>
  </div>
  <div class="sidebar-panel" id="panel-scenes">
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
          <input type="range" id="music-duration" min="10" max="60" value="30" step="5">
          <span class="music-dur-label" id="music-dur-label">30s</span>
        </div>
        <button class="music-generate-btn" id="music-generate-btn">Generate Music</button>
        <div class="music-progress" id="music-progress">
          <div class="music-progress-bar"><div class="music-progress-fill" id="music-progress-fill"></div></div>
          <div class="music-progress-text" id="music-progress-text"></div>
        </div>
        <audio class="music-audio-player" id="music-audio" controls></audio>
        <button class="music-save-btn" id="music-save-btn">Use as BGM</button>
        <div class="music-status" id="music-status"></div>
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
    overlay: DATA.overlays.find(o => o.scene === name),
    effects: DATA.effects[name] ?? [],
    rendered: DATA.renderedOverlays[name],
    report: DATA.sceneReport?.scenes?.find(s => s.scene === name),
  }));

let activeScene = null;

// ─── Timeline ──────────────────────────────────────────────────────────────
video.addEventListener('loadedmetadata', () => {
  const totalMs = video.duration * 1000;
  document.getElementById('time-total').textContent = formatTime(totalMs);

  // Render scene markers on timeline
  scenes.forEach((s, i) => {
    const pct = (s.startMs / totalMs) * 100;
    const nextStart = i + 1 < scenes.length ? scenes[i + 1].startMs : totalMs;
    const widthPct = ((nextStart - s.startMs) / totalMs) * 100;

    const marker = document.createElement('div');
    marker.className = 'timeline-scene';
    marker.style.left = pct + '%';
    marker.style.width = Math.max(widthPct, 2) + '%';
    const hasOverlay = DATA.overlays.find(o => o.scene === s.name);
    // s.name is already escaped via esc() — safe for innerHTML
    marker.innerHTML = esc(s.name) + (hasOverlay ? '<span class="has-overlay"></span>' : '');
    marker.dataset.scene = s.name;
    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      seekToScene(s);
    });
    timelineBar.appendChild(marker);
  });

  // Create overlay DOM elements
  renderOverlayElements();
});

video.addEventListener('timeupdate', () => {
  const totalMs = video.duration * 1000;
  const currentMs = video.currentTime * 1000;
  if (scenePlaybackEndMs !== null && currentMs >= scenePlaybackEndMs) {
    const stopAt = scenePlaybackEndMs;
    scenePlaybackEndMs = null;
    video.currentTime = stopAt / 1000;
    video.pause();
    stopAudio();
  }
  timelineProgress.style.width = ((currentMs / totalMs) * 100) + '%';
  document.getElementById('timeline-playhead').style.left = ((currentMs / totalMs) * 100) + '%';
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
});

// Click on timeline bar to seek
timelineBar.addEventListener('click', (e) => {
  const rect = timelineBar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const seekTime = pct * video.duration;
  scenePlaybackEndMs = null;
  void seekAbsoluteMs(seekTime * 1000);
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

    // Show overlay only during this scene's own duration (not bleeding into next scene)
    const { startMs, endMs } = getSceneBounds(s);
    const isActive = currentMs >= startMs && currentMs < endMs;
    el.classList.toggle('visible', isActive);
  }
}

document.getElementById('cb-overlays').addEventListener('change', () => {
  updateOverlayVisibility(video.currentTime * 1000);
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
      </div>
      \${renderOverlayFields(s)}
      \${renderEffectsFields(s)}
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
}

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
  }
}

function wireOverlayListeners(sceneName) {
  const card = document.querySelector('.scene-card[data-scene="' + sceneName + '"]');
  if (!card) return;
  let debounceTimer;
  card.querySelectorAll('[data-field^="overlay"]').forEach(input => {
    const handler = () => {
      markDirty();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => previewOverlays(), 300);
    };
    input.addEventListener('input', handler);
    input.addEventListener('change', handler);
  });
  // Re-wire the type change listener
  const typeSelect = card.querySelector('select[data-field="overlay-type"]');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => updateOverlayFieldsForScene(sceneName));
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

  const totalMs = video.duration * 1000;
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
    // Save current voiceover state first
    await saveVoiceover();

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

    return entry;
  });
}

function collectOverlays() {
  return scenes
    .map(s => {
      const typeEl = document.querySelector('select[data-scene="' + s.name + '"][data-field="overlay-type"]');
      const placeEl = document.querySelector('select[data-scene="' + s.name + '"][data-field="overlay-placement"]');
      const motionEl = document.querySelector('select[data-scene="' + s.name + '"][data-field="overlay-motion"]');
      const textEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="overlay-text"]');
      const bodyEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="overlay-body"]');
      const kickerEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="overlay-kicker"]');
      const srcEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="overlay-src"]');
      const type = typeEl?.value;
      if (!type) return null;
      const entry = {
        ...(s.overlay ?? {}),
        scene: s.name,
        type,
        placement: placeEl?.value ?? 'bottom-center',
      };
      if (motionEl?.value && motionEl.value !== 'none') entry.motion = motionEl.value;
      else delete entry.motion;

      delete entry.text;
      delete entry.title;
      delete entry.body;
      delete entry.kicker;
      delete entry.src;

      if (type === 'lower-third' || type === 'callout') {
        entry.text = textEl?.value ?? '';
      } else {
        entry.title = textEl?.value ?? '';
        if (bodyEl?.value) entry.body = bodyEl.value;
        if (type === 'headline-card' && kickerEl?.value) entry.kicker = kickerEl.value;
        if (type === 'image-card' && srcEl?.value) entry.src = srcEl.value;
      }
      return entry;
    })
    .filter(Boolean);
}

async function saveVoiceover() {
  const vo = collectVoiceover();
  await fetch('/api/voiceover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(vo),
  });
}

// Render-only preview (no disk write) — called on every overlay field edit
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
    DATA.overlays = ov;
    for (const s of scenes) {
      s.overlay = DATA.overlays.find(o => o.scene === s.name);
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
    DATA.overlays = ov;
    for (const s of scenes) {
      s.overlay = DATA.overlays.find(o => o.scene === s.name);
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
      overlay: s.overlay ? JSON.parse(JSON.stringify(s.overlay)) : null,
      effects: s.effects?.length ? JSON.parse(JSON.stringify(s.effects)) : [],
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
  if (text !== snap.text || voice !== snap.voice || String(speed) !== String(snap.speed)) return true;
  // Check overlay fields
  const type = card.querySelector('[data-field="overlay-type"]')?.value ?? '';
  const snapType = snap.overlay?.type ?? '';
  if (type !== snapType) return true;
  if (type) {
    const placement = card.querySelector('[data-field="overlay-placement"]')?.value ?? '';
    const motion = card.querySelector('[data-field="overlay-motion"]')?.value ?? '';
    const overlayText = card.querySelector('[data-field="overlay-text"]')?.value ?? '';
    const body = card.querySelector('[data-field="overlay-body"]')?.value ?? '';
    const kicker = card.querySelector('[data-field="overlay-kicker"]')?.value ?? '';
    const src = card.querySelector('[data-field="overlay-src"]')?.value ?? '';
    const so = snap.overlay || {};
    if (placement !== (so.placement ?? 'bottom-center')) return true;
    if (motion !== (so.motion ?? 'none')) return true;
    const snapText = so.type === 'lower-third' || so.type === 'callout' ? (so.text ?? '') : (so.title ?? '');
    if (overlayText !== snapText) return true;
    if (body !== (so.body ?? '')) return true;
    if (kicker !== (so.kicker ?? '')) return true;
    if (src !== (so.src ?? '')) return true;
  }
  // Check effects
  const s = scenes.find(sc => sc.name === sceneName);
  const currentEffects = JSON.stringify(s?.effects ?? []);
  const snapEffects = JSON.stringify(snap.effects ?? []);
  if (currentEffects !== snapEffects) return true;
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
  // Restore effects
  const s = scenes.find(sc => sc.name === sceneName);
  if (s) {
    s.effects = snap.effects?.length ? JSON.parse(JSON.stringify(snap.effects)) : [];
    refreshEffectsUI(sceneName);
  }
  // Restore overlay type (triggers field re-render)
  const typeEl = card.querySelector('[data-field="overlay-type"]');
  if (typeEl) {
    typeEl.value = snap.overlay?.type ?? '';
    updateOverlayFieldsForScene(sceneName);
  }
  // Restore overlay field values after re-render
  setTimeout(() => {
    const so = snap.overlay || {};
    const textField = card.querySelector('[data-field="overlay-text"]');
    if (textField) {
      textField.value = so.type === 'lower-third' || so.type === 'callout' ? (so.text ?? '') : (so.title ?? '');
    }
    const bodyField = card.querySelector('[data-field="overlay-body"]');
    if (bodyField) bodyField.value = so.body ?? '';
    const kickerField = card.querySelector('[data-field="overlay-kicker"]');
    if (kickerField) kickerField.value = so.kicker ?? '';
    const srcField = card.querySelector('[data-field="overlay-src"]');
    if (srcField) srcField.value = so.src ?? '';
    const placementField = card.querySelector('[data-field="overlay-placement"]');
    if (placementField) placementField.value = so.placement ?? 'bottom-center';
    const motionField = card.querySelector('[data-field="overlay-motion"]');
    if (motionField) motionField.value = so.motion ?? 'none';
    // Re-render overlay preview
    previewOverlays();
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
  if (isDirty && !confirm('You have unsaved changes. Save before exporting?')) return;
  if (isDirty) {
    await saveVoiceover();
    await saveOverlays();
    await saveEffects();
    clearDirty();
  }
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
    const resp = await fetch('/api/export', { method: 'POST' });
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
    clearDirty();
  }
  const overlay = document.getElementById('recording-overlay');
  const title = document.getElementById('recording-title');
  const subtitle = document.getElementById('recording-subtitle');
  overlay.classList.remove('success', 'error');
  overlay.classList.add('active');
  title.textContent = 'Re-recording pipeline...';
  subtitle.textContent = 'All editing is paused while the pipeline runs.';
  video.pause();
  stopAudio();
  showPlayIcon();
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
  const musicSaveBtn = document.getElementById('music-save-btn');
  const musicStatus = document.getElementById('music-status');

  let musicWorker = null;
  let generatedWavBlob = null;

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

  // Create web worker (inline blob with ESM)
  function createMusicWorker() {
    const workerCode = [
      'import { AutoTokenizer, MusicgenForConditionalGeneration } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";',
      '',
      'let tokenizer = null;',
      'let model = null;',
      '',
      'async function loadModel() {',
      '  self.postMessage({ type: "progress", message: "Loading MusicGen model (~1.8GB, first time takes a while)..." });',
      '  tokenizer = await AutoTokenizer.from_pretrained("Xenova/musicgen-small");',
      '  self.postMessage({ type: "progress", message: "Tokenizer loaded. Loading model weights..." });',
      '  model = await MusicgenForConditionalGeneration.from_pretrained("Xenova/musicgen-small", {',
      '    dtype: { text_encoder: "q8", decoder_model_merged: "q8", encodec_decode: "fp32" },',
      '  });',
      '  self.postMessage({ type: "progress", message: "Model loaded." });',
      '}',
      '',
      'self.onmessage = async (e) => {',
      '  if (e.data.type === "generate") {',
      '    try {',
      '      if (!model) await loadModel();',
      '      self.postMessage({ type: "progress", message: "Generating audio from prompt..." });',
      '      const inputs = tokenizer(e.data.prompt);',
      '      const maxTokens = Math.ceil(e.data.durationSec * 50);',
      '      const output = await model.generate({',
      '        ...inputs,',
      '        max_new_tokens: maxTokens,',
      '        do_sample: true,',
      '        guidance_scale: e.data.guidanceScale || 3,',
      '        temperature: e.data.temperature || 1.0,',
      '      });',
      '      const audioData = output.data instanceof Float32Array ? output.data : new Float32Array(output.data);',
      '      self.postMessage({ type: "complete", audioData: audioData, sampleRate: 32000 }, [audioData.buffer]);',
      '    } catch (err) {',
      '      self.postMessage({ type: "error", message: err.message || String(err) });',
      '    }',
      '  }',
      '};',
    ].join('\\n');

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { type: 'module' });
    URL.revokeObjectURL(url);
    return worker;
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
      musicWorker.onmessage = handleWorkerMessage;
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
      guidanceScale: 3,
      temperature: 1.0,
    });
  });

  function handleWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'progress') {
      showProgress(msg.message);
      // Estimate progress based on message content
      if (msg.message.includes('Tokenizer')) setProgressBar(25);
      else if (msg.message.includes('Model loaded')) setProgressBar(50);
      else if (msg.message.includes('Generating')) setProgressBar(60);
      else setProgressBar(15);
    } else if (msg.type === 'complete') {
      setProgressBar(100);
      showProgress('Generation complete.');
      musicGenerateBtn.disabled = false;

      // Encode to WAV and create audio preview
      generatedWavBlob = encodeWavFloat32(msg.audioData, msg.sampleRate);
      const audioUrl = URL.createObjectURL(generatedWavBlob);
      musicAudio.src = audioUrl;
      musicAudio.style.display = 'block';
      musicSaveBtn.style.display = 'block';
      musicStatus.textContent = 'Audio ready. Press play to audition, or save as background music.';

      setTimeout(() => {
        musicProgress.style.display = 'none';
        setProgressBar(0);
      }, 2000);
    } else if (msg.type === 'error') {
      musicGenerateBtn.disabled = false;
      musicProgress.style.display = 'none';
      musicStatus.textContent = 'Generation failed: ' + msg.message;
    }
  }

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
