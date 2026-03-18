/**
 * Demo: Scene transitions + GIF export.
 *
 * A short 5-slide demo showcasing fade-through-black transitions.
 * The config enables transitions and GIF export so the pipeline
 * produces both MP4 and animated GIF.
 *
 * Prerequisites:
 *   1. Serve the HTML:  python3 -m http.server 8976 --directory demos
 *   2. Run pipeline:    npx tsx bin/argo.js pipeline transitions-gif --browser webkit --config demos/transitions-gif.config.mjs
 */
import { test } from '@argo-video/cli';
import { showOverlay } from '@argo-video/cli';

test('transitions-gif', async ({ page, narration }) => {
  test.setTimeout(60_000);
  await page.goto('/transitions-gif.html');
  await page.waitForTimeout(500);

  // Slide 1: Intro
  narration.mark('intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  // Slide 2: Watch the fade
  narration.mark('fade');
  await page.evaluate(() => window.showSlide(2));
  await page.waitForTimeout(300);
  await showOverlay(page, 'fade', narration.durationFor('fade'));

  // Slide 3: GIF export
  narration.mark('gif');
  await page.evaluate(() => window.showSlide(3));
  await page.waitForTimeout(300);
  await showOverlay(page, 'gif', narration.durationFor('gif'));

  // Slide 4: Config-driven
  narration.mark('config');
  await page.evaluate(() => window.showSlide(4));
  await page.waitForTimeout(300);
  await showOverlay(page, 'config', narration.durationFor('config'));

  // Slide 5: CTA (no overlay — the slide itself is the visual)
  narration.mark('cta');
  await page.evaluate(() => window.showSlide(5));
  await page.waitForTimeout(narration.durationFor('cta', { leadOutMs: 800 }));
});
