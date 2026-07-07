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
