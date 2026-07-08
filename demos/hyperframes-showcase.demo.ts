/**
 * Argo × HyperFrames — "Better Together" showcase.
 *
 * Dogfoods the whole hyperframes integration:
 *   - Track 1: domain-warp shader transition at every scene boundary (see config)
 *   - Track 2: vignette + grain-overlay components applied live during recording
 *   - Track 3: logo-outro block composited as the end card at export
 *
 * Prerequisites:
 *   1. Install catalog items:  npx argo add vignette && npx argo add grain-overlay && npx argo add logo-outro
 *   2. Serve the story page:   python3 -m http.server 8976 --directory demos
 *   3. Run pipeline:           npx tsx bin/argo.js pipeline hyperframes-showcase --config demos/hyperframes-showcase.config.mjs
 *
 * Scene 'catalog' visits the live hyperframes site — network required.
 */
import { test } from '@argo-video/cli';
import { showOverlay, applyComponent, zoomTo } from '@argo-video/cli';

test('hyperframes-showcase', async ({ page, narration }) => {
  test.setTimeout(300_000);

  await page.goto('/hyperframes-showcase.html');
  await page.waitForTimeout(700);

  await narration.startRecording(page);

  // ── Scene 1: hook (story page) ────────────────────────────────────────────
  narration.mark('hook');
  await page.waitForTimeout(narration.durationFor('hook'));

  // ── Scene 2: catalog (live hyperframes site) ─────────────────────────────
  // Content change BEFORE mark() so the shader transition lands between pages.
  await page.goto('https://hyperframes.heygen.com', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200); // let the JS-rendered hero settle
  narration.mark('catalog');
  const catalogMs = narration.sceneDuration('catalog');
  // Gentle post-export camera push on the hero first (zoompan crops the
  // frame, so the lower-third waits until the camera settles).
  const hero = page.locator('main');
  if (await hero.count()) {
    await zoomTo(page, 'main', {
      scale: 1.18,
      duration: 3200,
      holdMs: Math.floor(catalogMs * 0.25),
      narration,
    });
  }
  await page.waitForTimeout(Math.floor(catalogMs * 0.45));
  // Camera is back out — safe to show the lower-third for the scene's tail.
  void showOverlay(page, 'catalog', Math.floor(catalogMs * 0.45));
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(Math.floor(catalogMs * 0.25));
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(narration.durationFor('catalog'));

  // ── Scene 3: argo (story page) ────────────────────────────────────────────
  await page.goto('/hyperframes-showcase.html#argo', { waitUntil: 'domcontentloaded' });
  await page.locator('#argo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('argo');
  await page.waitForTimeout(narration.durationFor('argo'));

  // ── Scene 4: better together (components land on this footage) ───────────
  await page.locator('#better').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('better');
  const betterMs = narration.sceneDuration('better');
  // Let the narration set up the moment, then apply the grade mid-sentence
  // ("watch the grade land") so the change is visible on screen.
  await page.waitForTimeout(Math.floor(betterMs * 0.35));
  await applyComponent(page, 'vignette', { params: { '--vignette-size': '52%' } });
  await applyComponent(page, 'grain-overlay');
  void showOverlay(page, 'better', Math.floor(betterMs * 0.5));
  await page.waitForTimeout(narration.durationFor('better'));

  // ── Scene 5: outro (quiet backdrop; logo-outro composites at export) ─────
  await page.locator('#outro').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  narration.mark('outro');
  // The hf-block cue in the manifest is an export-time cutaway — the script
  // only holds the scene for its narration length.
  await page.waitForTimeout(narration.durationFor('outro'));
});
