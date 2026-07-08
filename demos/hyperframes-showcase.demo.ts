/**
 * Argo × HyperFrames — comprehensive "full tour" showcase.
 *
 * Covers every major feature of both systems in one take:
 *   argo: multi-voice TTS, all overlay templates + blocks, GSAP motion,
 *         spotlight/focusRing/dimAround, post-export zoomTo, cursorHighlight,
 *         confetti (burst + emoji), freeze-frame hold, 16 shader transitions,
 *         chapters/subtitles/meta (narrated).
 *   hyperframes: 142-item catalog (live site), vignette/grain/shimmer-sweep
 *         components, data-chart block cutaway, edited logo-outro end card.
 *
 * Prerequisites:
 *   1. npx argo add vignette grain-overlay shimmer-sweep data-chart logo-outro (one per call)
 *   2. python3 -m http.server 8976 --directory demos
 *   3. npx tsx bin/argo.js pipeline hyperframes-showcase --config demos/hyperframes-showcase.config.mjs
 */
import { test } from '@argo-video/cli';
import { showOverlay, applyComponent, showConfetti } from '@argo-video/cli';
import { zoomTo, spotlight, focusRing, dimAround, resetCamera } from '@argo-video/cli';
import { cursorHighlight, resetCursor } from '@argo-video/cli';

test('hyperframes-showcase', async ({ page, narration }) => {
  test.setTimeout(420_000);

  await page.goto('/hyperframes-showcase.html');
  await page.waitForTimeout(700);

  await narration.startRecording(page);

  // ── 1. hook ───────────────────────────────────────────────────────────────
  narration.mark('hook');
  const hookMs = narration.sceneDuration('hook');
  void showOverlay(page, 'hook', Math.floor(hookMs * 0.75));
  await page.waitForTimeout(narration.durationFor('hook'));

  // ── 2. catalog (live site — three movements for energy) ─────────────────
  // Screencast + jpeg-stitch note: pages full of autoplaying <video> saturate
  // the frame writer (every frame unique, huge q-JPEGs) — the showcase grid
  // wedged two runs. m1 instead rides the catalog page: rapid scrolls down the
  // 142-item sidebar read as "the catalog is huge" with zero video decode.
  await page.goto('https://hyperframes.heygen.com/catalog', {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  await page.waitForTimeout(1400);
  narration.mark('catalog');
  cursorHighlight(page, { color: '#0ea5e9', radius: 16 });
  await page.mouse.move(160, 560, { steps: 20 });
  for (const dy of [900, 1100, 1300]) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(850);
  }
  await page.waitForTimeout(600);

  // m2: hard cut into a flashy catalog item, preview playing, punch-zoom.
  // NOTE: deliberately a page whose own content is static (the motion is the
  // <video> preview). Liquid-glass pages run live backdrop-filter demos that
  // crush the renderer under swiftshader + screencast (10-minute stall).
  await page.goto('https://hyperframes.heygen.com/catalog/blocks/glitch', {
    waitUntil: 'domcontentloaded',
    timeout: 20_000,
  });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.muted = true;
      v.scrollIntoView({ block: 'center' });
      void v.play();
    }
  });
  await page.waitForTimeout(400);
  await zoomTo(page, 'video', { scale: 1.5, duration: 2600, holdMs: 2600, narration });
  await page.waitForTimeout(3600);
  // Stop the preview before leaving — a decoding <video> left behind keeps
  // the screencast frame writer churning long after the scene.
  await page.evaluate(() => document.querySelector('video')?.pause());

  // m3: camera settles — lower-third rides the tail.
  const catalogTail = Math.max(2500, narration.durationFor('catalog'));
  void showOverlay(page, 'catalog', catalogTail - 400);
  await page.waitForTimeout(narration.durationFor('catalog'));
  resetCursor(page);

  // ── 3. argo ───────────────────────────────────────────────────────────────
  await page.goto('/hyperframes-showcase.html#argo', { waitUntil: 'domcontentloaded' });
  await page.locator('#argo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('argo');
  await page.waitForTimeout(narration.durationFor('argo'));

  // ── 4. voices (narrator swap — keep the frame calm) ─────────────────────
  narration.mark('voices');
  await page.waitForTimeout(narration.durationFor('voices'));

  // ── 5. overlays (template sequence via inline cues) ──────────────────────
  await page.locator('#overlays').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('overlays');
  const overlaysMs = narration.sceneDuration('overlays');
  const beat = Math.floor(overlaysMs / 3.4);
  void showOverlay(page, 'overlays', { type: 'callout', text: 'callout — point at anything', placement: 'top-right' }, beat);
  await page.waitForTimeout(beat);
  void showOverlay(page, 'overlays', { type: 'arrow', direction: 'up', label: 'arrow annotation', placement: 'bottom-left' }, beat);
  await page.waitForTimeout(beat);
  void showOverlay(
    page,
    'overlays',
    {
      type: 'block',
      block: 'x-post',
      props: {
        handle: '@argo_video',
        name: 'Argo',
        body: 'Blocks are overlays too — this post is the x-post block from argo’s catalog.',
        verified: true,
      },
      placement: 'bottom-right',
    },
    beat,
  );
  await page.waitForTimeout(narration.durationFor('overlays'));

  // ── 6. camera (spotlight → focusRing → dimAround) ────────────────────────
  await page.locator('#camera').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('camera');
  cursorHighlight(page, { color: '#0ea5e9', radius: 18 });
  const cameraMs = narration.sceneDuration('camera');
  const camBeat = Math.floor(cameraMs / 3.5);
  spotlight(page, '#cam-spotlight', { duration: camBeat });
  await page.waitForTimeout(camBeat);
  focusRing(page, '#cam-focus', { duration: camBeat });
  await page.waitForTimeout(camBeat);
  dimAround(page, '#cam-dim', { duration: camBeat });
  await page.waitForTimeout(narration.durationFor('camera'));
  await resetCamera(page);
  resetCursor(page);

  // ── 7. zoom (post-export zoompan on the zoomTo card) ─────────────────────
  narration.mark('zoom');
  const zoomMs = narration.sceneDuration('zoom');
  await zoomTo(page, '#cam-zoom', { scale: 1.55, duration: 3000, holdMs: Math.floor(zoomMs * 0.3), narration });
  await page.waitForTimeout(narration.durationFor('zoom'));

  // ── 8. chart (hf-block cutaway covers the frame at export) ──────────────
  narration.mark('chart');
  await page.waitForTimeout(narration.durationFor('chart'));

  // ── 9. components (vignette + grain + shimmer sweep) ─────────────────────
  await page.locator('#components').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('components');
  const compMs = narration.sceneDuration('components');
  await page.waitForTimeout(Math.floor(compMs * 0.25));
  await applyComponent(page, 'vignette', { params: { '--vignette-size': '50%' } });
  await page.waitForTimeout(Math.floor(compMs * 0.15));
  await applyComponent(page, 'grain-overlay');
  await page.waitForTimeout(Math.floor(compMs * 0.15));
  // shimmer-sweep injects masks into .shimmer-sweep-target; the sweep position
  // is a CSS var normally driven by a composition timeline — drive it with a
  // small rAF loop here (two passes).
  await applyComponent(page, 'shimmer-sweep');
  await page.evaluate(() => {
    const start = performance.now();
    const sweep = (now: number) => {
      const t = (now - start) / 1400; // 1.4s per pass
      const pass = t % 1;
      document.documentElement.style.setProperty('--shimmer-pos', `${-20 + pass * 140}%`);
      if (t < 2) requestAnimationFrame(sweep);
      else document.documentElement.style.setProperty('--shimmer-pos', '120%');
    };
    requestAnimationFrame(sweep);
  });
  await page.waitForTimeout(narration.durationFor('components'));

  // ── 10. effects (confetti + freeze hold at the peak) ─────────────────────
  await page.locator('#effects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('effects');
  // Fixed offsets so the manifest freeze (atMs 6000) catches confetti mid-air:
  // burst at 4.0s (3s life), emoji rain at 5.2s — at 6.0s both are airborne.
  await page.waitForTimeout(4000);
  void showConfetti(page, { spread: 'burst', pieces: 180 });
  await page.waitForTimeout(1200);
  void showConfetti(page, { spread: 'rain', emoji: ['🚀', '⭐'], pieces: 90, duration: 3200 });
  await page.waitForTimeout(narration.durationFor('effects'));

  // ── 11. shaders ───────────────────────────────────────────────────────────
  await page.locator('#shaders').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('shaders');
  await page.waitForTimeout(narration.durationFor('shaders'));

  // ── 12. better together ───────────────────────────────────────────────────
  await page.locator('#better').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('better');
  const betterMs = narration.sceneDuration('better');
  await page.waitForTimeout(Math.floor(betterMs * 0.4));
  void showOverlay(page, 'better', Math.floor(betterMs * 0.5));
  await page.waitForTimeout(narration.durationFor('better'));

  // ── 13. outro (logo-outro composites over this at export) ────────────────
  await page.locator('#outro').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('outro');
  await page.waitForTimeout(narration.durationFor('outro'));
});
