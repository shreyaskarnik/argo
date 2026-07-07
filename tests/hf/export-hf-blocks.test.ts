import { describe, it, expect } from 'vitest';
import type { ExportOptions } from '../../src/export.js';
import type { RenderedHfBlock } from '../../src/hf/block-filter.js';

describe('ExportOptions.hfBlocks', () => {
  it('accepts pre-rendered block sequences at compile time', () => {
    const blocks: RenderedHfBlock[] = [{
      name: 'logo-outro', pngDir: '/tmp/x', frameCount: 60, fps: 30,
      startMs: 0, endMs: 2000, width: 1920, height: 1080, fit: 'cover',
    }];
    const opts: Partial<ExportOptions> = { hfBlocks: blocks };
    expect(opts.hfBlocks).toHaveLength(1);
  });
});
