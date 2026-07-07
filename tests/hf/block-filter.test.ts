import { describe, it, expect } from 'vitest';
import { buildHfBlockFilters, type RenderedHfBlock } from '../../src/hf/block-filter.js';

const BLOCK: RenderedHfBlock = {
  name: 'logo-outro', pngDir: '/tmp/cache/abc', frameCount: 60, fps: 30,
  startMs: 12_000, endMs: 14_000, width: 1920, height: 1080, fit: 'cover',
};

describe('buildHfBlockFilters', () => {
  it('returns passthrough for an empty list', () => {
    const r = buildHfBlockFilters([], 2, 'v0', 1920, 1080);
    expect(r).toEqual({ inputArgs: [], filterParts: [], videoSource: 'v0', nextInput: 2 });
  });

  it('adds a framerate-pinned image2 sequence input per block', () => {
    const r = buildHfBlockFilters([BLOCK], 2, 'v0', 1920, 1080);
    expect(r.inputArgs).toEqual([
      '-framerate', '30', '-start_number', '0', '-i', '/tmp/cache/abc/frame_%04d.png',
    ]);
    expect(r.nextInput).toBe(3);
  });

  it('cover fit: scales to video size, shifts pts to the window start, overlays with enable window', () => {
    const r = buildHfBlockFilters([BLOCK], 2, 'v0', 1920, 1080);
    expect(r.filterParts).toHaveLength(2);
    expect(r.filterParts[0]).toBe('[2:v]format=rgba,scale=1920:1080,setpts=PTS+12.000/TB[hfblk0]');
    expect(r.filterParts[1]).toBe(
      "[v0][hfblk0]overlay=0:0:enable='between(t\\,12.000\\,14.000)':format=auto:eof_action=pass[hfb0]",
    );
    expect(r.videoSource).toBe('hfb0');
  });

  it('custom fit: scales by factor and positions at x/y', () => {
    const r = buildHfBlockFilters(
      [{ ...BLOCK, fit: { x: 100, y: 50, scale: 0.5 } }], 2, 'v0', 1920, 1080,
    );
    expect(r.filterParts[0]).toBe('[2:v]format=rgba,scale=960:540,setpts=PTS+12.000/TB[hfblk0]');
    expect(r.filterParts[1]).toContain('overlay=100:50:enable=');
  });

  it('chains multiple blocks through intermediate labels', () => {
    const second: RenderedHfBlock = { ...BLOCK, name: 'x-post', pngDir: '/tmp/cache/def', startMs: 2000, endMs: 3000 };
    const r = buildHfBlockFilters([BLOCK, second], 2, 'v0', 1920, 1080);
    expect(r.nextInput).toBe(4);
    expect(r.filterParts[1]).toContain('[v0][hfblk0]');
    expect(r.filterParts[3]).toContain('[hfb0][hfblk1]');
    expect(r.videoSource).toBe('hfb1');
  });
});
