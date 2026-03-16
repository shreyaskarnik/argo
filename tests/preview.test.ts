import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startPreviewServer } from '../src/preview.js';
import { ClipCache } from '../src/tts/cache.js';
import { createWavBuffer, parseWavHeader } from '../src/tts/engine.js';

/** Create a minimal .argo/<demo> directory with the files preview needs. */
async function scaffoldDemo(dir: string, demoName: string) {
  const argoDir = join(dir, '.argo', demoName);
  const demosDir = join(dir, 'demos');
  await mkdir(argoDir, { recursive: true });
  await mkdir(join(argoDir, 'clips'), { recursive: true });
  await mkdir(demosDir, { recursive: true });

  // Fake fallback recording (preview serves this via /video when no MP4 exists)
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

  // Unified scenes manifest
  writeFileSync(join(demosDir, `${demoName}.scenes.json`), JSON.stringify([
    { scene: 'welcome', text: 'Welcome to the demo.', overlay: { type: 'lower-third', text: 'Welcome' } },
    { scene: 'feature', text: 'Check out this feature.', overlay: { type: 'headline-card', title: 'Feature', placement: 'top-right' } },
    { scene: 'closing', text: 'Thanks for watching.' },
  ], null, 2));

  return { argoDir: join(dir, '.argo'), demosDir };
}

function cacheClip(
  projectRoot: string,
  demoName: string,
  entry: { scene: string; text: string; voice?: string; speed?: number; lang?: string },
  durationMs: number,
) {
  const sampleRate = 24_000;
  const samples = new Float32Array(Math.round((durationMs / 1000) * sampleRate));
  const cache = new ClipCache(projectRoot);
  cache.cacheClip(demoName, entry, createWavBuffer(samples, sampleRate));
}

async function canBindLocalhost(): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

const describePreview = (await canBindLocalhost()) ? describe : describe.skip;

describePreview('preview server', () => {
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
    expect(html).toContain('previewScene');
    expect(html).toContain('Scene scrub');
    expect(html).toContain('data-field="scene-scrub"');
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

  it('serves /video using the preview video artifact', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/video`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('video/webm');
  });

  it('supports HTTP Range requests on /video for browser seeking', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/video`, {
      headers: { Range: 'bytes=0-3' },
    });

    expect(resp.status).toBe(206);
    expect(resp.headers.get('accept-ranges')).toBe('bytes');
    expect(resp.headers.get('content-range')).toBe('bytes 0-3/9');
    expect(await resp.text()).toBe('fake');
  });

  it('returns 416 for invalid /video byte ranges', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/video`, {
      headers: { Range: 'bytes=99-120' },
    });

    expect(resp.status).toBe(416);
    expect(resp.headers.get('content-range')).toBe('bytes */9');
  });

  it('prefers an exported MP4 for /video when one exists', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    await mkdir(join(dir, 'videos'), { recursive: true });
    writeFileSync(join(dir, 'videos', 'test-demo.mp4'), Buffer.from('fake-mp4'));

    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/video`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('video/mp4');
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

    // Verify file on disk — voiceover fields updated in unified .scenes.json
    const saved = JSON.parse(readFileSync(join(demosDir, 'test-demo.scenes.json'), 'utf-8'));
    expect(saved[0].text).toBe('Updated welcome text.');
    // Overlay sub-object should be preserved
    expect(saved[0].overlay).toBeDefined();
    expect(saved[0].overlay.type).toBe('lower-third');
  });

  it('POST /api/voiceover does not rewrite the manifest when nothing changed', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const scenesPath = join(demosDir, 'test-demo.scenes.json');
    const before = readFileSync(scenesPath, 'utf-8');

    const resp = await fetch(`${server.url}/api/voiceover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { scene: 'welcome', text: 'Welcome to the demo.' },
        { scene: 'feature', text: 'Check out this feature.' },
        { scene: 'closing', text: 'Thanks for watching.' },
      ]),
    });

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ ok: true, changed: false });
    expect(readFileSync(scenesPath, 'utf-8')).toBe(before);
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

    // Verify file on disk — overlay sub-objects updated in unified .scenes.json
    const saved = JSON.parse(readFileSync(join(demosDir, 'test-demo.scenes.json'), 'utf-8'));
    // welcome scene should have the callout overlay
    expect(saved[0].overlay).toBeDefined();
    expect(saved[0].overlay.type).toBe('callout');
    // feature scene should have no overlay (was not in posted data)
    expect(saved[1].overlay).toBeUndefined();
    // voiceover fields should be preserved
    expect(saved[0].text).toBe('Welcome to the demo.');
  });

  it('POST /api/overlays does not rewrite the manifest for unchanged overlays', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const scenesPath = join(demosDir, 'test-demo.scenes.json');
    const before = readFileSync(scenesPath, 'utf-8');

    const resp = await fetch(`${server.url}/api/overlays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { scene: 'welcome', type: 'lower-third', text: 'Welcome', placement: 'bottom-center' },
        { scene: 'feature', type: 'headline-card', title: 'Feature', placement: 'top-right' },
      ]),
    });

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ ok: true, changed: false });
    expect(readFileSync(scenesPath, 'utf-8')).toBe(before);
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

  it('renders richer overlay editing fields in the preview UI', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    // Overwrite scenes.json with an image-card overlay on the feature scene
    const scenes = JSON.parse(readFileSync(join(demosDir, 'test-demo.scenes.json'), 'utf-8'));
    for (const s of scenes) delete s.overlay;
    const featureScene = scenes.find((s: any) => s.scene === 'feature');
    featureScene.overlay = {
      type: 'image-card',
      title: 'Feature',
      body: 'Body copy',
      src: 'assets/feature.png',
    };
    writeFileSync(join(demosDir, 'test-demo.scenes.json'), JSON.stringify(scenes, null, 2));

    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const html = await fetch(server.url).then((resp) => resp.text());
    expect(html).toContain('data-field="overlay-body"');
    expect(html).toContain('data-field="overlay-kicker"');
    expect(html).toContain('data-field="overlay-src"');
  });

  it('POST /api/regen-clip refreshes scene durations and aligned audio for preview playback', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const projectRoot = dir;
    const demoName = 'test-demo';

    const server = await startPreviewServer({
      demoName,
      argoDir,
      demosDir,
      regenerateTts: async () => {
        const scenes = JSON.parse(readFileSync(join(demosDir, `${demoName}.scenes.json`), 'utf-8'));
        for (const s of scenes) {
          const entry = { scene: s.scene, text: s.text, voice: s.voice, speed: s.speed, lang: s.lang };
          const durationMs = s.scene === 'feature' ? 3500 : 900;
          cacheClip(projectRoot, demoName, entry, durationMs);
        }
      },
    });
    close = server.close;

    const resp = await fetch(`${server.url}/api/regen-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: 'feature' }),
    });
    expect(resp.status).toBe(200);
    const result = await resp.json();
    expect(result.durationMs).toBe(3500);
    expect(result.sceneDurations.feature).toBe(3500);
    expect(result.sceneReport.scenes.find((scene: any) => scene.scene === 'feature').durationMs).toBe(3500);

    const durationsOnDisk = JSON.parse(readFileSync(join(argoDir, demoName, '.scene-durations.json'), 'utf-8'));
    expect(durationsOnDisk.feature).toBe(3500);

    const aligned = readFileSync(join(argoDir, demoName, 'narration-aligned.wav'));
    expect(parseWavHeader(aligned).durationMs).toBeGreaterThan(5000);
  });

  it('rejects startup when the requested port is already in use', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const first = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = first.close;
    const port = Number(new URL(first.url).port);

    await expect(
      startPreviewServer({
        demoName: 'test-demo',
        argoDir,
        demosDir,
        port,
      }),
    ).rejects.toThrow();
  });

  it('does not allow clip path traversal outside the demo clips directory', async () => {
    const { argoDir, demosDir } = await scaffoldDemo(dir, 'test-demo');
    const server = await startPreviewServer({
      demoName: 'test-demo',
      argoDir,
      demosDir,
    });
    close = server.close;

    const resp = await fetch(`${server.url}/clips/../../package.json`);
    expect(resp.status).toBe(404);
  });
});
