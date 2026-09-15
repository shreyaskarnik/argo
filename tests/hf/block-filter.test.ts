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
    expect(r.filterParts[0]).toBe(
      '[2:v]format=rgba,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setpts=PTS+12.000/TB[hfblk0]',
    );
    expect(r.filterParts[1]).toBe(
      "[v0][hfblk0]overlay=0:0:enable='between(t\\,12.000\\,14.000)':format=auto:eof_action=pass[hfb0]",
    );
    expect(r.videoSource).toBe('hfb0');
  });

  // 'cover' means fill the frame and crop the overflow, keeping the block's
  // aspect ratio. A bare scale=W:H stretched instead, so a 16:9 block in a 9:16
  // viewport variant came out squashed to a third of its width.
  it('cover fit keeps aspect ratio: fills and centre-crops a mismatched frame (real ffmpeg)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const run = promisify(execFile);
    const tmp = mkdtempSync(join(tmpdir(), 'argo-cover-'));
    try {
      // 16:9 block: a centred red square on blue. Covered into 9:16, the square
      // scales to fill the whole visible width, so the left edge must be red.
      // Stretched instead, the square narrows and the left edge shows blue.
      const pngDir = join(tmp, 'frames');
      mkdirSync(pngDir);
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=192x108',
        '-vf', 'drawbox=x=42:y=0:w=108:h=108:color=red:t=fill', '-frames:v', '1', '-y', join(pngDir, 'frame_0000.png')]);

      const block: RenderedHfBlock = { ...BLOCK, pngDir, frameCount: 1, fps: 1, startMs: 0, endMs: 1000, width: 192, height: 108 };
      const { inputArgs, filterParts, videoSource } = buildHfBlockFilters([block], 1, 'v0', 108, 192);
      const out = join(tmp, 'out.png');
      await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=108x192:d=1', ...inputArgs,
        '-filter_complex', ['[0:v]null[v0]', ...filterParts].join(';'), '-map', `[${videoSource}]`, '-frames:v', '1', '-y', out]);

      const { stdout } = await run('ffmpeg',
        ['-v', 'error', '-i', out, '-vf', 'crop=1:1:4:96', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer' });
      const [r, g, b] = stdout as unknown as Buffer;
      expect(r, `left edge was rgb(${r},${g},${b}): the block was stretched, not covered`).toBeGreaterThan(200);
      expect(b).toBeLessThan(60);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
