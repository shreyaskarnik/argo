/**
 * Render overlay cues to transparent PNGs using Playwright.
 *
 * For imported videos (no Playwright recording step), overlays defined in
 * .scenes.json are never burned into the video. This module renders each
 * overlay as a transparent PNG at the video's resolution so they can be
 * composited via ffmpeg's overlay filter with `enable` timeline.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderTemplate, type TemplateResult } from './templates.js';
import type { OverlayCue, Zone } from './types.js';
import type { BackgroundTheme } from './zones.js';
import type { Placement } from '../tts/align.js';

export interface OverlayPngInput {
  scene: string;
  overlay: OverlayCue;
  startMs: number;
  endMs: number;
}

export interface RenderedOverlayPng {
  scene: string;
  pngPath: string;
  zone: Zone;
  startMs: number;
  endMs: number;
}

/**
 * CSS positioning rules that match the live preview / recording zones.
 * Uses fixed positioning within a viewport-sized container.
 */
const ZONE_CSS: Record<Zone, string> = {
  'bottom-center': 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);',
  'top-left': 'position:fixed;top:40px;left:40px;',
  'top-right': 'position:fixed;top:40px;right:40px;',
  'bottom-left': 'position:fixed;bottom:60px;left:40px;',
  'bottom-right': 'position:fixed;bottom:60px;right:40px;',
  'center': 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);',
};

/**
 * Map zone positions to ffmpeg overlay x/y expressions.
 * W, H = base video dimensions; w, h = overlay dimensions.
 */
const ZONE_FFMPEG_POS: Record<Zone, string> = {
  'top-left': 'x=40:y=40',
  'top-right': 'x=W-w-40:y=40',
  'bottom-left': 'x=40:y=H-h-60',
  'bottom-right': 'x=W-w-40:y=H-h-60',
  'bottom-center': 'x=(W-w)/2:y=H-h-60',
  'center': 'x=(W-w)/2:y=(H-h)/2',
};

/**
 * Build a full-page HTML document that renders a single overlay at the
 * correct zone position on a transparent background.
 */
function buildOverlayHtml(
  templateResult: TemplateResult,
  zone: Zone,
  width: number,
  height: number,
): string {
  const styleEntries = Object.entries(templateResult.styles)
    .map(([k, v]) => {
      // Convert camelCase to kebab-case for CSS
      const prop = k.replace(/([A-Z])/g, '-$1').toLowerCase();
      return `${prop}: ${v};`;
    })
    .join(' ');

  const zoneCss = ZONE_CSS[zone];

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: transparent;
  }
  .overlay {
    ${zoneCss}
    z-index: 999999;
    pointer-events: none;
    font-family: system-ui, -apple-system, sans-serif;
    ${styleEntries}
  }
</style>
</head>
<body>
  <div class="overlay">${templateResult.contentHtml}</div>
</body>
</html>`;
}

/**
 * Compute a content hash for cache invalidation.
 * Changes to the overlay cue or video dimensions invalidate the cache.
 */
function computeHash(overlay: OverlayCue, width: number, height: number, theme: string = 'dark'): string {
  const data = JSON.stringify({ overlay, width, height, theme });
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/**
 * Render overlay cues to transparent PNGs.
 *
 * Launches a headless Chromium browser, renders each overlay as a
 * full-page screenshot with transparent background, and saves them
 * to `outputDir`. PNGs are content-addressed cached — only regenerated
 * when the overlay definition or video dimensions change.
 *
 * @param overlays - Array of overlay cues with timing information
 * @param outputDir - Directory to save PNGs (e.g. `.argo/<demo>/overlay-pngs/`)
 * @param videoWidth - Width of the target video in pixels
 * @param videoHeight - Height of the target video in pixels
 * @param theme - Background theme for overlay styling (default: 'dark')
 * @returns Array of rendered overlay PNGs with timing and position info
 */
export async function renderOverlaysToPng(
  overlays: OverlayPngInput[],
  outputDir: string,
  videoWidth: number,
  videoHeight: number,
  theme: BackgroundTheme = 'dark',
): Promise<RenderedOverlayPng[]> {
  if (overlays.length === 0) return [];

  mkdirSync(outputDir, { recursive: true });

  // Check which overlays need rendering (cache check)
  const toRender: Array<{ input: OverlayPngInput; pngPath: string; hash: string }> = [];
  const results: RenderedOverlayPng[] = [];

  for (const input of overlays) {
    const zone: Zone = input.overlay.placement ?? 'bottom-center';
    const hash = computeHash(input.overlay, videoWidth, videoHeight, theme);
    const pngPath = join(outputDir, `${input.scene}-overlay-${hash}.png`);

    if (existsSync(pngPath)) {
      // Cached — reuse
      results.push({
        scene: input.scene,
        pngPath,
        zone,
        startMs: input.startMs,
        endMs: input.endMs,
      });
    } else {
      toRender.push({ input, pngPath, hash });
      results.push({
        scene: input.scene,
        pngPath,
        zone,
        startMs: input.startMs,
        endMs: input.endMs,
      });
    }
  }

  if (toRender.length === 0) return results;

  // Lazy-load Playwright to avoid import cost when all PNGs are cached
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: videoWidth, height: videoHeight },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    for (const { input, pngPath } of toRender) {
      const zone: Zone = input.overlay.placement ?? 'bottom-center';
      const templateResult = renderTemplate(input.overlay, theme);
      const html = buildOverlayHtml(templateResult, zone, videoWidth, videoHeight);

      await page.setContent(html, { waitUntil: 'load' });
      await page.screenshot({
        path: pngPath,
        omitBackground: true,
        fullPage: false,
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return results;
}

/**
 * Build ffmpeg filter_complex fragments to composite overlay PNGs onto a video.
 *
 * Each PNG is added as an input with `-loop 1` and overlaid using the
 * `enable='between(t,start,end)'` timeline filter.
 *
 * @param pngs - Rendered overlay PNGs with timing
 * @param baseInputCount - Number of ffmpeg inputs before overlay PNGs
 * @returns Object with additional ffmpeg args, filter parts, and updated input count
 */
export function buildOverlayPngFilters(
  pngs: RenderedOverlayPng[],
  baseInputCount: number,
  videoSourceLabel: string,
): {
  inputArgs: string[];
  filterParts: string[];
  videoSource: string;
  nextInput: number;
} {
  if (pngs.length === 0) {
    return { inputArgs: [], filterParts: [], videoSource: videoSourceLabel, nextInput: baseInputCount };
  }

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  let currentVideo = videoSourceLabel;
  let nextInput = baseInputCount;

  for (let i = 0; i < pngs.length; i++) {
    const png = pngs[i];
    const pngInputIdx = nextInput++;

    // Add PNG as looped input with explicit duration to prevent ffmpeg hanging.
    // Without -t, -loop 1 creates an infinite stream that never terminates.
    const durSec = ((png.endMs + 1000) / 1000).toFixed(3);
    inputArgs.push('-loop', '1', '-t', durSec, '-i', png.pngPath);

    const startSec = (png.startMs / 1000).toFixed(3);
    const endSec = (png.endMs / 1000).toFixed(3);
    const posExpr = ZONE_FFMPEG_POS[png.zone];
    const outputLabel = `ovlpng${i}`;

    filterParts.push(
      `[${currentVideo}][${pngInputIdx}:v]overlay=${posExpr}:enable='between(t\\,${startSec}\\,${endSec})':format=auto:shortest=1[${outputLabel}]`,
    );
    currentVideo = outputLabel;
  }

  return { inputArgs, filterParts, videoSource: currentVideo, nextInput };
}

/**
 * Check if a demo is an imported video (has `.imported` marker).
 */
export function isImportedVideo(argoDir: string, demoName: string): boolean {
  return existsSync(join(argoDir, demoName, '.imported'));
}

/**
 * Build overlay PNGs for an imported video if overlays are defined.
 *
 * Shared across all export paths (CLI, pipeline, preview) to ensure parity.
 * Detects adaptive theme from the video frame at the overlay's start time.
 *
 * @param argoDir - Path to .argo directory
 * @param demoName - Demo name
 * @param manifestPath - Path to .scenes.json manifest
 * @param placements - Scene placements with timing
 * @param videoWidth - Output video width
 * @param videoHeight - Output video height
 * @param deviceScaleFactor - Recording scale factor (for PNG rendering resolution)
 * @returns Rendered overlay PNGs or undefined if not applicable
 */
export async function buildOverlayPngsForImport(options: {
  argoDir: string;
  demoName: string;
  manifestPath: string;
  placements: Placement[];
  videoWidth: number;
  videoHeight: number;
  deviceScaleFactor?: number;
}): Promise<RenderedOverlayPng[] | undefined> {
  const { argoDir, demoName, manifestPath, placements, videoWidth, videoHeight, deviceScaleFactor = 1 } = options;

  if (!isImportedVideo(argoDir, demoName)) return undefined;
  if (placements.length === 0) return undefined;

  let scenes: Array<{ scene?: string; overlay?: OverlayCue }>;
  try {
    scenes = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return undefined;
  }

  const hasOverlays = scenes.some((s) => s.overlay);
  if (!hasOverlays) return undefined;

  const overlayInputs: OverlayPngInput[] = [];
  for (const entry of scenes) {
    if (!entry.overlay || !entry.scene) continue;
    const placement = placements.find((p) => p.scene === entry.scene);
    if (!placement) continue;
    overlayInputs.push({
      scene: entry.scene,
      overlay: entry.overlay,
      startMs: placement.startMs,
      endMs: placement.endMs,
    });
  }

  if (overlayInputs.length === 0) return undefined;

  // Detect theme from the video at the first overlay's start time
  const { detectVideoTheme } = await import('../media.js');
  const videoPath = join(argoDir, demoName, 'video.webm');
  const theme = detectVideoTheme(videoPath, overlayInputs[0].startMs);

  const pngDir = join(argoDir, demoName, 'overlay-pngs');
  const renderW = videoWidth * deviceScaleFactor;
  const renderH = videoHeight * deviceScaleFactor;
  const pngs = await renderOverlaysToPng(overlayInputs, pngDir, renderW, renderH, theme);
  console.log(`  Rendered ${pngs.length} overlay PNG(s) for compositing (theme: ${theme})`);
  return pngs;
}
