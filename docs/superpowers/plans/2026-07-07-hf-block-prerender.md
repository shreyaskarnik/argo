# HyperFrames Block Pre-Render Adapter — Implementation Plan (Track 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installed hyperframes **blocks** (full HTML compositions with paused GSAP timelines) become composited overlays in exported videos: a new `hf-block` overlay cue triggers an export-time pre-pass that renders the block's timeline frame-by-frame in headless Chromium (alpha PNG sequence, content-addressed cache) and composites it via ffmpeg `overlay` with `enable='between(t,start,end)'` — cutaway semantics, no timeline surgery.

**Architecture:** Generalizes the `shader-render.ts` pattern. New modules: `src/hf/block-render.ts` (frame renderer + cue resolver + orchestrator) and `src/hf/block-filter.ts` (ffmpeg filter builder mirroring `buildOverlayPngFilters` in `src/overlays/render-to-png.ts`, extended for image sequences with a `setpts` time shift). `ExportOptions` gains `hfBlocks?: RenderedHfBlock[]`, composited in the same layer slot as `overlayPngs` (after camera moves, before frame effect/watermark). Wired at all four export paths.

**Tech Stack:** TypeScript (strict, ESM), vitest, Playwright Chromium (swiftshader flags, shared browser across blocks), ffmpeg image2 sequence inputs.

**Spec:** `docs/superpowers/specs/2026-07-06-hyperframes-integration-design.md` (Track 3 section)

## Global Constraints

- Branch: `feat/hyperframes-integration`. Commit with `git -c commit.gpgsign=false commit ...`.
- Cache: `sha256(blockHtml, JSON.stringify(params ?? {}), durationMs, fps, width, height)` (16-hex prefix) → `<cacheDir>/<hash>/frame_%04d.png`; a complete cached dir skips the browser entirely (same contract as the shader cache).
- Compositing is **cutaway semantics**: never changes video duration, never shifts placements/chapters/subtitles. `eof_action=pass` + `enable=between` guarantee this.
- Layer order in export.ts: hf-blocks composite **after** camera moves/motion blur, **immediately after** the existing `overlayPngs` step, **before** frame effect and watermark.
- The renderer must not require GSAP or network in unit/integration tests — it interacts with `window.__timelines[<id>]` only through the interface `{ duration(): number; pause(): void; seek(t: number): void }`, so test fixtures register a plain object. (Real blocks load GSAP + Google Fonts from CDNs — network needed at export time for real blocks; documented caveat.)
- Timeline readiness: wait for `document.fonts.ready` AND poll `window.__timelines` until non-empty (10s timeout → error naming the block and the expected convention).
- Duration mapping: linear retime `seek(tVideo × nativeDuration / requestedDuration)`; with `holdLastFrame: true`, `seek(min(tVideo, nativeDuration))` (no retime).
- Known v1 limitation (document, do not solve): `hf-block` windows are computed on the pre-speed-ramp output timeline — combining `hf-block` cues with `export.speedRamp` produces misaligned windows. Same class of limitation as the original speedRamp+transitions conflict.
- All FOUR export paths wired: pipeline primary (`src/pipeline.ts:368` exportOptions / `:452` exportVideo), pipeline variants (`:663`), CLI export (`src/cli.ts:266`), preview export (`src/preview.ts:1095`). Line numbers may drift a few lines — anchor on the code shown in each task.
- Window resolution uses the SAME placements array each site passes to `exportVideo` (post-trim, freeze-adjusted) — pipeline: `finalPlacements`; cli: `placements`; preview: `freezeAdjustedPlacements`.
- Run single test file: `npx vitest run tests/path/to/test.ts`. Full suite: `npm test`.

---

### Task 1: Block frame renderer (`renderBlockFrames` + hash)

**Files:**
- Create: `src/hf/block-render.ts`
- Test: `tests/hf/block-render.test.ts`

**Interfaces:**
- Consumes: playwright `chromium` (same launch flags as `src/transitions/shader-render.ts:86-93`).
- Produces (Tasks 2/5 depend on):
  - `computeBlockHash(blockHtml: string, params: Record<string, string> | undefined, durationMs: number, fps: number, width: number, height: number): string` (16-hex)
  - `interface RenderBlockFramesOptions { blockHtmlPath: string; outputDir: string; durationMs: number; fps: number; width: number; height: number; params?: Record<string, string>; holdLastFrame?: boolean; browser?: Browser }`
  - `renderBlockFrames(opts: RenderBlockFramesOptions): Promise<number>` — returns frame count `N = max(1, round(durationMs × fps / 1000))`, writes `outputDir/frame_0000.png …`.

- [ ] **Step 1: Write the failing test**

Create `tests/hf/block-render.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { computeBlockHash, renderBlockFrames } from '../../src/hf/block-render.js';

// Fixture block: no GSAP, no network. Registers a fake timeline implementing
// the { duration, pause, seek } interface the renderer relies on, and mirrors
// seek progress into the DOM so frames are visually distinguishable.
const FIXTURE_BLOCK = `<!doctype html>
<html><head><style>
  html, body { margin: 0; width: 320px; height: 180px; background: transparent; }
  #bar { position: absolute; top: 80px; left: 0; height: 20px; background: rgb(255, 0, 0); width: 0; }
</style></head>
<body>
  <div id="root" data-composition-id="fixture"><div id="bar"></div></div>
  <script>
    window.__timelines = {
      fixture: {
        _t: 0,
        duration() { return 2; },
        pause() {},
        seek(t) { this._t = t; document.getElementById('bar').style.width = (t / 2) * 320 + 'px'; },
      },
    };
  </script>
</body></html>`;

describe('computeBlockHash', () => {
  it('is stable and sensitive to every component', () => {
    const base = computeBlockHash('<html>', { '--x': '1' }, 1000, 30, 320, 180);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBlockHash('<html>', { '--x': '1' }, 1000, 30, 320, 180)).toBe(base);
    expect(computeBlockHash('<html>!', { '--x': '1' }, 1000, 30, 320, 180)).not.toBe(base);
    expect(computeBlockHash('<html>', { '--x': '2' }, 1000, 30, 320, 180)).not.toBe(base);
    expect(computeBlockHash('<html>', { '--x': '1' }, 1500, 30, 320, 180)).not.toBe(base);
    expect(computeBlockHash('<html>', undefined, 1000, 30, 320, 180)).toBe(
      computeBlockHash('<html>', {}, 1000, 30, 320, 180),
    );
  });
});

describe('renderBlockFrames', () => {
  let browser: Browser;
  let tmp: string;

  beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
  afterAll(async () => { await browser.close(); });
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-blockrender-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('renders N frames by seeking the registered timeline', async () => {
    const blockPath = join(tmp, 'fixture.html');
    writeFileSync(blockPath, FIXTURE_BLOCK);
    const outDir = join(tmp, 'frames');
    const n = await renderBlockFrames({
      blockHtmlPath: blockPath, outputDir: outDir,
      durationMs: 1000, fps: 10, width: 320, height: 180, browser,
    });
    expect(n).toBe(10);
    const frames = readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
    expect(frames).toHaveLength(10);
    expect(frames[0]).toBe('frame_0000.png');
    expect(frames[9]).toBe('frame_0009.png');
    // first and last frame must differ (bar width animates with seek)
    expect(readFileSync(join(outDir, 'frame_0000.png')).equals(readFileSync(join(outDir, 'frame_0009.png')))).toBe(false);
  }, 60_000);

  it('applies params as CSS custom properties on the document root', async () => {
    const blockPath = join(tmp, 'fx.html');
    writeFileSync(blockPath, FIXTURE_BLOCK.replace('rgb(255, 0, 0)', 'var(--bar-color, rgb(255, 0, 0))'));
    const a = join(tmp, 'a');
    const b = join(tmp, 'b');
    await renderBlockFrames({ blockHtmlPath: blockPath, outputDir: a, durationMs: 200, fps: 5, width: 320, height: 180, browser });
    await renderBlockFrames({ blockHtmlPath: blockPath, outputDir: b, durationMs: 200, fps: 5, width: 320, height: 180, params: { '--bar-color': 'rgb(0, 0, 255)' }, browser });
    expect(readFileSync(join(a, 'frame_0000.png')).equals(readFileSync(join(b, 'frame_0000.png')))).toBe(false);
  }, 60_000);

  it('fails with an actionable error when no timeline is registered', async () => {
    const blockPath = join(tmp, 'no-tl.html');
    writeFileSync(blockPath, '<!doctype html><html><body><div>static</div></body></html>');
    await expect(
      renderBlockFrames({ blockHtmlPath: blockPath, outputDir: join(tmp, 'out'), durationMs: 200, fps: 5, width: 320, height: 180, browser }),
    ).rejects.toThrow(/__timelines/);
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/block-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/hf/block-render.ts`:

```typescript
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';

/**
 * Pre-render a hyperframes block's paused GSAP timeline as a PNG sequence.
 * Generalizes the shader-render pattern: headless Chromium, per-frame seek,
 * content-addressed cache managed by the caller (renderHfBlocks in Task 5).
 *
 * The renderer only relies on the hyperframes convention
 * `window.__timelines[<id>] = { duration(), pause(), seek(t) }` — it does
 * not need GSAP itself, so test fixtures can register plain objects.
 */

export function computeBlockHash(
  blockHtml: string,
  params: Record<string, string> | undefined,
  durationMs: number,
  fps: number,
  width: number,
  height: number,
): string {
  const parts = [blockHtml, JSON.stringify(params ?? {}), durationMs, fps, width, height].join('|');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

export interface RenderBlockFramesOptions {
  blockHtmlPath: string;
  outputDir: string;
  /** Window duration in the video (drives frame count and retiming). */
  durationMs: number;
  fps: number;
  /** Block canvas dimensions (native block size; compositing scales later). */
  width: number;
  height: number;
  /** CSS custom property overrides applied on document.documentElement. */
  params?: Record<string, string>;
  /** Pin the final timeline frame instead of linearly retiming. */
  holdLastFrame?: boolean;
  /** Reusable browser — pass one across multiple blocks for performance. */
  browser?: Browser;
}

export async function renderBlockFrames(opts: RenderBlockFramesOptions): Promise<number> {
  mkdirSync(opts.outputDir, { recursive: true });
  const N = Math.max(1, Math.round((opts.durationMs * opts.fps) / 1000));

  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? await chromium.launch({
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blacklist',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height } });
    try {
      await page.goto(pathToFileURL(resolve(opts.blockHtmlPath)).href, { waitUntil: 'load' });

      if (opts.params) {
        await page.evaluate((params) => {
          for (const [k, v] of Object.entries(params)) {
            document.documentElement.style.setProperty(k, v);
          }
        }, opts.params);
      }

      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      // Wait for the hyperframes timeline registration convention.
      try {
        await page.waitForFunction(
          () => {
            const tls = (window as unknown as { __timelines?: Record<string, unknown> }).__timelines;
            return !!tls && Object.keys(tls).length > 0;
          },
          undefined,
          { timeout: 10_000 },
        );
      } catch {
        throw new Error(
          `Block "${opts.blockHtmlPath}" never registered a timeline on window.__timelines ` +
            `(hyperframes blocks register a paused GSAP timeline keyed by composition id).`,
        );
      }

      const nativeDurationSec = await page.evaluate(() => {
        const tls = (window as unknown as {
          __timelines: Record<string, { duration(): number; pause(): void }>;
        }).__timelines;
        const tl = tls[Object.keys(tls)[0]];
        tl.pause();
        return tl.duration();
      });

      const requestedSec = opts.durationMs / 1000;
      for (let i = 0; i < N; i++) {
        const tVideo = N === 1 ? 0 : (i / (N - 1)) * requestedSec;
        const tBlock = opts.holdLastFrame
          ? Math.min(tVideo, nativeDurationSec)
          : (tVideo * nativeDurationSec) / requestedSec;
        await page.evaluate((t) => {
          const tls = (window as unknown as {
            __timelines: Record<string, { seek(t: number): void }>;
          }).__timelines;
          tls[Object.keys(tls)[0]].seek(t);
        }, tBlock);
        await page.screenshot({
          path: join(opts.outputDir, `frame_${String(i).padStart(4, '0')}.png`),
          omitBackground: true,
        });
      }
    } finally {
      await page.close();
    }
  } finally {
    if (ownsBrowser) await browser.close();
  }

  return N;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hf/block-render.test.ts`
Expected: PASS (4 tests; launches chromium, ~10-25s)

- [ ] **Step 5: Commit**

```bash
git add src/hf/block-render.ts tests/hf/block-render.test.ts
git -c commit.gpgsign=false commit -m "feat(hf): block frame renderer seeking window.__timelines"
```

---

### Task 2: ffmpeg composite filter builder

**Files:**
- Create: `src/hf/block-filter.ts`
- Test: `tests/hf/block-filter.test.ts`

**Interfaces:**
- Consumes: nothing (pure string builder). Mirrors `buildOverlayPngFilters` in `src/overlays/render-to-png.ts:…` — Read that function first and keep the same return contract `{ inputArgs, filterParts, videoSource, nextInput }`.
- Produces (Tasks 3/5 depend on):
  - `interface RenderedHfBlock { name: string; pngDir: string; frameCount: number; fps: number; startMs: number; endMs: number; width: number; height: number; fit: 'cover' | { x: number; y: number; scale: number } }`
  - `buildHfBlockFilters(blocks: RenderedHfBlock[], baseInputCount: number, videoSourceLabel: string, videoW: number, videoH: number): { inputArgs: string[]; filterParts: string[]; videoSource: string; nextInput: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/hf/block-filter.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/block-filter.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

Create `src/hf/block-filter.ts`:

```typescript
import { join } from 'node:path';

/**
 * Build ffmpeg inputs + filter_complex parts that composite pre-rendered
 * hyperframes block PNG sequences onto the video. Mirrors
 * buildOverlayPngFilters (src/overlays/render-to-png.ts) but for image2
 * sequences: the sequence starts at t=0, so setpts shifts it to the cue's
 * window before the enable-gated overlay. eof_action=pass keeps cutaway
 * semantics — output duration never changes.
 */

export interface RenderedHfBlock {
  name: string;
  pngDir: string;
  frameCount: number;
  fps: number;
  startMs: number;
  endMs: number;
  /** Native block canvas size (the PNG dimensions). */
  width: number;
  height: number;
  fit: 'cover' | { x: number; y: number; scale: number };
}

export function buildHfBlockFilters(
  blocks: RenderedHfBlock[],
  baseInputCount: number,
  videoSourceLabel: string,
  videoW: number,
  videoH: number,
): { inputArgs: string[]; filterParts: string[]; videoSource: string; nextInput: number } {
  if (blocks.length === 0) {
    return { inputArgs: [], filterParts: [], videoSource: videoSourceLabel, nextInput: baseInputCount };
  }

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  let currentVideo = videoSourceLabel;
  let nextInput = baseInputCount;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const inputIdx = nextInput++;
    inputArgs.push('-framerate', String(b.fps), '-start_number', '0', '-i', join(b.pngDir, 'frame_%04d.png'));

    const startSec = (b.startMs / 1000).toFixed(3);
    const endSec = (b.endMs / 1000).toFixed(3);

    let scaleExpr: string;
    let x: number;
    let y: number;
    if (b.fit === 'cover') {
      scaleExpr = `scale=${videoW}:${videoH}`;
      x = 0;
      y = 0;
    } else {
      scaleExpr = `scale=${Math.round(b.width * b.fit.scale)}:${Math.round(b.height * b.fit.scale)}`;
      x = b.fit.x;
      y = b.fit.y;
    }

    const prepLabel = `hfblk${i}`;
    const outLabel = `hfb${i}`;
    filterParts.push(`[${inputIdx}:v]format=rgba,${scaleExpr},setpts=PTS+${startSec}/TB[${prepLabel}]`);
    filterParts.push(
      `[${currentVideo}][${prepLabel}]overlay=${x}:${y}:enable='between(t\\,${startSec}\\,${endSec})':format=auto:eof_action=pass[${outLabel}]`,
    );
    currentVideo = outLabel;
  }

  return { inputArgs, filterParts, videoSource: currentVideo, nextInput };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hf/block-filter.test.ts` — Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hf/block-filter.ts tests/hf/block-filter.test.ts
git -c commit.gpgsign=false commit -m "feat(hf): ffmpeg composite filter builder for block PNG sequences"
```

---

### Task 3: Export integration (`ExportOptions.hfBlocks`)

**Files:**
- Modify: `src/export.ts` (options interface at :17; composite step right after the `overlayPngs` block at ~:466; every other place `overlayPngs` is referenced)
- Test: `tests/hf/export-hf-blocks.test.ts`

**Interfaces:**
- Consumes: `RenderedHfBlock`, `buildHfBlockFilters` (Task 2).
- Produces: `ExportOptions.hfBlocks?: RenderedHfBlock[]` — Task 5's four wiring sites pass it.

- [ ] **Step 1: Map every `overlayPngs` touchpoint**

Run: `grep -n "overlayPngs" src/export.ts` — for EACH hit, decide whether `hfBlocks` needs the same treatment and note it in your report:
- the `ExportOptions` field (~:68) → add `hfBlocks?: RenderedHfBlock[]` with JSDoc `/** Pre-rendered hyperframes block PNG sequences composited as cutaway overlays. */`
- the filter-complex gate (~:419, an `||` chain deciding whether a `filter_complex` is required) → add `(options.hfBlocks && options.hfBlocks.length > 0) ||`
- the composite step (~:466-473) → add the equivalent block IMMEDIATELY AFTER it:

```typescript
  const hfBlocks = options.hfBlocks;
  if (hfBlocks && hfBlocks.length > 0) {
    const hfResult = buildHfBlockFilters(hfBlocks, nextInput, videoSource, outputWidth ?? 1920, outputHeight ?? 1080);
    args.push(...hfResult.inputArgs);
    filterParts.push(...hfResult.filterParts);
    videoSource = hfResult.videoSource;
    nextInput = hfResult.nextInput;
  }
```

(Match the surrounding code's actual local variable names — `nextInput`, `videoSource`, `filterParts`, `args`, `outputWidth`/`outputHeight` are the names visible at the `overlayPngs` step; verify from context when editing.)
- the `hasOverlayPngs` reference (~:763) — Read that region: if it gates `-shortest` or map decisions for overlay PNG inputs, mirror the same gate for hf-block sequence inputs (`hasHfBlocks`). Image2 sequences are finite so they cannot hang the encode, but `-shortest` semantics must not truncate: mirror exactly what overlayPngs does and record your finding in the report.

Add the import: `import { buildHfBlockFilters, type RenderedHfBlock } from './hf/block-filter.js';`

- [ ] **Step 2: Write the failing test**

Create `tests/hf/export-hf-blocks.test.ts` — a compile-time + wiring test (running full ffmpeg here would be slow; Task 5 has the e2e):

```typescript
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
```

(If `ExportOptions` is not currently exported from `src/export.ts`, export it — check first; the interface is declared with `export` at :17.)

- [ ] **Step 3: Run tests, then build**

Run: `npx vitest run tests/hf/export-hf-blocks.test.ts && npm run build`
Expected: PASS + build exit 0.

- [ ] **Step 4: Run the export-related test files to catch regressions**

Run: `npx vitest run tests/export-frame.test.ts tests/freeze.test.ts tests/motion-blur.test.ts`
Expected: PASS (these exercise export filter assembly).

- [ ] **Step 5: Commit**

```bash
git add src/export.ts tests/hf/export-hf-blocks.test.ts
git -c commit.gpgsign=false commit -m "feat(export): composite pre-rendered hf-block sequences as cutaway overlays"
```

---

### Task 4: `hf-block` cue + validate + recording no-op

**Files:**
- Modify: `src/overlays/types.ts` (add `HfBlockCue`, extend union)
- Modify: `src/overlays/index.ts` (early branch in `showOverlay` and `withOverlay`)
- Modify: `src/overlays/templates.ts` (`renderTemplate` throw case)
- Modify: `src/validate.ts` (validTypes + install check — extend the existing `hf-component` branch to cover both)
- Test: `tests/hf/hf-block-cue.test.ts`

**Interfaces:**
- Consumes: patterns from Track 2's `hf-component` cue (same files, adjacent code).
- Produces: `HfBlockCue { type: 'hf-block'; name: string; params?: Record<string, string>; durationMs?: number; fit?: 'cover' | { x: number; y: number; scale: number }; holdLastFrame?: boolean; placement?: Zone; motion?: MotionPreset; autoBackground?: boolean }` in the `OverlayCue` union (the last three optional/ignored, mirroring `HfComponentCue` — Read that interface and match its optional-field pattern exactly). Task 5's cue resolver consumes this shape.

**Recording semantics:** hf-block is an EXPORT-time effect. During recording, `showOverlay` must do nothing visual but still wait `durationMs` (demo scripts use showOverlay's wait for scene pacing); `withOverlay` just runs its action.

- [ ] **Step 1: Write the failing test**

Create `tests/hf/hf-block-cue.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import type { OverlayCue } from '../../src/overlays/types.js';
import { showOverlay } from '../../src/overlays/index.js';
import { renderTemplate } from '../../src/overlays/templates.js';

describe('HfBlockCue', () => {
  it('is part of the OverlayCue union at compile time', () => {
    const cue: OverlayCue = {
      type: 'hf-block', name: 'logo-outro', fit: 'cover', holdLastFrame: true, durationMs: 2500,
    };
    expect(cue.type).toBe('hf-block');
  });

  it('renderTemplate rejects hf-block cues with a pointer to export-time compositing', () => {
    expect(() => renderTemplate({ type: 'hf-block', name: 'logo-outro' })).toThrow(/export/i);
  });

  it('showOverlay is a pacing no-op during recording (waits, no page mutation)', async () => {
    const calls: string[] = [];
    const fakePage = {
      evaluate: async () => { calls.push('evaluate'); },
      waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    };
    await showOverlay(fakePage as never, 'outro', { type: 'hf-block', name: 'logo-outro' }, 900);
    expect(calls).toEqual(['wait:900']);
  });
});
```

- [ ] **Step 2: Run to verify failures** — TS/type failures + dispatch missing.

- [ ] **Step 3: Implement**

**3a.** `src/overlays/types.ts` — add `HfBlockCue` (fields per Interfaces above; copy the optional ignored-field JSDoc style from `HfComponentCue` directly above it) and add `| HfBlockCue` to the union.

**3b.** `src/overlays/index.ts` — in `showOverlay`, immediately after the existing `hf-component` early branch:

```typescript
  if (cue.type === 'hf-block') {
    // Export-time cutaway — nothing is injected during recording, but the
    // wait preserves the demo script's scene pacing.
    await page.waitForTimeout(durationMs);
    return;
  }
```

In `withOverlay`, after its `hf-component` branch (match the actual action parameter name):

```typescript
  if (cue.type === 'hf-block') {
    return await action();
  }
```

**3c.** `src/overlays/templates.ts` — add before the switch's closing brace:

```typescript
    case 'hf-block':
      throw new Error(
        'hf-block cues are composited at export time (pre-rendered PNG sequences), not rendered as zone templates.',
      );
```

**3d.** `src/validate.ts` — extend the existing hf-component validation: the same name-regex + install-file check applies to `hf-block` (blocks install to the same `blocksDir/<name>/<name>.html` layout). Refactor minimally: change the condition to `if (ov.type === 'hf-component' || ov.type === 'hf-block')` and use `ov.type` in the error strings so messages stay accurate. Add `'hf-block'` to `validTypes`. Additionally validate that `fit`, when present and not `'cover'`, has numeric `x`, `y`, `scale` fields (push an error naming the scene otherwise).

- [ ] **Step 4: Extend validate tests**

Add to `tests/hf/validate-hf.test.ts` (mirror its existing fixture helpers):

```typescript
  it('accepts an installed hf-block and errors on a missing one', async () => {
    writeManifest({ type: 'hf-block', name: 'vignette' }); // fixture dir reused — any installed name works
    const ok = await validateDemo({ demoName: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks') });
    expect(ok.errors.filter((e) => e.includes('hf-block'))).toEqual([]);
    writeManifest({ type: 'hf-block', name: 'logo-outro' });
    const missing = await validateDemo({ demoName: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks') });
    expect(missing.errors.some((e) => /logo-outro.*argo add/.test(e))).toBe(true);
  });

  it('errors on a malformed hf-block fit', async () => {
    writeManifest({ type: 'hf-block', name: 'vignette', fit: { x: 1 } });
    const result = await validateDemo({ demoName: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks') });
    expect(result.errors.some((e) => /fit/.test(e))).toBe(true);
  });
```

(IMPORTANT: first Read `tests/hf/validate-hf.test.ts` to reuse its actual helper names and option keys — the sketch above assumes `writeManifest`/`demoName`; adjust to what Track 2 actually shipped.)

- [ ] **Step 5: Run tests + build**

Run: `npx vitest run tests/hf/ && npx vitest run tests/overlays/ && npm run build`
Expected: all PASS, build exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/overlays/ src/validate.ts tests/hf/
git -c commit.gpgsign=false commit -m "feat(overlays): hf-block cue (export-time cutaway) + validate checks"
```

---

### Task 5: Cue resolution + render orchestrator + four-path wiring

**Files:**
- Modify: `src/hf/block-render.ts` (add `resolveHfBlockCues` + `renderHfBlocks`)
- Modify: `src/pipeline.ts` (primary: collect cues after the manifest parse at ~:286-297, render pre-pass near the shader pre-pass at ~:434, add `hfBlocks` to `exportOptions` at ~:368-452; variants: same around ~:643-663)
- Modify: `src/cli.ts` (export command around :248-266)
- Modify: `src/preview.ts` (export path around :1077-1095)
- Test: `tests/hf/render-hf-blocks.test.ts`

**Interfaces:**
- Consumes: `renderBlockFrames`, `computeBlockHash` (Task 1), `RenderedHfBlock` (Task 2), `HfBlockCue` (Task 4), `Placement { scene; startMs; endMs }` from `src/tts/align.ts`.
- Produces:
  - `interface HfBlockCueResolved { name: string; params?: Record<string, string>; fit: 'cover' | { x: number; y: number; scale: number }; holdLastFrame: boolean; startMs: number; endMs: number }`
  - `resolveHfBlockCues(rawManifest: unknown[], placements: Placement[]): HfBlockCueResolved[]` — for each manifest entry whose `overlay?.type === 'hf-block'` and whose `scene` has a placement: `startMs = placement.startMs`, `endMs = min(placement.startMs + (cue.durationMs ?? (placement.endMs - placement.startMs)), placement.endMs)` … except when `cue.durationMs` exceeds the placement window, allow it to extend to the next placement's startMs (or Infinity for the last scene — the enable window is naturally clipped by video length). Defaults: `fit: 'cover'`, `holdLastFrame: false`. Scenes without placements are skipped with a `console.warn`.
  - `renderHfBlocks(opts: { cues: HfBlockCueResolved[]; blocksDir: string; cacheDir: string; fps: number }): Promise<RenderedHfBlock[]>` — per cue: read `blocksDir/<name>/<name>.html` (throw with `argo add <name>` hint if missing); read native dimensions from `blocksDir/<name>/registry-item.json` (`dimensions.width/height`, fallback 1920×1080); `computeBlockHash` → if `<cacheDir>/<hash>/` already contains the expected `frame_{N-1}.png`, skip rendering (cache hit); else `renderBlockFrames` into it. One shared `chromium.launch(...)` across all cues (launched lazily on first cache miss, closed in `finally`). Returns `RenderedHfBlock[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/hf/render-hf-blocks.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run to verify failure** — functions not exported.

- [ ] **Step 3: Implement `resolveHfBlockCues` + `renderHfBlocks`** in `src/hf/block-render.ts` per the Interfaces contract. For the cache-hit check: `existsSync(join(dir, `frame_${String(N - 1).padStart(4, '0')}.png`))` where N is the expected frame count. Import `Placement` type via `import type { Placement } from '../tts/align.js';`. Manifest entries are `unknown` — narrow with the same defensive property checks validate.ts uses (Read its hf-component branch for the idiom).

- [ ] **Step 4: Run the focused test** — `npx vitest run tests/hf/render-hf-blocks.test.ts` — PASS.

- [ ] **Step 5: Wire the four export paths**

At each site, the pattern is: (a) resolve cues from the manifest + the placements array that site passes to `exportVideo`, (b) if non-empty, run `renderHfBlocks` (cacheDir = sibling of the shader cache: pipeline primary `join(argoDir, 'hf-blocks')`, variants `join('.argo', variantSubdir, 'hf-blocks')`, cli `` `.argo/${demo}/hf-blocks` ``, preview `join(demoDir, 'hf-blocks')`), (c) pass the result as `hfBlocks` in the exportVideo options.

- `src/pipeline.ts` primary: the manifest is already parsed as `rawManifest` (~:290). After `finalPlacements` exists and near the shader pre-pass (~:430), add:

```typescript
  // hf-block cutaways — pre-render installed hyperframes blocks (cache-hit cheap)
  const hfBlockCues = resolveHfBlockCues(rawManifest, finalPlacements);
  if (hfBlockCues.length > 0) {
    exportOptions.hfBlocks = await renderHfBlocks({
      cues: hfBlockCues,
      blocksDir: config.blocksDir,
      cacheDir: join(argoDir, 'hf-blocks'),
      fps: config.video?.fps ?? 30,
    });
  }
```

(Place AFTER `exportOptions` is constructed at ~:368 and BEFORE `exportVideo(exportOptions)` at ~:452. If `rawManifest`'s type annotation lacks `overlay`, widen its inline type with `overlay?: { type?: string; [k: string]: unknown }`.)

- `src/pipeline.ts` variants (~:643-663), `src/cli.ts` export (~:248-266), `src/preview.ts` export (~:1077-1095): same pattern with each site's own manifest source, placements array, and cacheDir. Each site already reads the manifest or has a path to it (`config.demosDir`/`demoName`) — Read each site's surrounding code and reuse whatever manifest variable exists, or parse the manifest file the same way pipeline does. In preview, `config.blocksDir` may not be in scope — Read how preview accesses config (it holds an `ec` export-config object and a config module) and thread `blocksDir` the same way `shaderTransition` reached that code.

- [ ] **Step 6: Full verification**

Run: `npm run build && npm test`
Expected: build exit 0; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/hf/block-render.ts src/pipeline.ts src/cli.ts src/preview.ts tests/hf/render-hf-blocks.test.ts
git -c commit.gpgsign=false commit -m "feat(pipeline): resolve + pre-render hf-block cues across all export paths"
```

---

### Task 6: Docs sync

**Files:**
- Modify: `README.md` (hf-block cue docs in the catalog section Task 8 of Track 2 created; cue example with `durationMs`/`fit`/`holdLastFrame`; note the cutaway semantics + network caveat)
- Modify: `CLAUDE.md` (HyperFrames Catalog section gains the block pre-render paragraph: cache location, `window.__timelines` convention, cutaway semantics, speedRamp limitation; Known Issues gains the speedRamp+hf-block limitation)
- Modify: `skills/argo-guide/` (overlay-type enumerations gain `hf-block`; grep as in prior doc tasks)

- [ ] **Step 1: Update the three surfaces.** Facts to document (verify each against code): cue shape `{ type: 'hf-block', name, params?, durationMs?, fit?: 'cover' | {x,y,scale}, holdLastFrame? }`; recording-time no-op (pacing wait only); export-time pre-render with cache at `.argo/<demo>/hf-blocks/<hash>/`; compositing after camera moves, before frame/watermark; window = scene placement (durationMs caps/extends per resolver rules); blocks need network at export time (GSAP + fonts CDNs); speedRamp incompatibility.

- [ ] **Step 2: Full verification.** Run: `npm run build && npm test` — green. Then the real-block smoke (network + ~60s; report DONE_WITH_CONCERNS naming this step if offline):

```bash
cd "$(mktemp -d)" && node /Users/shreyas/work/rnd/argo/bin/argo.js add logo-outro && node -e "
const { renderHfBlocks } = require('/Users/shreyas/work/rnd/argo/dist/hf/block-render.js');
renderHfBlocks({ cues: [{ name: 'logo-outro', fit: 'cover', holdLastFrame: false, startMs: 0, endMs: 2000 }], blocksDir: 'blocks', cacheDir: '.argo/smoke/hf-blocks', fps: 30 })
  .then(r => console.log('SMOKE-OK', r[0].frameCount, 'frames'));
"
```

(If `dist` is ESM so `require` fails, use `node --input-type=module -e` with a dynamic `import()` — adapt as needed; the goal is: real registry block installs, pre-renders 60 frames, prints SMOKE-OK.)

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md skills/
git -c commit.gpgsign=false commit -m "docs: hf-block cutaway cue, pre-render cache, speedRamp caveat"
```

---

## Self-Review Notes

- **Spec coverage:** cue shape incl. `fit` default `'cover'` (T4/T5), chromium pre-pass with fonts + `__timelines` wait + `omitBackground` alpha (T1), linear retime + opt-in `holdLastFrame` (T1), content-addressed cache with browser-skip on hit (T5), `overlay` + `enable=between` compositing after transitions/camera moves before frame/watermark (T2/T3), no timeline surgery (constraint + `eof_action=pass`), all four export paths (T5), actionable missing-timeline error (T1, spec's named risk).
- **Deviation from spec, justified:** spec's cue sketch omitted `durationMs`; recording-time overlay duration comes from script calls which don't exist at export, so the manifest cue carries it (defaulting to the placement window). Recorded here so the final review sees it as intentional.
- **Type consistency:** `RenderedHfBlock` fields match between T2 (definition), T3 (export), T5 (producer + test assertions); `HfBlockCueResolved` matches T5's resolver test; `frame_%04d.png` naming matches T1's writer, T2's input args, and T5's cache-hit probe.
- **Placeholder scan:** Read-then-mirror steps name their exact target (overlayPngs touchpoints, validate idiom, preview config threading, withOverlay param name) — bounded lookups.
