/**
 * argo preview — browser-based replay viewer for iterating on voiceover,
 * overlays, and timing without re-recording.
 *
 * Serves a local web page that plays the recorded video.webm, overlays audio
 * clips at scene timestamps, renders overlay cues on a DOM layer, and lets the
 * user edit voiceover text + overlay props inline with per-scene TTS regen.
 */

import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { renderTemplate } from './overlays/templates.js';
import { alignClips, schedulePlacements, type ClipInfo, type Placement } from './tts/align.js';
import { ClipCache, type ManifestEntry } from './tts/cache.js';
import { createWavBuffer, parseWavHeader } from './tts/engine.js';
import type { OverlayManifestEntry, Zone } from './overlays/types.js';

export interface PreviewOptions {
  demoName: string;
  argoDir?: string;
  demosDir?: string;
  port?: number;
  open?: boolean;
  ttsDefaults?: { voice?: string; speed?: number };
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
  sceneDurations: Record<string, number>;
  sceneReport: PreviewSceneReport | null;
  /** Pre-rendered overlay HTML/CSS for each scene (keyed by scene name). */
  renderedOverlays: Record<string, { html: string; styles: Record<string, string>; zone: Zone }>;
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

function loadPreviewData(demoName: string, argoDir: string, demosDir: string): PreviewData {
  const demoDir = join(argoDir, demoName);

  // Required files
  const timingPath = join(demoDir, '.timing.json');
  if (!existsSync(timingPath)) {
    throw new Error(`No timing data found at ${timingPath}. Run 'argo pipeline ${demoName}' first.`);
  }
  const timing = readJsonFile<Record<string, number>>(timingPath, {});

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

  // Scene durations
  const sdPath = join(demoDir, '.scene-durations.json');
  const sceneDurations = readJsonFile<Record<string, number>>(sdPath, {});

  // Use persisted report metadata, but derive scene placements from the current
  // timing + scene durations so preview stays in sync after per-scene regen.
  const reportPath = join(demoDir, 'scene-report.json');
  const persistedReport = readJsonFile<{ totalDurationMs?: number; overflowMs?: number } | null>(reportPath, null);
  const sceneReport = buildPreviewSceneReport(timing, sceneDurations, persistedReport);
  const renderedOverlays = buildRenderedOverlays(overlays);

  return { demoName, timing, voiceover, overlays, sceneDurations, sceneReport, renderedOverlays };
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

  const baseReport = buildPreviewSceneReport(timing, sceneDurations, persistedReport);
  const totalDurationMs = baseReport?.totalDurationMs ?? 0;
  const aligned = alignClips(timing, clips, totalDurationMs);
  writeFileSync(join(demoDir, 'narration-aligned.wav'), createWavBuffer(aligned.samples, 24_000));

  return {
    sceneDurations,
    sceneReport: createSceneReportFromPlacements(aligned.placements, persistedReport),
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
  const port = options.port ?? 0; // 0 = auto-assign
  const demoName = options.demoName;
  const demoDir = join(argoDir, demoName);

  // Verify the demo has been recorded
  const videoPath = join(demoDir, 'video.webm');
  if (!existsSync(videoPath)) {
    throw new Error(
      `No recording found for '${demoName}'. Run 'argo pipeline ${demoName}' first.`
    );
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    try {
      // --- API routes ---

      if (url === '/api/data') {
        const data = loadPreviewData(demoName, argoDir, demosDir);
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
        const data = loadPreviewData(demoName, argoDir, demosDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changed, renderedOverlays: data.renderedOverlays }));
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

      // --- Static file serving ---

      // Serve video.webm
      if (url === '/video.webm') {
        serveFile(res, videoPath);
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
        const data = loadPreviewData(demoName, argoDir, demosDir);
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
  .sidebar-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
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
  .btn-save.saved {
    background: transparent;
    border-color: var(--success);
    color: var(--success);
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
</style>
</head>
<body>

<header>
  <h1>Argo Preview — <span class="demo-name" id="demo-name"></span></h1>
  <div class="actions">
    <a class="trace-link" id="trace-link" href="https://trace.playwright.dev" target="_blank">Open Trace Viewer</a>
    <button class="btn btn-save" id="btn-save" title="Save all changes">Save</button>
  </div>
</header>

<div class="viewer">
  <div class="video-container">
    <video id="video" src="/video.webm" preload="auto"></video>
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
  <div class="sidebar-header">Scenes</div>
  <div id="scene-list"></div>
  <div class="status" id="status">Ready</div>
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
  video.currentTime = seekTime;
  syncAudio();
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
    el.innerHTML = s.rendered.html;
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

    // Show overlay during this scene's time range
    const sceneIdx = scenes.indexOf(s);
    const nextStart = sceneIdx + 1 < scenes.length ? scenes[sceneIdx + 1].startMs : video.duration * 1000;
    const isActive = currentMs >= s.startMs && currentMs < nextStart;
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
      </div>
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
      <div class="btn-row">
        <button class="btn" onclick="previewScene('\${esc(s.name)}')">Preview scene</button>
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
    \`;

    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' ||
          e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      seekToScene(s);
    });

    // Live preview: update overlay on the video layer when editing
    wireOverlayListeners(s.name);

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
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => saveOverlays(), 300);
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

// ─── Actions ───────────────────────────────────────────────────────────────
function seekToScene(s) {
  scenePlaybackEndMs = null;
  seekAbsoluteMs(getSceneBounds(s).startMs);
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

function seekAbsoluteMs(absoluteMs) {
  video.currentTime = Math.max(0, absoluteMs) / 1000;
  updateOverlayVisibility(Math.max(0, absoluteMs));
  updateSceneScrubUI(Math.max(0, absoluteMs));
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

function handleSceneScrubInput(sceneName, rawValue) {
  const s = scenes.find((scene) => scene.name === sceneName);
  if (!s) return;
  if (!scrubState.has(sceneName)) {
    scrubState.set(sceneName, { resumeAfter: !video.paused });
    video.pause();
  }
  const { startMs, durationMs } = getSceneBounds(s);
  const offsetMs = Math.max(0, Math.min(durationMs, Number(rawValue) || 0));
  scenePlaybackEndMs = null;
  seekAbsoluteMs(startMs + offsetMs);
  activeScene = s;
  updateActiveSceneUI();
}

function handleSceneScrubCommit(sceneName, rawValue) {
  handleSceneScrubInput(sceneName, rawValue);
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
  handleSceneScrubInput(sceneName, currentMs + deltaMs);
  handleSceneScrubCommit(sceneName, currentMs + deltaMs);
}

async function previewScene(sceneName) {
  await initAudio();
  const s = scenes.find(s => s.name === sceneName);
  if (!s) return;
  const { startMs, endMs, durationMs } = getSceneBounds(s);
  if (!durationMs) return;
  seekAbsoluteMs(startMs);
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

// Save button
document.getElementById('btn-save').addEventListener('click', async () => {
  const saveBtn = document.getElementById('btn-save');
  setStatus('Saving...', 'saving');
  try {
    await saveVoiceover();
    await saveOverlays();
    setStatus('All changes saved', 'saved');
    saveBtn.textContent = '\\u2713 Saved';
    saveBtn.classList.add('saved');
    setTimeout(() => {
      saveBtn.textContent = 'Save';
      saveBtn.classList.remove('saved');
    }, 2000);
  } catch (err) {
    setStatus('Save failed: ' + err.message, 'error');
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

// ─── Init ──────────────────────────────────────────────────────────────────
renderSceneList();
initAudio();
updateSceneScrubUI(0);
</script>
</body>
</html>`;
