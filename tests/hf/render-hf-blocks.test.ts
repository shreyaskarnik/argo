import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveHfBlockCues, renderHfBlocks } from '../../src/hf/block-render.js';

const FIXTURE_BLOCK = `<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px}</style></head>
<body><div data-composition-id="fx"><div id="p"></div></div>
<script>window.__timelines={fx:{duration(){return 1},pause(){},seek(t){document.getElementById('p').textContent=String(t)}}};</script>
</body></html>`;

describe('resolveHfBlockCues', () => {
  const placements = [
    { scene: 'intro', startMs: 0, endMs: 4000 },
    { scene: 'outro', startMs: 10_000, endMs: 13_000 },
  ];

  it('maps cues onto placement windows with defaults', () => {
    const manifest = [
      { scene: 'intro', overlay: { type: 'lower-third', title: 'x' } },
      { scene: 'outro', overlay: { type: 'hf-block', name: 'logo-outro' } },
    ];
    const cues = resolveHfBlockCues(manifest, placements);
    expect(cues).toEqual([{
      name: 'logo-outro', params: undefined, fit: 'cover', holdLastFrame: false,
      startMs: 10_000, endMs: 13_000,
    }]);
  });

  it('caps cue durationMs at the placement window but lets it extend for the last scene', () => {
    const manifest = [
      { scene: 'intro', overlay: { type: 'hf-block', name: 'a', durationMs: 99_000 } },
      { scene: 'outro', overlay: { type: 'hf-block', name: 'b', durationMs: 20_000 } },
    ];
    const cues = resolveHfBlockCues(manifest, placements);
    expect(cues[0].endMs).toBe(10_000);   // capped at next placement start
    expect(cues[1].endMs).toBe(30_000);   // last scene: extends; ffmpeg clips at video end
  });

  it('skips scenes without placements', () => {
    const cues = resolveHfBlockCues(
      [{ scene: 'ghost', overlay: { type: 'hf-block', name: 'a' } }],
      placements,
    );
    expect(cues).toEqual([]);
  });
});

describe('renderHfBlocks', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'argo-renderhf-'));
    mkdirSync(join(tmp, 'blocks', 'fx'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'fx', 'fx.html'), FIXTURE_BLOCK);
    writeFileSync(join(tmp, 'blocks', 'fx', 'registry-item.json'), JSON.stringify({
      name: 'fx', type: 'hyperframes:block', files: [{ path: 'fx.html' }],
      dimensions: { width: 320, height: 180 },
    }));
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('renders, caches, and returns composite-ready records', async () => {
    const cues = [{ name: 'fx', params: undefined, fit: 'cover' as const, holdLastFrame: false, startMs: 500, endMs: 1500 }];
    const r1 = await renderHfBlocks({ cues, blocksDir: join(tmp, 'blocks'), cacheDir: join(tmp, 'cache'), fps: 10 });
    expect(r1).toHaveLength(1);
    expect(r1[0]).toMatchObject({ name: 'fx', startMs: 500, endMs: 1500, fps: 10, width: 320, height: 180, fit: 'cover', frameCount: 10 });
    expect(readdirSync(r1[0].pngDir).filter((f) => f.endsWith('.png'))).toHaveLength(10);

    // second run: cache hit — same pngDir, no re-render (mtime of first frame unchanged)
    const before = readdirSync(r1[0].pngDir).length;
    const r2 = await renderHfBlocks({ cues, blocksDir: join(tmp, 'blocks'), cacheDir: join(tmp, 'cache'), fps: 10 });
    expect(r2[0].pngDir).toBe(r1[0].pngDir);
    expect(readdirSync(r2[0].pngDir).length).toBe(before);
  }, 60_000);

  it('throws with an install hint for a missing block', async () => {
    await expect(renderHfBlocks({
      cues: [{ name: 'nope', params: undefined, fit: 'cover', holdLastFrame: false, startMs: 0, endMs: 1000 }],
      blocksDir: join(tmp, 'blocks'), cacheDir: join(tmp, 'cache'), fps: 10,
    })).rejects.toThrow(/argo add nope/);
  });
});
