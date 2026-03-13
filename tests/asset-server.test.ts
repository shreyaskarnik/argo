import { describe, it, expect, afterEach } from 'vitest';
import { startAssetServer } from '../src/asset-server.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('startAssetServer', () => {
  let tmpDir: string;
  let close: (() => Promise<void>) | undefined;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'argo-asset-'));
    mkdirSync(join(tmpDir, 'assets'), { recursive: true });
  }

  afterEach(async () => {
    if (close) await close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves files from the asset directory', async () => {
    setup();
    writeFileSync(join(tmpDir, 'assets', 'test.txt'), 'hello');
    const server = await startAssetServer(join(tmpDir, 'assets'));
    close = server.close;

    const res = await fetch(`${server.url}/test.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('returns 404 for missing files', async () => {
    setup();
    const server = await startAssetServer(join(tmpDir, 'assets'));
    close = server.close;

    const res = await fetch(`${server.url}/nope.png`);
    expect(res.status).toBe(404);
  });

  it('prevents path traversal', async () => {
    setup();
    writeFileSync(join(tmpDir, 'secret.txt'), 'private');
    const server = await startAssetServer(join(tmpDir, 'assets'));
    close = server.close;

    const res = await fetch(`${server.url}/../secret.txt`);
    expect(res.status).toBe(403);
  });

  it('assigns a random available port', async () => {
    setup();
    const server = await startAssetServer(join(tmpDir, 'assets'));
    close = server.close;
    expect(server.port).toBeGreaterThan(0);
  });

  it('serves PNG with correct content type', async () => {
    setup();
    writeFileSync(join(tmpDir, 'assets', 'img.png'), Buffer.from([0x89, 0x50]));
    const server = await startAssetServer(join(tmpDir, 'assets'));
    close = server.close;

    const res = await fetch(`${server.url}/img.png`);
    expect(res.headers.get('content-type')).toBe('image/png');
  });
});
