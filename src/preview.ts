/**
 * argo preview — browser-based replay viewer for iterating on voiceover,
 * overlays, and timing without re-recording.
 *
 * Serves a local web page that plays the recorded video.webm, overlays audio
 * clips at scene timestamps, renders overlay cues on a DOM layer, and lets the
 * user edit voiceover text + overlay props inline with per-scene TTS regen.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { renderTemplate } from './overlays/templates.js';
import type { OverlayManifestEntry, Zone } from './overlays/types.js';

export interface PreviewOptions {
  demoName: string;
  argoDir?: string;
  demosDir?: string;
  port?: number;
  open?: boolean;
}

interface PreviewData {
  demoName: string;
  timing: Record<string, number>;
  voiceover: Array<{ scene: string; text: string; voice?: string; speed?: number; _hint?: string }>;
  overlays: OverlayManifestEntry[];
  sceneDurations: Record<string, number>;
  sceneReport: { scenes: Array<{ scene: string; startMs: number; endMs: number; durationMs: number }> } | null;
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

function loadPreviewData(demoName: string, argoDir: string, demosDir: string): PreviewData {
  const demoDir = join(argoDir, demoName);

  // Required files
  const timingPath = join(demoDir, '.timing.json');
  if (!existsSync(timingPath)) {
    throw new Error(`No timing data found at ${timingPath}. Run 'argo pipeline ${demoName}' first.`);
  }
  const timing = JSON.parse(readFileSync(timingPath, 'utf-8'));

  // Voiceover manifest
  const voPath = join(demosDir, `${demoName}.voiceover.json`);
  const voiceover = existsSync(voPath) ? JSON.parse(readFileSync(voPath, 'utf-8')) : [];

  // Overlay manifest
  const ovPath = join(demosDir, `${demoName}.overlays.json`);
  const overlays: OverlayManifestEntry[] = existsSync(ovPath) ? JSON.parse(readFileSync(ovPath, 'utf-8')) : [];

  // Scene durations
  const sdPath = join(demoDir, '.scene-durations.json');
  const sceneDurations = existsSync(sdPath) ? JSON.parse(readFileSync(sdPath, 'utf-8')) : {};

  // Scene report (from last pipeline run)
  const reportPath = join(demoDir, 'scene-report.json');
  const sceneReport = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf-8')) : null;

  // Pre-render overlay templates
  const renderedOverlays: PreviewData['renderedOverlays'] = {};
  for (const entry of overlays) {
    const { scene, ...cue } = entry;
    const zone: Zone = cue.placement ?? 'bottom-center';
    const { contentHtml, styles } = renderTemplate(cue, 'dark');
    renderedOverlays[scene] = { html: contentHtml, styles, zone };
  }

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

      // Save voiceover manifest
      if (url === '/api/voiceover' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const voPath = join(demosDir, `${demoName}.voiceover.json`);
        writeFileSync(voPath, JSON.stringify(body, null, 2) + '\n', 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Save overlay manifest
      if (url === '/api/overlays' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const ovPath = join(demosDir, `${demoName}.overlays.json`);
        writeFileSync(ovPath, JSON.stringify(body, null, 2) + '\n', 'utf-8');
        // Reload and re-render overlays
        const data = loadPreviewData(demoName, argoDir, demosDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, renderedOverlays: data.renderedOverlays }));
        return;
      }

      // Regenerate a single TTS clip
      if (url === '/api/regen-clip' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const { scene } = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

        // Save updated voiceover first (client sends full manifest via /api/voiceover before this)
        // Then regen just this scene via the CLI subprocess
        const { execFile: execFileCb } = await import('node:child_process');
        const manifestPath = join(demosDir, `${demoName}.voiceover.json`);

        await new Promise<void>((resolve, reject) => {
          execFileCb('npx', ['argo', 'tts', 'generate', manifestPath], {
            env: process.env,
          }, (err, stdout, stderr) => {
            if (err) {
              reject(new Error(`TTS regen failed: ${stderr || stdout}`));
            } else {
              resolve();
            }
          });
        });

        // Return updated scene duration
        const sdPath = join(argoDir, demoName, '.scene-durations.json');
        const durations = existsSync(sdPath) ? JSON.parse(readFileSync(sdPath, 'utf-8')) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, scene, durationMs: durations[scene] ?? 0 }));
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
        const clipPath = join(demoDir, 'clips', clipFile);
        if (existsSync(clipPath)) {
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

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
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
    --bg: #0f0f0f;
    --surface: #1a1a1a;
    --surface2: #242424;
    --border: #333;
    --text: #e5e5e5;
    --text-muted: #888;
    --accent: #6366f1;
    --accent-glow: rgba(99,102,241,0.3);
    --success: #22c55e;
    --warning: #f59e0b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
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
    font-weight: 500;
    color: var(--text-muted);
    border-left: 2px solid var(--accent);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .timeline-scene:hover { color: var(--text); background: var(--accent-glow); }
  .timeline-scene.active { color: var(--text); background: var(--accent-glow); }
  .timeline-time {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
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
  .audio-controls label {
    font-size: 12px;
    color: var(--text-muted);
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
    transition: background 0.15s;
  }
  .scene-card:hover { background: var(--surface2); }
  .scene-card.active { background: var(--accent-glow); border-left: 3px solid var(--accent); }
  .scene-card .scene-name {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scene-card .scene-time {
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 400;
  }
  .scene-card .scene-duration {
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
  }
  .hint-text {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    margin-top: 2px;
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
    border-radius: 6px;
    background: var(--surface2);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { border-color: var(--text-muted); }
  .btn-accent {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }
  .btn-accent:hover { opacity: 0.9; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-row { display: flex; gap: 6px; margin-top: 8px; }

  /* Status indicator */
  .status {
    padding: 8px 16px;
    font-size: 12px;
    color: var(--text-muted);
    border-top: 1px solid var(--border);
    margin-top: auto;
  }
  .status.saving { color: var(--warning); }
  .status.saved { color: var(--success); }
  .status.error { color: #ef4444; }

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
    <button class="btn btn-accent" id="btn-save" title="Save all changes">Save</button>
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
    </div>
    <div class="timeline-time">
      <span id="time-current">0:00</span>
      <span id="time-total">0:00</span>
    </div>
    <div class="audio-controls">
      <button class="btn" id="btn-play">Play</button>
      <label><input type="checkbox" id="cb-audio" checked> Audio</label>
      <label><input type="checkbox" id="cb-overlays" checked> Overlays</label>
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
let audioStartOffset = 0;

async function initAudio() {
  audioCtx = new AudioContext();
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
    marker.textContent = s.name;
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
  timelineProgress.style.width = ((currentMs / totalMs) * 100) + '%';
  document.getElementById('time-current').textContent = formatTime(currentMs);

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

// Play/pause
document.getElementById('btn-play').addEventListener('click', () => {
  if (video.paused) {
    video.play();
    if (document.getElementById('cb-audio').checked) playAudio();
    document.getElementById('btn-play').textContent = 'Pause';
  } else {
    video.pause();
    stopAudio();
    document.getElementById('btn-play').textContent = 'Play';
  }
});

video.addEventListener('ended', () => {
  stopAudio();
  document.getElementById('btn-play').textContent = 'Play';
});

// Audio checkbox
document.getElementById('cb-audio').addEventListener('change', (e) => {
  if (e.target.checked && !video.paused) {
    playAudio();
  } else {
    stopAudio();
  }
});

function playAudio() {
  if (!audioCtx || !alignedAudioBuffer) return;
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
    playAudio();
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

    const durationMs = s.report?.durationMs ?? DATA.sceneDurations[s.name] ?? 0;

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
        <button class="btn" onclick="playSceneClip('\${esc(s.name)}')">Play clip</button>
        <button class="btn btn-accent" onclick="regenClip('\${esc(s.name)}', this)">Regen TTS</button>
      </div>
    \`;

    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' ||
          e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
      seekToScene(s);
    });

    // Live preview: update overlay on the video layer when editing
    let debounceTimer;
    card.querySelectorAll('[data-field^="overlay"]').forEach(input => {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => saveOverlays(), 300);
      });
    });

    sceneList.appendChild(card);
  }
}

function renderOverlayFields(s) {
  const ov = s.overlay;
  return \`
    <div class="overlay-section">
      <div class="section-title">Overlay</div>
      <div class="field-group" style="display:flex;gap:8px">
        <div style="flex:1">
          <label>Type</label>
          <select data-field="overlay-type" data-scene="\${esc(s.name)}">
            <option value="">none</option>
            <option value="lower-third" \${ov?.type === 'lower-third' ? 'selected' : ''}>lower-third</option>
            <option value="headline-card" \${ov?.type === 'headline-card' ? 'selected' : ''}>headline-card</option>
            <option value="callout" \${ov?.type === 'callout' ? 'selected' : ''}>callout</option>
            <option value="image-card" \${ov?.type === 'image-card' ? 'selected' : ''}>image-card</option>
          </select>
        </div>
        <div style="flex:1">
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
      </div>
      <div class="field-group">
        <label>Overlay text</label>
        <input data-field="overlay-text" data-scene="\${esc(s.name)}" value="\${esc(ov?.type === 'lower-third' || ov?.type === 'callout' ? (ov?.text ?? '') : (ov?.title ?? ''))}">
      </div>
    </div>
  \`;
}

// ─── Actions ───────────────────────────────────────────────────────────────
function seekToScene(s) {
  video.currentTime = s.startMs / 1000;
  syncAudio();
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

async function playSceneClip(sceneName) {
  if (!audioCtx) await initAudio();
  // Find the clip file — clips are content-addressed so we need to try loading from the API
  const s = scenes.find(s => s.name === sceneName);
  if (!s?.report) return;

  // Play the aligned audio segment for this scene
  if (alignedAudioBuffer && s.report) {
    const startSec = s.report.startMs / 1000;
    const endSec = s.report.endMs / 1000;
    stopAudio();
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = alignedAudioBuffer;
    audioSource.connect(audioCtx.destination);
    audioSource.start(0, startSec, endSec - startSec);
  }
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
    if (result.durationMs) {
      DATA.sceneDurations[sceneName] = result.durationMs;
    }

    // Reload aligned audio
    await initAudio();
    // Reload data
    const dataResp = await fetch('/api/data');
    const newData = await dataResp.json();
    Object.assign(DATA, newData);
    // Update scene objects
    for (const s of scenes) {
      s.vo = DATA.voiceover.find(v => v.scene === s.name);
      s.report = DATA.sceneReport?.scenes?.find(r => r.scene === s.name);
    }

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
    const entry = { scene: s.name, text: textEl?.value ?? '' };
    if (voiceEl?.value) entry.voice = voiceEl.value;
    if (speedEl?.value) entry.speed = parseFloat(speedEl.value);
    return entry;
  });
}

function collectOverlays() {
  return scenes
    .map(s => {
      const typeEl = document.querySelector('select[data-scene="' + s.name + '"][data-field="overlay-type"]');
      const placeEl = document.querySelector('select[data-scene="' + s.name + '"][data-field="overlay-placement"]');
      const textEl = document.querySelector('input[data-scene="' + s.name + '"][data-field="overlay-text"]');
      const type = typeEl?.value;
      if (!type) return null;
      const entry = { scene: s.name, type, placement: placeEl?.value ?? 'bottom-center' };
      if (type === 'lower-third' || type === 'callout') entry.text = textEl?.value ?? '';
      else entry.title = textEl?.value ?? '';
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
    for (const s of scenes) {
      s.rendered = DATA.renderedOverlays[s.name];
    }
    renderOverlayElements();
    updateOverlayVisibility(video.currentTime * 1000);
  }
}

// Save button
document.getElementById('btn-save').addEventListener('click', async () => {
  setStatus('Saving...', 'saving');
  try {
    await saveVoiceover();
    await saveOverlays();
    setStatus('All changes saved', 'saved');
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

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (cls || '');
  if (cls === 'saved') setTimeout(() => { statusEl.textContent = 'Ready'; statusEl.className = 'status'; }, 3000);
}

// ─── Init ──────────────────────────────────────────────────────────────────
renderSceneList();
initAudio();
</script>
</body>
</html>`;
