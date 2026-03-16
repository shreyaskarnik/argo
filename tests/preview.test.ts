import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPreviewServer } from '../src/preview.js';

/** Create a minimal .argo/<demo> directory with the files preview needs. */
async function scaffoldDemo(dir: string, demoName: string) {
  const argoDir = join(dir, '.argo', demoName);
  const demosDir = join(dir, 'demos');
  await mkdir(argoDir, { recursive: true });
  await mkdir(join(argoDir, 'clips'), { recursive: true });
  await mkdir(demosDir, { recursive: true });

  // Fake video.webm (just needs to exist)
  writeFileSync(join(argoDir, 'video.webm'), Buffer.from('fake-webm'));

  // Timing
  writeFileSync(join(argoDir, '.timing.json'), JSON.stringify({
    welcome: 0,
    feature: 2000,
    closing: 5000,
  }));

  // Scene durations
  writeFileSync(join(argoDir, '.scene-durations.json'), JSON.stringify({
    welcome: 1800,
    feature: 2400,
    closing: 1500,
  }));

  // Fake aligned audio
  writeFileSync(join(argoDir, 'narration-aligned.wav'), Buffer.from('fake-wav'));

  // Scene report
  writeFileSync(join(argoDir, 'scene-report.json'), JSON.stringify({
    demo: demoName,
    totalDurationMs: 8000,
    overflowMs: 0,
    scenes: [
      { scene: 'welcome', startMs: 0, endMs: 1800, durationMs: 1800 },
      { scene: 'feature', startMs: 2000, endMs: 4400, durationMs: 2400 },
      { scene: 'closing', startMs: 5000, endMs: 6500, durationMs: 1500 },
    ],
    output: 'videos/test.mp4',
  }));

  // Voiceover manifest
  writeFileSync(join(demosDir, `${demoName}.voiceover.json`), JSON.stringify([
    { scene: 'welcome', text: 'Welcome to the demo.' },
    { scene: 'feature', text: 'Check out this feature.' },
    { scene: 'closing', text: 'Thanks for watching.' },
  ], null, 2));

  // Overlay manifest
  writeFileSync(join(demosDir, `${demoName}.overlays.json`), JSON.stringify([
    { scene: 'welcome', type: 'lower-third', text: 'Welcome' },
    { scene: 'feature', type: 'headline-card', title: 'Feature', placement: 'top-right' },
  ], null, 2));

  return { argoDir: join(dir, '.argo'), demosDir };
}

describe('preview server', () => {
  let dir: string;
  let close: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-preview-'));
  });

  afterEach(async () => {
    close?.();
    close = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('starts and serves the preview HTML on /', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(server.url);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/html');

    const html = await resp.text();
    expect(html).toContain('Argo Preview');
    expect(html).toContain('test-demo');
    expect(html).toContain('welcome');
    expect(html).toContain('feature');
    expect(html).toContain('closing');
  });

  it('serves /api/data with timing, voiceover, overlays', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/api/data`);
    expect(resp.status).toBe(200);
    const data = await resp.json();

    expect(data.demoName).toBe('test-demo');
    expect(data.timing).toEqual({ welcome: 0, feature: 2000, closing: 5000 });
    expect(data.voiceover).toHaveLength(3);
    expect(data.overlays).toHaveLength(2);
    expect(data.sceneDurations).toEqual({ welcome: 1800, feature: 2400, closing: 1500 });
    expect(data.renderedOverlays).toHaveProperty('welcome');
    expect(data.renderedOverlays.welcome.html).toContain('Welcome');
  });

  it('serves /video.webm', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/video.webm`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('video/webm');
  });

  it('POST /api/voiceover saves the manifest file', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const newVo = [
      { scene: 'welcome', text: 'Updated welcome text.' },
      { scene: 'feature', text: 'Updated feature text.' },
      { scene: 'closing', text: 'Updated closing.' },
    ];

    const resp = await fetch(`${server.url}/api/voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newVo),
    });
    expect(resp.status).toBe(200);

    // Verify file on disk
    const saved = JSON.parse(readFileSync(join(demosDir, 'test-demo.voiceover.json'), 'utf-8'));
    expect(saved[0].text).toBe('Updated welcome text.');
  });

  it('POST /api/overlays saves and returns re-rendered overlays', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const newOv = [
      { scene: 'welcome', type: 'callout', text: 'New callout!' },
    ];

    const resp = await fetch(`${server.url}/api/overlays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newOv),
    });
    expect(resp.status).toBe(200);
    const result = await resp.json();
    expect(result.ok).toBe(true);
    expect(result.renderedOverlays.welcome.html).toContain('New callout!');

    // Verify file on disk
    const saved = JSON.parse(readFileSync(join(demosDir, 'test-demo.overlays.json'), 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].type).toBe('callout');
  });

  it('returns 404 for unknown routes', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/nonexistent`);
    expect(resp.status).toBe(404);
  });

  it('throws when no recording exists', async () => {
    const demosDir = join(dir, 'demos');
    await mkdir(demosDir, { recursive: true });
    const argoDir = join(dir, '.argo');
    await mkdir(argoDir, { recursive: true });

    await expect(
      startPreviewServer({ demoName: 'missing', argoDir, demosDir })
    ).rejects.toThrow('No recording found');
  });

  it('pre-renders overlay HTML with correct zone data', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/api/data`);
    const data = await resp.json();

    // The 'feature' overlay has placement: top-right
    expect(data.renderedOverlays.feature.zone).toBe('top-right');
    // The 'welcome' overlay defaults to bottom-center
    expect(data.renderedOverlays.welcome.zone).toBe('bottom-center');
  });
});
