import { test } from '@argo-video/cli';
import {
  showOverlay,
  withOverlay,
  spotlight,
  showConfetti,
  cursorHighlight,
  resetCursor,
  resetCamera,
} from '@argo-video/cli';

// Mobile viewport: narrow width, touch enabled
test.use({
  viewport: { width: 390, height: 664 },
  isMobile: true,
  hasTouch: true,
});

test('mobile', async ({ page, narration }) => {
  test.setTimeout(60_000);

  await page.goto('/mobile.html');
  await page.waitForLoadState('networkidle');

  cursorHighlight(page, { color: '#e85d04', radius: 16 });

  // Scene 1: intro — show the menu
  narration.mark('intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  // Scene 2: select — tap a few items
  narration.mark('select');
  const selectDur = narration.durationFor('select');
  const stepDur = Math.floor(selectDur / 3);

  await withOverlay(page, 'select', async () => {
    await page.locator('.menu-item', { hasText: 'Flat White' }).tap();
    await page.waitForTimeout(stepDur);

    spotlight(page, page.locator('.menu-item', { hasText: 'Matcha Latte' }), { duration: stepDur });
    await page.locator('.menu-item', { hasText: 'Matcha Latte' }).tap();
    await page.waitForTimeout(stepDur);

    await page.locator('.menu-item', { hasText: 'Croissant' }).tap();
    await page.waitForTimeout(stepDur);
  });

  // Scene 3: checkout — tap Place Order
  narration.mark('checkout');
  const checkoutDur = narration.durationFor('checkout');

  spotlight(page, '#order-btn', { duration: Math.floor(checkoutDur * 0.5) });
  await page.waitForTimeout(Math.floor(checkoutDur * 0.4));
  await page.locator('#order-btn').tap();
  await page.waitForTimeout(Math.floor(checkoutDur * 0.3));

  // Scene 4: confirmation
  narration.mark('done');
  resetCamera(page);
  resetCursor(page);
  showConfetti(page, { emoji: ['☕', '🥐'], spread: 'rain' });
  await showOverlay(page, 'done', narration.durationFor('done', { leadOutMs: 800 }));
});
