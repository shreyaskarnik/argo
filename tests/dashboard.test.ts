import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { previewClose, mockedStartPreviewServer } = vi.hoisted(() => ({
  previewClose: vi.fn(),
  mockedStartPreviewServer: vi.fn(),
}));

vi.mock('../src/preview.js', () => ({
  startPreviewServer: mockedStartPreviewServer,
}));

import { startDashboardServer } from '../src/dashboard.js';

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

const describeDashboard = (await canBindLocalhost()) ? describe : describe.skip;

describeDashboard('dashboard server', () => {
  let dir: string;
  let close: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-dashboard-'));
    await mkdir(join(dir, 'demos'), { recursive: true });
    await mkdir(join(dir, 'videos'), { recursive: true });

    await writeFile(join(dir, 'demos', 'alpha.scenes.json'), '[]');
    await writeFile(join(dir, 'demos', 'alpha.demo.ts'), '// demo');
    await writeFile(join(dir, 'videos', 'alpha.mp4'), 'fake-mp4');
    await writeFile(join(dir, 'videos', 'alpha.meta.json'), JSON.stringify({
      video: { width: 1920, height: 1080, browser: 'webkit' },
    }));

    previewClose.mockReset();
    mockedStartPreviewServer.mockReset();
    mockedStartPreviewServer.mockResolvedValue({
      url: 'http://127.0.0.1:43210',
      close: previewClose,
    });
  });

  afterEach(async () => {
    close?.();
    close = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('serves dashboard HTML with discovered demos', async () => {
    const server = await startDashboardServer({
      demosDir: join(dir, 'demos'),
      outputDir: join(dir, 'videos'),
    });
    close = server.close;

    const resp = await fetch(server.url);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const html = await resp.text();
    expect(html).toContain('Argo Dashboard');
    expect(html).toContain('alpha');
    expect(html).toContain('/preview/alpha');
    expect(html).toContain('1920×1080');
    expect(html).toContain('webkit');
  });

  it('redirects preview requests and passes through custom argoDir', async () => {
    const server = await startDashboardServer({
      demosDir: join(dir, 'demos'),
      outputDir: join(dir, 'videos'),
      argoDir: join(dir, 'custom-argo'),
      ttsDefaults: { voice: 'af_heart', speed: 1.0 },
      exportConfig: { preset: 'slow', speedRamp: { gapSpeed: 2, minGapMs: 500 } },
    });
    close = server.close;

    const resp = await fetch(`${server.url}/preview/alpha`, { redirect: 'manual' });
    expect(resp.status).toBe(302);
    expect(resp.headers.get('location')).toBe('http://127.0.0.1:43210');
    expect(mockedStartPreviewServer).toHaveBeenCalledWith(expect.objectContaining({
      demoName: 'alpha',
      argoDir: join(dir, 'custom-argo'),
      demosDir: join(dir, 'demos'),
      outputDir: join(dir, 'videos'),
      ttsDefaults: { voice: 'af_heart', speed: 1.0 },
      exportConfig: { preset: 'slow', speedRamp: { gapSpeed: 2, minGapMs: 500 } },
    }));
  });

  it('reuses an already spawned preview server for repeated redirects', async () => {
    const server = await startDashboardServer({
      demosDir: join(dir, 'demos'),
      outputDir: join(dir, 'videos'),
    });
    close = server.close;

    const first = await fetch(`${server.url}/preview/alpha`, { redirect: 'manual' });
    const second = await fetch(`${server.url}/preview/alpha`, { redirect: 'manual' });

    expect(first.headers.get('location')).toBe('http://127.0.0.1:43210');
    expect(second.headers.get('location')).toBe('http://127.0.0.1:43210');
    expect(mockedStartPreviewServer).toHaveBeenCalledTimes(1);
  });

  it('closes spawned preview servers when dashboard closes', async () => {
    const server = await startDashboardServer({
      demosDir: join(dir, 'demos'),
      outputDir: join(dir, 'videos'),
    });

    await fetch(`${server.url}/preview/alpha`, { redirect: 'manual' });
    server.close();

    expect(previewClose).toHaveBeenCalledTimes(1);
  });

  it('rejects when the listen port is already in use', async () => {
    const blocker = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => {
        const address = blocker.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });

    try {
      await expect(startDashboardServer({
        demosDir: join(dir, 'demos'),
        outputDir: join(dir, 'videos'),
        port,
      })).rejects.toThrow('Dashboard server failed to start');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
