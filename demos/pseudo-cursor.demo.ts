import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { test, createHumanCursor, cursorHighlight, resetCursor, withOverlay } from '@argo-video/cli';

// Run from the repo root: node bin/argo.js pipeline pseudo-cursor
// Silent scenes keep this example independent of TTS engines and API keys.
test('pseudo-cursor', async ({ page, narration }) => {
  test.setTimeout(90_000);

  const html = readFileSync(new URL('./pseudo-cursor.html', import.meta.url), 'utf8');
  await page.route('http://pseudo-cursor.test/**', route =>
    route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://pseudo-cursor.test/');
  await narration.startRecording(page);

  // The pipeline enables the ring via video.cursorHighlight. Direct Playwright
  // runs do not load Argo config, so enable it manually only in that mode.
  if (!process.env.ARGO_CURSOR_HIGHLIGHT) await cursorHighlight(page, { mode: 'click', radius: 24, opacity: 0.9 });
  const ring = page.locator('[data-argo-cursor="highlight"]');
  const locatorCircle = page.locator('[data-argo-cursor="ripple"]');
  await expect(ring).toBeHidden();

  // The SVG glyph and ring are separate effects, driven by the SAME real
  // mouse events. Keep one cursor across all scenes; circles are event-only.
  const cursor = await createHumanCursor(page, {
    seed: 'pseudo-cursor', size: 30, start: { x: 0.64, y: 0.2 },
  });
  const pointer = page.locator('#argo-human-cursor');
  await expect(pointer.locator('svg')).toBeVisible();
  const explain = async (step: string, title: string, detail: string, code: string) => {
    await page.evaluate(({ step, title, detail, code }) => {
      document.getElementById('step')!.textContent = step;
      document.getElementById('lesson')!.textContent = title;
      document.getElementById('explanation')!.textContent = detail;
      document.getElementById('code')!.textContent = code;
    }, { step, title, detail, code });
  };
  const hold = (scene: string) => page.waitForTimeout(narration.durationFor(scene, { fallbackMs: 2500 }));

  narration.mark('intro');
  await hold('intro');
  await expect(locatorCircle).toHaveCount(0);

  await explain('02 / MOVEMENT', 'Follow the motion.',
    'The SVG arrow travels alone. No circle follows it; the highlight is reserved for moments that need attention.',
    "await cursor.moveTo(target);\n// Seeded curves, real events");
  narration.mark('movement');
  await cursor.moveTo(page.locator('#launch'), { durationMs: 900 });
  await cursor.moveTo(page.locator('#walkthrough'), { durationMs: 900 });
  await cursor.moveTo(page.locator('#launch'), { durationMs: 900 });
  await hold('movement');
  await expect(locatorCircle).toHaveCount(0);

  await explain('03 / CLICK FEEDBACK', 'Mark the moment of a click.',
    'A circle contracts toward the click point, then disappears. It marks both where and when the click happened.',
    'await cursor.click(target);\n// Brief 700 ms locator circle');
  narration.mark('clicks');
  await cursor.click(page.locator('#launch'));
  await expect(page.locator('#launch')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(750);
  await cursor.click(page.locator('#walkthrough'));
  await expect(page.locator('#walkthrough')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(750);
  await cursor.click(page.locator('#select'));
  await expect(page.getByRole('status')).toHaveText('Feature walkthrough is ready to record.');
  await hold('clicks');

  await explain('04 / MULTIPLE OVERLAYS', 'Three overlays. One action.',
    'Three overlays stay visible as the pointer moves. A brief circle marks each click, then leaves the view clear.',
    "withOverlay(page, scene, action)\n// Nest for simultaneous cues\n// One overlay per zone");
  narration.mark('overlays');
  // Each zone has one slot. Nest withOverlay calls in DIFFERENT zones to
  // keep them all visible during the action and clean up even if it fails.
  await page.locator('body').evaluate(body => body.classList.add('overlay-scene'));
  await withOverlay(page, 'overlays', async () => {
    await withOverlay(page, 'overlays', {
      type: 'lower-third', text: 'Choose a story. Follow the cursor.',
      placement: 'bottom-left', motion: 'slide-in',
    }, async () => {
      await withOverlay(page, 'overlays', {
        type: 'arrow', direction: 'up-left', label: 'Try a card',
        color: '#78dab9', size: 40, placement: 'bottom-right', motion: 'fade-in', autoBackground: true,
      }, async () => {
        await expect(page.locator('[id^="argo-overlay-"][data-argo-instance]')).toHaveCount(3);
        await expect(ring).toBeHidden();
        await expect(pointer.locator('svg')).toBeVisible();
        await cursor.click(page.locator('#launch'));
        await expect(page.locator('#launch')).toHaveAttribute('aria-pressed', 'true');
        await page.waitForTimeout(800);
        await cursor.click(page.locator('#select'));
        await expect(page.getByRole('status')).toHaveText('Product launch is ready to record.');
        await page.waitForTimeout(narration.durationFor('overlays', { fallbackMs: 3500 }));
      });
    });
  });
  await expect(page.locator('[id^="argo-overlay-"][data-argo-instance]')).toHaveCount(0);
  await page.locator('body').evaluate(body => body.classList.remove('overlay-scene'));

  // Click the real link: its default action creates a new document.
  await cursor.click(page.locator('#next'));
  await expect(page).toHaveURL('http://pseudo-cursor.test/review');
  if (!process.env.ARGO_CURSOR_HIGHLIGHT) await cursorHighlight(page, { mode: 'click', radius: 24, opacity: 0.9 });
  await expect(ring).toBeHidden();
  await expect(pointer.locator('svg')).toBeVisible();
  narration.mark('navigation');
  await cursor.moveTo(page.locator('#walkthrough'));
  await expect(ring).toHaveCSS('left', await pointer.evaluate(el => (el as HTMLElement).style.left));
  await hold('navigation');

  await explain('06 / LOCATE THE POINTER', 'Find it with Control.',
    'Release Control to briefly highlight the pointer location without clicking. The circle contracts and fades away.',
    "await page.keyboard.press(\n  'Control'\n); // Locate without clicking");
  narration.mark('locate');
  await page.keyboard.press('Control');
  await page.waitForTimeout(1100);
  await page.keyboard.press('Control');
  await hold('locate');
  await expect(locatorCircle).toHaveCount(0);

  await explain('07 / CUSTOM CLICK STYLE', 'A different accent. Same cue.',
    'Orange locator circles now mark clicks. Between clicks, only the white SVG pointer is visible.',
    "await cursorHighlight(page, {\n  color: '#f97316',\n  mode: 'click', radius: 28,\n  clickRipple: true\n});");
  narration.mark('customize');
  await cursorHighlight(page, { mode: 'click', color: '#f97316', radius: 28, clickRipple: true, opacity: 0.85 });
  await cursor.moveTo(page.locator('#walkthrough'));
  await expect(ring).toBeHidden();
  await expect(ring).toHaveCSS('border-top-color', 'rgb(249, 115, 22)');
  await cursor.click(page.locator('#launch'));
  await page.waitForTimeout(750);
  await cursor.click(page.locator('#select'));
  await hold('customize');

  await explain('08 / CLEAN FINISH', 'Leave the stage clear.',
    'The click circle has already faded. Remove the pointer and its event listeners when the demonstration is over.',
    'await cursor.dispose();\nawait resetCursor(page);');
  narration.mark('outro');
  await resetCursor(page);
  await cursor.dispose();
  await expect(ring).toHaveCount(0);
  await expect(pointer).toHaveCount(0);
  await hold('outro');
});
