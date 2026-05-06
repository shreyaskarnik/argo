// renderComposition — embed a self-contained HTML composition as an Argo scene.
//
// Composition contract (mirrors hyperframes' shape so a composition that runs
// in hyperframes runs unchanged in Argo):
//
//   * Root element: <div data-composition-id="X" data-width="..."
//                        data-height="..." data-duration="...">
//   * (optional) `window.__compositionReady` — a Promise that resolves when
//     fonts/timeline/assets are ready. renderComposition awaits it before
//     marking the scene.
//   * (optional) `window.__timelines[<scene>]` — a paused GSAP master
//     timeline. renderComposition calls `.play()` after marking the scene.
//
// Argo additions on top of the hyperframes contract:
//
//   * `window.__argoVideoSrc` — set by renderComposition via addInitScript
//     when `opts.videoSrc` is provided. Compositions that wrap a recording
//     (e.g. a 3D device frame around an Argo mp4) read this to embed a
//     `<video>` child for html-in-canvas texturing.
//
// The composition file is loaded via `page.goto('file://...')` so relative
// asset paths (textures, GLTF models, fonts) resolve normally — `setContent`
// with embedded HTML breaks every external reference.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Page } from '@playwright/test';
import type { NarrationTimeline } from './narration.js';
import { startCompositionServer } from './composition-server.js';

export interface RenderCompositionOptions {
  /** Scene name passed to `narration.mark()` and matched against
   *  `window.__timelines[scene]` for timeline resume. */
  scene: string;
  /** Hold duration in milliseconds. When omitted, falls back to the
   *  composition's `data-duration` attribute (in seconds), then 5000ms. */
  durationMs?: number;
  /** Optional video URL/path injected as `window.__argoVideoSrc` before
   *  the composition loads. Compositions consume this to texture an
   *  Argo recording onto a 3D device frame, etc. */
  videoSrc?: string;
  /** Override the readiness wait. Default 8000ms — long enough for
   *  GLTF model loads, short enough that a stuck composition fails fast. */
  readyTimeoutMs?: number;
  /** Root directory served by the composition HTTP server. Defaults to
   *  the directory two levels up from the composition (so `compositions/foo.html`
   *  resolves siblings like `models/bar.glb` at the project root). Override
   *  for compositions that live outside the standard `compositions/` layout. */
  serverRoot?: string;
}

export async function renderComposition(
  page: Page,
  narration: NarrationTimeline,
  htmlPath: string,
  opts: RenderCompositionOptions,
): Promise<void> {
  if (!existsSync(htmlPath)) {
    throw new Error(`renderComposition: composition file not found: ${htmlPath}`);
  }

  // Inject videoSrc BEFORE navigation. addInitScript fires on every load —
  // we revoke after this scene completes so subsequent navigations in the
  // demo don't keep the global set.
  if (opts.videoSrc) {
    await page.addInitScript((src) => {
      (window as unknown as { __argoVideoSrc?: string }).__argoVideoSrc = src;
    }, opts.videoSrc);
  }

  // Spin up a per-scene HTTP server rooted at the project (composition's
  // grandparent) so relative refs from inside the composition reach sibling
  // directories at the root (e.g. `compositions/foo.html` loading
  // `models/bar.glb`). file:// URLs hit chromium's CORS-on-file gating
  // even with --allow-file-access-from-files for asset types like GLTF.
  const compAbs = resolve(htmlPath);
  const root = opts.serverRoot ?? dirname(dirname(compAbs));
  const server = await startCompositionServer(root, compAbs);
  try {
    await page.goto(server.url, { waitUntil: 'load' });

    // Await composition's readiness signal (best-effort — compositions
    // without one are just considered ready when `load` fires).
    const readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
    await page.evaluate((timeoutMs) => {
      const ready = (window as unknown as { __compositionReady?: Promise<unknown> }).__compositionReady;
      if (!(ready instanceof Promise)) return undefined;
      return Promise.race([
        ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('composition __compositionReady timed out')), timeoutMs),
        ),
      ]);
    }, readyTimeoutMs);

    // Resolve duration: explicit override > composition's data-duration > 5s default.
    const declared = await page.evaluate((sceneId) => {
      const compRoot = document.querySelector(`[data-composition-id="${sceneId}"]`)
        ?? document.querySelector('[data-composition-id]');
      const v = compRoot?.getAttribute('data-duration');
      return v ? Number(v) * 1000 : null;
    }, opts.scene);
    const durationMs = opts.durationMs ?? declared ?? 5000;

    // Poll for timeline registration BEFORE marking the scene. Many
    // hyperframes blocks register `window.__timelines[scene]` AFTER async
    // GLTF/asset/DRACO loads complete (10-12s of browser warmup). Marking
    // the scene first and polling second burns that warmup as visually
    // blank scene time. Mark after the timeline is ready so the scene's
    // first frame is the composition's first animated frame.
    await page.evaluate(
      ({ sceneId, pollMs }) => {
        return new Promise<void>((resolve) => {
          const deadline = performance.now() + pollMs;
          const tick = () => {
            const tls = (window as unknown as { __timelines?: Record<string, { play?: () => unknown }> }).__timelines;
            const target = tls?.[sceneId];
            const hasAny = tls && Object.keys(tls).length > 0;
            if (target?.play || hasAny) { resolve(); return; }
            if (performance.now() > deadline) { resolve(); return; }
            setTimeout(tick, 50);
          };
          tick();
        });
      },
      { sceneId: opts.scene, pollMs: readyTimeoutMs },
    );

    // If the demo hasn't already started recording, start it now — AFTER the
    // composition's warmup (page load + DRACO + GLTF + Three.js init can be
    // 5-10s of black). Demos that mix recorded scenes with composition scenes
    // typically call `narration.startRecording(page)` themselves before any
    // recorded content; in that case we don't re-anchor here.
    type StartRecordingHost = { isRecording: boolean; startRecording: (p: typeof page) => Promise<void> };
    const host = narration as unknown as StartRecordingHost;
    if (!host.isRecording) {
      await host.startRecording(page);
    }

    narration.mark(opts.scene);

    // Resume the registered timeline. Look up by scene name, fall back to
    // playing all registered timelines (compositions with a single master).
    await page.evaluate((sceneId) => {
      const tls = (window as unknown as { __timelines?: Record<string, { play?: () => unknown }> }).__timelines;
      if (!tls) return;
      if (tls[sceneId]?.play) {
        tls[sceneId].play!();
      } else {
        for (const tl of Object.values(tls)) {
          if (tl?.play) tl.play();
        }
      }
    }, opts.scene);

    await page.waitForTimeout(durationMs);
  } finally {
    await server.close();
  }
}

/**
 * Read a composition's declared duration from its `data-duration` attribute
 * without rendering it. Useful in `narration.durationFor()` callsites that
 * need the duration before the page navigates to the composition.
 */
export function readCompositionDuration(htmlPath: string): number | null {
  if (!existsSync(htmlPath)) return null;
  const html = readFileSync(htmlPath, 'utf-8');
  const match = html.match(/data-duration=["'](\d+(?:\.\d+)?)["']/);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}
