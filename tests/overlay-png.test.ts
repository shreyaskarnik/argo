import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildOverlayPngFilters, isImportedVideo, type RenderedOverlayPng } from '../src/overlays/render-to-png.js';

describe('isImportedVideo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-overlay-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns true when .imported marker exists', async () => {
    await mkdir(join(dir, 'myapp'), { recursive: true });
    await writeFile(join(dir, 'myapp', '.imported'), '');
    expect(isImportedVideo(dir, 'myapp')).toBe(true);
  });

  it('returns false when .imported marker does not exist', async () => {
    await mkdir(join(dir, 'myapp'), { recursive: true });
    expect(isImportedVideo(dir, 'myapp')).toBe(false);
  });

  it('returns false when demo dir does not exist', () => {
    expect(isImportedVideo(dir, 'nonexistent')).toBe(false);
  });
});

describe('buildOverlayPngFilters', () => {
  const samplePngs: RenderedOverlayPng[] = [
    { scene: 'intro', pngPath: '/tmp/intro.png', zone: 'bottom-center', startMs: 0, endMs: 5000 },
    { scene: 'demo', pngPath: '/tmp/demo.png', zone: 'top-left', startMs: 5000, endMs: 10000 },
  ];

  it('returns empty results for empty input', () => {
    const result = buildOverlayPngFilters([], 2, '0:v');
    expect(result.inputArgs).toEqual([]);
    expect(result.filterParts).toEqual([]);
    expect(result.videoSource).toBe('0:v');
    expect(result.nextInput).toBe(2);
  });

  it('generates correct input args with -loop and -t', () => {
    const result = buildOverlayPngFilters(samplePngs, 2, '0:v');
    expect(result.inputArgs).toContain('-loop');
    expect(result.inputArgs).toContain('1');
    expect(result.inputArgs).toContain('/tmp/intro.png');
    expect(result.inputArgs).toContain('/tmp/demo.png');
    // Duration should be endMs + 1000ms converted to seconds
    expect(result.inputArgs).toContain('6.000'); // (5000 + 1000) / 1000
    expect(result.inputArgs).toContain('11.000'); // (10000 + 1000) / 1000
  });

  it('generates correct filter parts with overlay and enable', () => {
    const result = buildOverlayPngFilters(samplePngs, 2, '0:v');
    expect(result.filterParts).toHaveLength(2);
    // First overlay: input 2, enables between 0 and 5s
    expect(result.filterParts[0]).toContain('[0:v][2:v]overlay=');
    expect(result.filterParts[0]).toContain("enable='between");
    expect(result.filterParts[0]).toContain('0.000');
    expect(result.filterParts[0]).toContain('5.000');
    // Second overlay chains from first output
    expect(result.filterParts[1]).toContain('[ovlpng0][3:v]overlay=');
  });

  it('tracks input indices correctly', () => {
    const result = buildOverlayPngFilters(samplePngs, 5, 'outvfinal');
    // Should start at input 5
    expect(result.filterParts[0]).toContain('[outvfinal][5:v]');
    expect(result.filterParts[1]).toContain('[ovlpng0][6:v]');
    expect(result.nextInput).toBe(7);
    expect(result.videoSource).toBe('ovlpng1');
  });

  it('maps zone positions correctly', () => {
    const centerPng: RenderedOverlayPng[] = [
      { scene: 'test', pngPath: '/tmp/test.png', zone: 'center', startMs: 0, endMs: 1000 },
    ];
    const result = buildOverlayPngFilters(centerPng, 2, '0:v');
    expect(result.filterParts[0]).toContain('overlay=x=(W-w)/2:y=(H-h)/2');
  });
});
