import { readFileSync, mkdirSync, writeFileSync, existsSync as existsSyncFs, readdirSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium, type Browser } from '@playwright/test';
import { buildShaderPageHtml } from './shader-page.html.js';
import { getVideoDurationMs } from '../media.js';
import { SHADERS, type ShaderName } from './shaders/index.js';
import { deriveAccentColors, DEFAULT_ACCENT } from './accent.js';

const execFileP = promisify(execFile);

/**
 * Content hash keying the shader render cache. Includes every input that can
 * affect output: shader source, timing parameters, resolution, the content
 * of the two boundary frames, and the accent color.
 */
export function computeShaderHash(
  shader: string,
  durationMs: number,
  fps: number,
  width: number,
  height: number,
  aPngPath: string,
  bPngPath: string,
  accentHex: string = DEFAULT_ACCENT,
): string {
  const aHash = createHash('sha256').update(readFileSync(aPngPath)).digest('hex');
  const bHash = createHash('sha256').update(readFileSync(bPngPath)).digest('hex');
  const parts = [shader, durationMs, fps, width, height, aHash, bHash, accentHex.trim().toLowerCase()].join('|');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}

/**
 * Extract a single frame from a video at the given timestamp (seconds) using
 * ffmpeg. The output is a PNG at the source video's native resolution.
 *
 * Uses `-ss BEFORE -i` for seek acceptable for boundary-frame grabs
 * (one-frame precision not required — gl-transitions uses frozen frames).
 */
export async function extractBoundaryFrame(
  videoPath: string,
  timestampSec: number,
  outputPngPath: string,
): Promise<void> {
  const args = [
    '-ss', timestampSec.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '1',
    '-y',
    outputPngPath,
  ];
  try {
    await execFileP('ffmpeg', args);
  } catch (err) {
    throw new Error(
      `Failed to extract boundary frame at ${timestampSec}s from ${videoPath}: ${(err as Error).message}`,
    );
  }
}

export interface RenderShaderFramesOptions {
  shader: ShaderName;
  aPng: string;
  bPng: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  outputDir: string;
  /** Reusable browser — pass one across multiple boundaries for performance. */
  browser?: Browser;
  /** Accent hex for shaders using accent uniforms. Default DEFAULT_ACCENT. */
  accent?: string;
}

/**
 * Render a GLSL shader transition as a PNG sequence.
 * Produces `outputDir/frame_0000.png` ... `frame_{N-1}.png` where
 * N = Math.round(durationMs * fps / 1000).
 *
 * Launches Playwright Chromium if a browser is not passed in. Callers with
 * multiple boundaries should share a single browser across calls.
 */
export async function renderShaderFrames(opts: RenderShaderFramesOptions): Promise<number> {
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
      const html = buildShaderPageHtml(
        opts.width,
        opts.height,
        SHADERS[opts.shader],
        deriveAccentColors(opts.accent),
      );
      await page.setContent(html, { waitUntil: 'load' });

      const glError = await page.evaluate(() => (window as any).__glError as string | undefined);
      if (glError) throw new Error(`WebGL init error (${opts.shader}): ${glError}`);

      const aBuf = readFileSync(opts.aPng);
      const bBuf = readFileSync(opts.bPng);
      const aDataUri = 'data:image/png;base64,' + aBuf.toString('base64');
      const bDataUri = 'data:image/png;base64,' + bBuf.toString('base64');
      await page.evaluate(
        ([a, b]) => (window as any).__loadFrames(a, b),
        [aDataUri, bDataUri] as const,
      );

      for (let i = 0; i < N; i++) {
        const progress = N === 1 ? 0 : i / (N - 1);
        const dataUri = await page.evaluate(
          (p) => (window as any).__renderAt(p) as Promise<string>,
          progress,
        );
        const base64 = dataUri.split(',', 2)[1];
        const outPath = pathJoin(opts.outputDir, `frame_${String(i).padStart(4, '0')}.png`);
        writeFileSync(outPath, Buffer.from(base64, 'base64'));
      }
    } finally {
      await page.close();
    }
  } finally {
    if (ownsBrowser) await browser.close();
  }

  return N;
}

export interface BoundarySpec {
  boundarySec: number;
  durationMs: number;
}

export interface ShaderTransitionRenderResult {
  boundarySec: number;
  durationMs: number;
  pngDir: string;
  frameCount: number;
  hash: string;
}

/**
 * For each scene boundary, extract two boundary frames, compute a content
 * hash, and render the shader's PNG sequence if not already cached.
 * Reuses a single Playwright browser across all boundaries.
 */
export async function renderShaderTransitions(opts: {
  videoPath: string;
  boundaries: BoundarySpec[];
  shader: ShaderName;
  width: number;
  height: number;
  fps: number;
  cacheDir: string;
  /** Accent hex for shaders using accent uniforms. Default DEFAULT_ACCENT. */
  accent?: string;
}): Promise<ShaderTransitionRenderResult[]> {
  if (opts.boundaries.length === 0) return [];

  mkdirSync(opts.cacheDir, { recursive: true });

  // Extract all boundary frames up front (cheap, sequential ffmpeg calls)
  const tmpFramesDir = pathJoin(opts.cacheDir, '_boundaries');
  mkdirSync(tmpFramesDir, { recursive: true });
  const extracted: Array<{ aPath: string; bPath: string; spec: BoundarySpec }> = [];
  const epsilon = 1 / opts.fps / 2;
  // Marks are wall-clock but the assembled video can run shorter (dropped
  // frames under jpeg-stitch), so a late boundary may land past the video's
  // end — clamp extraction inside the video or ffmpeg emits no frame (ENOENT).
  const videoDurationSec = getVideoDurationMs(opts.videoPath) / 1000;
  const maxBoundarySec = Math.max(0, videoDurationSec - 2 / opts.fps);
  for (let i = 0; i < opts.boundaries.length; i++) {
    const b = opts.boundaries[i];
    let boundarySec = b.boundarySec;
    if (boundarySec > maxBoundarySec) {
      console.warn(
        `Shader boundary ${i} at ${boundarySec.toFixed(2)}s is past the video end ` +
          `(${videoDurationSec.toFixed(2)}s) — clamping.`,
      );
      boundarySec = maxBoundarySec;
    }
    const aPath = pathJoin(tmpFramesDir, `b${i}_a.png`);
    const bPath = pathJoin(tmpFramesDir, `b${i}_b.png`);
    await extractBoundaryFrame(opts.videoPath, Math.max(0, boundarySec - epsilon), aPath);
    await extractBoundaryFrame(opts.videoPath, Math.min(boundarySec + epsilon, maxBoundarySec), bPath);
    extracted.push({ aPath, bPath, spec: b });
  }

  // Determine cache hits / misses
  const plan = extracted.map(({ aPath, bPath, spec }) => {
    const hash = computeShaderHash(opts.shader, spec.durationMs, opts.fps, opts.width, opts.height, aPath, bPath, opts.accent ?? DEFAULT_ACCENT);
    const pngDir = pathJoin(opts.cacheDir, hash);
    const N = Math.max(1, Math.round((spec.durationMs * opts.fps) / 1000));
    const cached = existsSyncFs(pngDir) && readdirSync(pngDir).filter(f => f.endsWith('.png')).length === N;
    return { aPath, bPath, spec, hash, pngDir, N, cached };
  });

  const anyMisses = plan.some(p => !p.cached);
  let browser: Browser | undefined;
  try {
    if (anyMisses) {
      browser = await chromium.launch({
        args: [
          '--use-gl=angle',
          '--use-angle=swiftshader',
          '--enable-webgl',
          '--ignore-gpu-blacklist',
        ],
      });
    }

    const results: ShaderTransitionRenderResult[] = [];
    for (const p of plan) {
      if (!p.cached) {
        await renderShaderFrames({
          shader: opts.shader,
          aPng: p.aPath,
          bPng: p.bPath,
          width: opts.width,
          height: opts.height,
          fps: opts.fps,
          durationMs: p.spec.durationMs,
          outputDir: p.pngDir,
          browser,
          accent: opts.accent,
        });
      }
      results.push({
        boundarySec: p.spec.boundarySec,
        durationMs: p.spec.durationMs,
        pngDir: p.pngDir,
        frameCount: p.N,
        hash: p.hash,
      });
    }
    return results;
  } finally {
    if (browser) await browser.close();
  }
}
