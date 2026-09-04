import { it, expect } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createHumanCursor } from '../../src/human-cursor.js';
import { cursorHighlight, resetCursor } from '../../src/cursor.js';
import { withOverlay } from '../../src/overlays/index.js';
import { describeWithCapability } from '../helpers/capability.js';

async function canLaunchChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch { return false; }
}
const describeCursorE2E = describeWithCapability(await canLaunchChromium(), 'a Chromium binary');

describeCursorE2E('E2E: SVG pointer plus ring', () => {
  it('shows brief circles only on appearance, click, and Control release', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.setContent('<button style="position:fixed;left:400px;top:240px;width:240px;height:120px">Click</button>');
      await page.evaluate(() => {
        (window as any).clicks = 0;
        document.querySelector('button')!.addEventListener('click', () => { (window as any).clicks++; });
      });
      await cursorHighlight(page, { mode: 'click' });
      const cursor = await createHumanCursor(page);
      const circle = page.locator('[data-argo-cursor="ripple"]');
      const idleRing = page.locator('[data-argo-cursor="highlight"]');
      expect(await idleRing.isVisible()).toBe(false);
      expect(await circle.count()).toBe(1);
      expect(await circle.evaluate(el => getComputedStyle(el).animationName)).toBe('argo-cursor-locate');
      const initialLeft = await circle.evaluate(el => (el as HTMLElement).style.left);
      await page.mouse.move(800, 500);
      expect(await circle.evaluate(el => (el as HTMLElement).style.left)).toBe(initialLeft);
      await circle.waitFor({ state: 'detached' });

      // Ordinary travel cannot leave a persistent ring or spawn new circles.
      await cursor.moveTo(page.getByRole('button'), { durationMs: 100 });
      expect(await circle.count()).toBe(0);
      expect(await idleRing.isVisible()).toBe(false);
      await cursor.click(page.getByRole('button'), { durationMs: 0, afterMs: 0 });
      expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
      expect(await circle.count()).toBe(1);
      const clickLeft = await circle.evaluate(el => (el as HTMLElement).style.left);
      expect(clickLeft).toBe(await page.locator('#argo-human-cursor').evaluate(el => (el as HTMLElement).style.left));
      await circle.waitFor({ state: 'detached' });

      // Rapid Control releases retrigger one circle, without another click.
      await page.keyboard.press('Control');
      await page.keyboard.press('Control');
      expect(await circle.count()).toBe(1);
      expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
      await circle.waitFor({ state: 'detached' });
      expect(await page.locator('#argo-human-cursor svg').isVisible()).toBe(true);
      await resetCursor(page);
      await page.keyboard.press('Control');
      await page.mouse.click(410, 250);
      expect(await circle.count()).toBe(0);
      await cursor.dispose();
    } finally {
      await browser.close();
    }
  }, 30_000);

  it('keeps the SVG tip and circle aligned, clicks through overlays, and cleans up across navigation', async () => {
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.route('http://cursor.test/**', route => route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>button { position:fixed; left:400px; top:240px; width:240px; height:120px; cursor:pointer }</style>
          <button>Choose project</button><script>
          window.events = [];
          document.addEventListener('mousemove', e => window.events.push({ x:e.clientX, y:e.clientY, trusted:e.isTrusted }));
          document.querySelector('button').onclick = e => {
            window.clicked = e.isTrusted;
            // The ring's capture listener already ran. No second ripple from the SVG.
            window.ripples = document.querySelectorAll('[data-argo-cursor="ripple"]').length;
          };
          </script>`,
      }));
      await page.goto('http://cursor.test/');
      await cursorHighlight(page, { pulse: false });
      const cursor = await createHumanCursor(page, { seed: 'proof', size: 30 });
      const pointer = page.locator('#argo-human-cursor');
      expect(await pointer.locator('svg').isVisible()).toBe(true);
      await withOverlay(page, 'proof', {
        type: 'headline-card', title: 'Click through the annotation', placement: 'center',
      }, async () => {
        await withOverlay(page, 'proof', {
          type: 'callout', text: 'Still interactive', placement: 'top-right',
        }, async () => {
          await withOverlay(page, 'proof', {
            type: 'lower-third', text: 'SVG + circle', placement: 'bottom-left',
          }, async () => {
            await cursor.click(page.getByRole('button'), { durationMs: 200, afterMs: 20 });
            const result = await page.evaluate(() => ({
              clicked: (window as any).clicked,
              ripples: (window as any).ripples,
              events: (window as any).events as Array<{ x: number; y: number; trusted: boolean }>,
            }));
            expect(result.clicked).toBe(true);
            expect(result.ripples).toBe(1);
            expect(result.events.length).toBeGreaterThan(10);
            expect(result.events.every(e => e.trusted)).toBe(true);
            const point = result.events.at(-1)!;
            const geometry = await page.evaluate(() => {
              const ring = document.getElementById('argo-cursor-highlight')!;
              const glyph = document.querySelector('#argo-human-cursor svg')!;
              const r = ring.getBoundingClientRect();
              const g = glyph.getBoundingClientRect();
              return {
                ringX: r.x + r.width / 2, ringY: r.y + r.height / 2,
                tipX: g.x + 2, tipY: g.y + 2,
                ringLayer: Number(getComputedStyle(ring).zIndex),
                overlayLayer: Number(getComputedStyle(document.getElementById('argo-overlay-center')!).zIndex),
                pointerLayer: Number(getComputedStyle(document.getElementById('argo-human-cursor')!).zIndex),
              };
            });
            expect(geometry.ringX).toBeCloseTo(point.x, 0);
            expect(geometry.ringY).toBeCloseTo(point.y, 0);
            expect(geometry.tipX).toBeCloseTo(point.x, 0);
            expect(geometry.tipY).toBeCloseTo(point.y, 0);
            expect(geometry.pointerLayer).toBeGreaterThan(geometry.ringLayer);
            expect(geometry.ringLayer).toBeGreaterThan(geometry.overlayLayer);
          });
        });
      });

      const leftBefore = await pointer.evaluate(el => (el as HTMLElement).style.left);
      await cursor.hide();
      expect(await pointer.isVisible()).toBe(false);
      await page.goto('http://cursor.test/next');
      await page.waitForSelector('#argo-human-cursor', { state: 'attached' });
      expect(await pointer.isVisible()).toBe(false);
      expect(await pointer.evaluate(el => (el as HTMLElement).style.left)).toBe(leftBefore);
      await cursor.moveTo(page.getByRole('button'), { durationMs: 50 });
      expect(await pointer.isVisible()).toBe(true);

      await cursorHighlight(page);
      await cursor.dispose();
      expect(await pointer.count()).toBe(0);
      expect(await page.locator('[data-argo-cursor="highlight"]').count()).toBe(1);
      expect(await page.getByRole('button').evaluate(el => getComputedStyle(el).cursor)).toBe('pointer');
      await resetCursor(page);
      await page.goto('http://cursor.test/after-dispose');
      expect(await pointer.count()).toBe(0);
      expect(await page.locator('#argo-human-cursor-style').count()).toBe(0);
      await expect(cursor.moveTo(page.getByRole('button'))).rejects.toThrow('disposed');
    } finally {
      await browser?.close();
    }
  }, 30_000);
});
