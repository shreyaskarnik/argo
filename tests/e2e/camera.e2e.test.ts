import { describe, it, expect } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { spotlight } from '../../src/camera.js';
import { describeWithCapability } from '../helpers/capability.js';

async function canLaunchChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

// Skips locally when Chromium isn't downloaded; fails in CI, where it is
// installed on purpose. A silent skip here would retire the very guard this
// suite exists to be — the bug it covers survived precisely because nothing
// could observe it.
const describeCameraE2E = describeWithCapability(
  await canLaunchChromium(),
  'a Chromium binary',
);

/** White target on a mid-grey field, so the scrim's effect on each is obvious. */
const FIXTURE = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; height: 100vh; background: #808080; display: grid; place-items: center; }
  #target { width: 300px; height: 100px; background: #fff; border: 0; }
</style>
<button id="target"></button>`;

describeCameraE2E('E2E: camera effects', () => {
  it('spotlight leaves the target untouched and dims everything else', async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent(FIXTURE);

      const box = (await page.locator('#target').boundingBox())!;
      // Both regions sit clear of the cutout edge; the default feather ramps
      // ~14px inward of it, so these insets must stay well above that.
      const insideTarget = {
        x: Math.round(box.x + 40),
        y: Math.round(box.y + 25),
        width: 120,
        height: 50,
      };
      const awayFromTarget = { x: 40, y: 40, width: 120, height: 50 };

      const targetBefore = await page.screenshot({ clip: insideTarget });
      const elsewhereBefore = await page.screenshot({ clip: awayFromTarget });

      await spotlight(page, '#target', { duration: 8000, fadeIn: 0, padding: 12 });
      await page.waitForTimeout(150);

      const targetAfter = await page.screenshot({ clip: insideTarget });
      const elsewhereAfter = await page.screenshot({ clip: awayFromTarget });

      // Comparing encoded bytes avoids an image-decoding dependency:
      // identical pixels from the same browser encode to an identical PNG.
      expect(
        targetAfter.equals(targetBefore),
        'spotlight painted over its own target: the cutout did not clear a hole',
      ).toBe(true);
      expect(
        elsewhereAfter.equals(elsewhereBefore),
        'spotlight did not dim anything, so the hole assertion above proves nothing',
      ).toBe(false);
    } finally {
      await browser?.close();
    }
  }, 30_000);

  // The mask is SVG, and CSS beats SVG presentation attributes. Icon libraries
  // routinely ship resets like this one; with `fill="…"` attributes both mask
  // rects repaint the same colour and the spotlight silently dims nothing.
  it('survives a page stylesheet that restyles SVG rects', async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent(FIXTURE + '<style>svg rect { fill: currentColor; } body { color: #111; }</style>');

      const box = (await page.locator('#target').boundingBox())!;
      const insideTarget = { x: Math.round(box.x + 40), y: Math.round(box.y + 25), width: 120, height: 50 };
      const awayFromTarget = { x: 40, y: 40, width: 120, height: 50 };
      const targetBefore = await page.screenshot({ clip: insideTarget });
      const elsewhereBefore = await page.screenshot({ clip: awayFromTarget });

      await spotlight(page, '#target', { duration: 8000, fadeIn: 0 });
      await page.waitForTimeout(150);

      expect(
        (await page.screenshot({ clip: awayFromTarget })).equals(elsewhereBefore),
        'page CSS overrode the mask fills, so the spotlight dimmed nothing',
      ).toBe(false);
      expect(
        (await page.screenshot({ clip: insideTarget })).equals(targetBefore),
        'page CSS overrode the mask fills and the hole was painted over',
      ).toBe(true);
    } finally {
      await browser?.close();
    }
  }, 30_000);

  // Negative padding shrinks the cutout inside the target's box, e.g. to leave
  // out a transparent margin. It rendered correctly before the SVG rewrite, so
  // clamping it to 0 would silently widen existing demos' spotlights.
  it('honours negative padding by shrinking the hole inside the target', async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent(FIXTURE);

      const box = (await page.locator('#target').boundingBox())!;
      // Hard edge, square corners: with padding -20 the hole is exactly the
      // target inset by 20px, so a 10px band at the target's edge must dim
      // while its centre stays clear.
      const edgeBand = { x: Math.round(box.x + 2), y: Math.round(box.y + 2), width: 10, height: 10 };
      const centre = { x: Math.round(box.x + 100), y: Math.round(box.y + 40), width: 100, height: 20 };
      const edgeBefore = await page.screenshot({ clip: edgeBand });
      const centreBefore = await page.screenshot({ clip: centre });

      await spotlight(page, '#target', { duration: 8000, fadeIn: 0, padding: -20, feather: 0, radius: 0 });
      await page.waitForTimeout(150);

      expect(
        (await page.screenshot({ clip: edgeBand })).equals(edgeBefore),
        'negative padding was ignored: the hole still covers the whole target',
      ).toBe(false);
      expect(
        (await page.screenshot({ clip: centre })).equals(centreBefore),
        'negative padding closed the hole entirely',
      ).toBe(true);
    } finally {
      await browser?.close();
    }
  }, 30_000);
});
