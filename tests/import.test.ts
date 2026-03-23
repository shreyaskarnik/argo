import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock media.js to avoid needing a real video + ffprobe
vi.mock('../src/media.js', () => ({
  getVideoDurationMs: vi.fn(() => 45200),
  getVideoFrameRate: vi.fn(() => 30),
  getVideoDimensions: vi.fn(() => ({ width: 1920, height: 1080 })),
}));

import { importVideo } from '../src/import.js';

describe('importVideo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-import-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function createFakeVideo(name: string): Promise<string> {
    const p = join(dir, name);
    await writeFile(p, 'fake-video-content');
    return p;
  }

  it('imports a video and creates the expected scaffold files', async () => {
    const videoPath = await createFakeVideo('recording.mp4');
    const result = await importVideo({ videoPath, cwd: dir });

    expect(result.demoName).toBe('recording');
    expect(result.durationMs).toBe(45200);

    // Check video was copied
    expect(existsSync(join(dir, '.argo', 'recording', 'video.mp4'))).toBe(true);

    // Check .scenes.json was created
    const manifest = JSON.parse(await readFile(join(dir, 'demos', 'recording.scenes.json'), 'utf-8'));
    expect(Array.isArray(manifest)).toBe(true);
    expect(manifest).toHaveLength(1);
    expect(manifest[0].scene).toBe('intro');
    expect(manifest[0].text).toBe('');

    // Check .timing.json was created
    const timing = JSON.parse(await readFile(join(dir, '.argo', 'recording', '.timing.json'), 'utf-8'));
    expect(timing).toEqual({ intro: 0 });

    // Check .imported marker was created with metadata
    expect(existsSync(join(dir, '.argo', 'recording', '.imported'))).toBe(true);
    const imported = JSON.parse(await readFile(join(dir, '.argo', 'recording', '.imported'), 'utf-8'));
    expect(imported.width).toBe(1920);
    expect(imported.height).toBe(1080);
    expect(imported.durationMs).toBe(45200);

    // Check result includes dimensions
    expect(result.dimensions).toEqual({ width: 1920, height: 1080 });
  });

  it('uses --demo flag to set the demo name', async () => {
    const videoPath = await createFakeVideo('my-screen.mov');
    const result = await importVideo({ videoPath, demo: 'myapp', cwd: dir });

    expect(result.demoName).toBe('myapp');
    expect(existsSync(join(dir, '.argo', 'myapp', 'video.mov'))).toBe(true);
    expect(existsSync(join(dir, 'demos', 'myapp.scenes.json'))).toBe(true);
  });

  it('sanitizes filename to derive demo name', async () => {
    const videoPath = await createFakeVideo('My Screen Recording (2).mp4');
    const result = await importVideo({ videoPath, cwd: dir });

    expect(result.demoName).toBe('My-Screen-Recording-2');
  });

  it('throws for unsupported video format', async () => {
    const videoPath = await createFakeVideo('video.txt');
    await expect(importVideo({ videoPath, cwd: dir })).rejects.toThrow('Unsupported video format');
  });

  it('throws when video file does not exist', async () => {
    await expect(importVideo({ videoPath: '/nonexistent/video.mp4', cwd: dir })).rejects.toThrow(
      'Video file not found',
    );
  });

  it('throws for invalid demo name from --demo', async () => {
    const videoPath = await createFakeVideo('test.mp4');
    await expect(importVideo({ videoPath, demo: '..bad', cwd: dir })).rejects.toThrow(
      'Invalid demo name',
    );
  });

  it('does not overwrite existing .scenes.json', async () => {
    const videoPath = await createFakeVideo('test.mp4');
    // Pre-create a manifest
    await mkdir(join(dir, 'demos'), { recursive: true });
    await writeFile(join(dir, 'demos', 'test.scenes.json'), '[{"scene":"existing","text":"hello"}]');

    await importVideo({ videoPath, cwd: dir });

    const manifest = JSON.parse(await readFile(join(dir, 'demos', 'test.scenes.json'), 'utf-8'));
    expect(manifest[0].scene).toBe('existing');
  });

  it('does not overwrite existing .timing.json', async () => {
    const videoPath = await createFakeVideo('test.mp4');
    // Pre-create timing
    await mkdir(join(dir, '.argo', 'test'), { recursive: true });
    await writeFile(join(dir, '.argo', 'test', '.timing.json'), '{"existing":500}');

    await importVideo({ videoPath, cwd: dir });

    const timing = JSON.parse(await readFile(join(dir, '.argo', 'test', '.timing.json'), 'utf-8'));
    expect(timing).toEqual({ existing: 500 });
  });

  it('supports .webm input', async () => {
    const videoPath = await createFakeVideo('screen.webm');
    const result = await importVideo({ videoPath, cwd: dir });
    expect(result.demoName).toBe('screen');
  });

  it('supports .mov input', async () => {
    const videoPath = await createFakeVideo('capture.mov');
    const result = await importVideo({ videoPath, cwd: dir });
    expect(result.demoName).toBe('capture');
  });

  it('overwrites scaffold files with --force', async () => {
    const videoPath = await createFakeVideo('test.mp4');
    // Pre-create a manifest and timing
    await mkdir(join(dir, 'demos'), { recursive: true });
    await writeFile(join(dir, 'demos', 'test.scenes.json'), '[{"scene":"existing","text":"hello"}]');
    await mkdir(join(dir, '.argo', 'test'), { recursive: true });
    await writeFile(join(dir, '.argo', 'test', '.timing.json'), '{"existing":500}');

    await importVideo({ videoPath, cwd: dir, force: true });

    // Should be overwritten with fresh scaffold
    const manifest = JSON.parse(await readFile(join(dir, 'demos', 'test.scenes.json'), 'utf-8'));
    expect(manifest[0].scene).toBe('intro');
    const timing = JSON.parse(await readFile(join(dir, '.argo', 'test', '.timing.json'), 'utf-8'));
    expect(timing).toEqual({ intro: 0 });
  });
});
