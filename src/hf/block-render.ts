import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import type { Placement } from '../tts/align.js';
import type { RenderedHfBlock } from './block-filter.js';

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
        // Edge-inclusive sampling (matches shader-render.ts): the last frame
        // lands exactly at the requested window end so the block's final
        // composed state is captured. N === 1 degenerates to t=0 (usually the
        // pre-animation state), so a single frame samples the window midpoint.
        const tVideo = N === 1 ? requestedSec / 2 : (i / (N - 1)) * requestedSec;
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

/**
 * A resolved `hf-block` overlay cue: manifest `overlay.type === 'hf-block'`
 * data merged with the placement window (scene timing) it plays over.
 */
export interface HfBlockCueResolved {
  name: string;
  params?: Record<string, string>;
  fit: 'cover' | { x: number; y: number; scale: number };
  holdLastFrame: boolean;
  startMs: number;
  endMs: number;
}

/**
 * Extract `hf-block` overlay cues from a raw (untyped) scenes manifest and
 * anchor each to its scene's placement window on the final export timeline.
 *
 * `endMs` is `placement.startMs + (cue.durationMs ?? windowMs)`, clamped to
 * the placement's own `endMs` — unless the requested duration overshoots the
 * window, in which case the cue is allowed to run into the gap after the
 * scene (capped at the next placement's `startMs`, or left uncapped for the
 * last scene — ffmpeg's `between()` enable window is naturally clipped by
 * the video's total duration).
 *
 * Scenes without a matching placement (e.g. a scene name typo, or a scene
 * that produced no timeline placement) are skipped with a warning rather
 * than throwing — hf-block cutaways are best-effort like overlays/subtitles.
 */
export function resolveHfBlockCues(rawManifest: unknown[], placements: Placement[]): HfBlockCueResolved[] {
  const placementByScene = new Map<string, Placement>();
  for (const p of placements) placementByScene.set(p.scene, p);
  const sortedPlacements = [...placements].sort((a, b) => a.startMs - b.startMs);

  const cues: HfBlockCueResolved[] = [];
  for (const entry of rawManifest) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { scene?: unknown; overlay?: unknown };
    if (typeof e.scene !== 'string') continue;

    const overlay = e.overlay;
    if (!overlay || typeof overlay !== 'object') continue;
    const ov = overlay as {
      type?: unknown;
      name?: unknown;
      durationMs?: unknown;
      params?: unknown;
      fit?: unknown;
      holdLastFrame?: unknown;
    };
    if (ov.type !== 'hf-block' || typeof ov.name !== 'string') continue;

    const placement = placementByScene.get(e.scene);
    if (!placement) {
      console.warn(`hf-block cue for scene "${e.scene}" has no placement on the timeline — skipping.`);
      continue;
    }

    const windowMs = placement.endMs - placement.startMs;
    const requestedMs = typeof ov.durationMs === 'number' ? ov.durationMs : windowMs;
    const naiveEnd = placement.startMs + requestedMs;

    let endMs: number;
    if (naiveEnd > placement.endMs) {
      const idx = sortedPlacements.findIndex((p) => p === placement);
      const next = idx >= 0 ? sortedPlacements[idx + 1] : undefined;
      endMs = next ? Math.min(naiveEnd, next.startMs) : naiveEnd;
    } else {
      endMs = naiveEnd;
    }

    const params = ov.params && typeof ov.params === 'object'
      ? (ov.params as Record<string, string>)
      : undefined;
    const fit: HfBlockCueResolved['fit'] = ov.fit && ov.fit !== 'cover'
      ? (ov.fit as { x: number; y: number; scale: number })
      : 'cover';
    const holdLastFrame = typeof ov.holdLastFrame === 'boolean' ? ov.holdLastFrame : false;

    cues.push({ name: ov.name, params, fit, holdLastFrame, startMs: placement.startMs, endMs });
  }

  return cues;
}

export interface RenderHfBlocksOptions {
  cues: HfBlockCueResolved[];
  blocksDir: string;
  cacheDir: string;
  fps: number;
}

interface RegistryItemMeta {
  dimensions?: { width?: number; height?: number };
}

/**
 * Render (or reuse from cache) the PNG sequence for each resolved hf-block
 * cue. One `chromium` instance is shared across cache misses (launched
 * lazily, closed in `finally`) — mirrors the shader-render pre-pass pattern.
 */
export async function renderHfBlocks(opts: RenderHfBlocksOptions): Promise<RenderedHfBlock[]> {
  const results: RenderedHfBlock[] = [];
  let browser: Browser | undefined;

  try {
    for (const cue of opts.cues) {
      const blockDir = join(opts.blocksDir, cue.name);
      const blockHtmlPath = join(blockDir, `${cue.name}.html`);
      if (!existsSync(blockHtmlPath)) {
        throw new Error(
          `hf-block "${cue.name}" is not installed (missing ${blockHtmlPath}). Run: argo add ${cue.name}`,
        );
      }

      let width = 1920;
      let height = 1080;
      try {
        const registry = JSON.parse(
          readFileSync(join(blockDir, 'registry-item.json'), 'utf-8'),
        ) as RegistryItemMeta;
        if (typeof registry.dimensions?.width === 'number') width = registry.dimensions.width;
        if (typeof registry.dimensions?.height === 'number') height = registry.dimensions.height;
      } catch {
        // Missing/malformed registry-item.json — fall back to 1920x1080.
      }

      const durationMs = cue.endMs - cue.startMs;
      const frameCount = Math.max(1, Math.round((durationMs * opts.fps) / 1000));
      const blockHtml = readFileSync(blockHtmlPath, 'utf-8');
      const hash = computeBlockHash(blockHtml, cue.params, durationMs, opts.fps, width, height);
      const pngDir = join(opts.cacheDir, hash);
      const expectedLastFrame = join(pngDir, `frame_${String(frameCount - 1).padStart(4, '0')}.png`);

      if (!existsSync(expectedLastFrame)) {
        if (!browser) {
          browser = await chromium.launch({
            args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blacklist'],
          });
        }
        await renderBlockFrames({
          blockHtmlPath,
          outputDir: pngDir,
          durationMs,
          fps: opts.fps,
          width,
          height,
          params: cue.params,
          holdLastFrame: cue.holdLastFrame,
          browser,
        });
      }

      results.push({
        name: cue.name,
        pngDir,
        frameCount,
        fps: opts.fps,
        startMs: cue.startMs,
        endMs: cue.endMs,
        width,
        height,
        fit: cue.fit,
      });
    }
  } finally {
    if (browser) await browser.close();
  }

  return results;
}
