import { describe, it, expect } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { spotlight } from '../../src/camera.js';

async function canLaunchChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const describeCameraE2E = (await canLaunchChromium()) ? describe : describe.skip;

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
      // Both regions sit clear of the cutout edge, so antialiasing cannot skew it.
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
});
