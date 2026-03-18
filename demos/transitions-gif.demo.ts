/**
 * Demo: Scene transitions + GIF export.
 *
 * A short 5-slide demo showcasing fade-through-black transitions.
 * The config enables transitions and GIF export so the pipeline
 * produces both MP4 and animated GIF.
 *
 * IMPORTANT: Slide changes happen BEFORE narration.mark() so the
 * transition fades out the OLD content and fades in the NEW content.
 * If you change content after mark(), the transition just pulses
 * the same slide (fade to black and back on identical content).
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

  // Slide 1: Intro (already showing)
  narration.mark('intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  // Change to slide 2 BEFORE marking — transition fades out slide 1, fades in slide 2
  await page.evaluate(() => window.showSlide(2));
  narration.mark('fade');
  await page.waitForTimeout(300);
  await showOverlay(page, 'fade', narration.durationFor('fade'));

  // Change to slide 3 BEFORE marking
  await page.evaluate(() => window.showSlide(3));
  narration.mark('gif');
  await page.waitForTimeout(300);
  await showOverlay(page, 'gif', narration.durationFor('gif'));

  // Change to slide 4 BEFORE marking
  await page.evaluate(() => window.showSlide(4));
  narration.mark('config');
  await page.waitForTimeout(300);
  await showOverlay(page, 'config', narration.durationFor('config'));

  // Change to slide 5 BEFORE marking
  await page.evaluate(() => window.showSlide(5));
  narration.mark('cta');
  await page.waitForTimeout(narration.durationFor('cta', { leadOutMs: 800 }));
});
