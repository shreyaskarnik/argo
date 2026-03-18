/**
 * argo preview (no args) — multi-demo dashboard.
 *
 * Shows a landing page listing all discovered demos with status indicators,
 * thumbnails (if MP4 exists), and links to individual preview pages.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync, readdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { discoverDemos } from './pipeline.js';

export interface DashboardOptions {
  demosDir: string;
  outputDir: string;
  argoDir?: string;
  port?: number;
}

interface DemoStatus {
  name: string;
  hasManifest: boolean;
  hasScript: boolean;
  hasVideo: boolean;
  hasMeta: boolean;
  meta?: Record<string, unknown>;
  videoSize?: string;
  lastModified?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function gatherDemoStatuses(demosDir: string, outputDir: string): DemoStatus[] {
  const demos = discoverDemos(demosDir);
  return demos.map((name) => {
    const status: DemoStatus = {
      name,
      hasManifest: existsSync(join(demosDir, `${name}.scenes.json`)),
      hasScript: existsSync(join(demosDir, `${name}.demo.ts`)),
      hasVideo: existsSync(join(outputDir, `${name}.mp4`)),
      hasMeta: existsSync(join(outputDir, `${name}.meta.json`)),
    };
    if (status.hasVideo) {
      const stat = statSync(join(outputDir, `${name}.mp4`));
      status.videoSize = formatBytes(stat.size);
      status.lastModified = stat.mtime.toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
    }
    if (status.hasMeta) {
      try {
        status.meta = JSON.parse(readFileSync(join(outputDir, `${name}.meta.json`), 'utf-8'));
      } catch { /* ignore */ }
    }
    return status;
  });
}

function renderDashboardHTML(statuses: DemoStatus[], port: number): string {
  const rows = statuses.map((s) => {
    const statusDot = s.hasVideo ? '🟢' : s.hasScript ? '🟡' : '🔴';
    const videoInfo = s.hasVideo
      ? `<span class="meta">${s.videoSize} &middot; ${s.lastModified}</span>`
      : '<span class="meta dim">Not exported</span>';
    const metaInfo = s.meta
      ? `<span class="meta">${(s.meta as any).video?.width}×${(s.meta as any).video?.height} &middot; ${(s.meta as any).video?.browser}</span>`
      : '';
    const previewLink = s.hasVideo
      ? `<a href="/video/${s.name}" target="_blank" class="btn">Preview</a>`
      : '';

    return `
      <tr>
        <td>${statusDot}</td>
        <td><strong>${s.name}</strong></td>
        <td>${s.hasScript ? '✓' : '✗'}</td>
        <td>${s.hasManifest ? '✓' : '✗'}</td>
        <td>${videoInfo}</td>
        <td>${metaInfo}</td>
        <td>${previewLink}</td>
      </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argo Dashboard</title>
  <style>
    :root { --bg: #0f0f0f; --fg: #e0e0e0; --accent: #3b82f6; --card: #1a1a1a; --border: #2a2a2a; }
    @media (prefers-color-scheme: light) {
      :root { --bg: #fafafa; --fg: #1a1a1a; --accent: #2563eb; --card: #fff; --border: #e0e0e0; }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--fg); padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .subtitle { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    th { text-align: left; padding: 0.75rem 1rem; background: var(--border); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; }
    td { padding: 0.75rem 1rem; border-top: 1px solid var(--border); }
    tr:hover td { background: rgba(59, 130, 246, 0.05); }
    .meta { font-size: 0.85rem; color: #888; }
    .meta.dim { opacity: 0.5; }
    .btn { display: inline-block; padding: 0.3rem 0.8rem; background: var(--accent); color: white; border-radius: 4px; text-decoration: none; font-size: 0.8rem; }
    .btn:hover { opacity: 0.9; }
    .summary { margin-top: 1.5rem; padding: 1rem; background: var(--card); border: 1px solid var(--border); border-radius: 8px; font-size: 0.9rem; }
    .cmd { font-family: 'SF Mono', 'Fira Code', monospace; background: var(--border); padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Argo Dashboard</h1>
  <p class="subtitle">${statuses.length} demo(s) discovered</p>

  <table>
    <thead>
      <tr>
        <th></th>
        <th>Demo</th>
        <th>Script</th>
        <th>Manifest</th>
        <th>Video</th>
        <th>Config</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <div class="summary">
    <strong>Quick commands:</strong><br>
    <span class="cmd">argo pipeline &lt;demo&gt;</span> — Build a single demo<br>
    <span class="cmd">argo pipeline --all</span> — Build all demos<br>
    <span class="cmd">argo preview &lt;demo&gt;</span> — Preview a specific demo
  </div>
</body>
</html>`;
}

export async function startDashboardServer(options: DashboardOptions): Promise<{ url: string }> {
  const { demosDir, outputDir, port: preferredPort } = options;

  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';

      // Serve video files at /video/<name>
      const videoMatch = url.match(/^\/video\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/);
      if (videoMatch) {
        const name = videoMatch[1];
        const videoPath = join(outputDir, `${name}.mp4`);
        if (!existsSync(videoPath)) {
          res.writeHead(404);
          res.end('Video not found');
          return;
        }
        const stat = statSync(videoPath);
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': 'video/mp4',
          });
          createReadStream(videoPath, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
          });
          createReadStream(videoPath).pipe(res);
        }
        return;
      }

      // Dashboard HTML
      const statuses = gatherDemoStatuses(demosDir, outputDir);
      const actualPort = (server.address() as any)?.port ?? preferredPort ?? 3000;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHTML(statuses, actualPort));
    });

    const listenPort = preferredPort ?? 0;
    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({ url });
    });
  });
}
