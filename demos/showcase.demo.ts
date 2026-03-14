import { test } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/showcase.html');
  await page.waitForTimeout(800);

  // Scene 1: Hero — spotlight the terminal command
  narration.mark('hero');
  spotlight(page, '.terminal-box', { duration: 4000, padding: 16 });
  await showOverlay(page, 'hero', {
    type: 'lower-third',
    text: 'Argo — Demo videos, automated',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('hero', { maxMs: 6000 }));

  // Scene 2: How it works — zoom into each step
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Three Simple Steps',
    body: 'Write. Record. Export.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    // Highlight each step in sequence
    await zoomTo(page, '.step:nth-child(1)', { scale: 1.3, duration: 2000, wait: true });
    await zoomTo(page, '.step:nth-child(2)', { scale: 1.3, duration: 2000, wait: true });
    await zoomTo(page, '.step:nth-child(3)', { scale: 1.3, duration: 2000, wait: true });
    await resetCamera(page);
  });

  // Scene 3: Features — dim around each feature card
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  dimAround(page, '.feature-card:nth-child(1)', { duration: 3000 });
  await showOverlay(page, 'features', {
    type: 'callout',
    text: 'Overlays, voiceover, camera effects, and more',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('features', { maxMs: 5500 }));

  // Scene 4: Code — focus ring on the code block
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  focusRing(page, '#code-example pre', { color: '#06b6d4', duration: 4000 });
  await showOverlay(page, 'code', {
    type: 'lower-third',
    text: 'Familiar Playwright API — nothing new to learn',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('code', { maxMs: 6000 }));

  // Scene 5: Toggle to light mode — spotlight the toggle button
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1500, wait: true });
  await page.click('#theme-toggle');
  await page.waitForTimeout(800);
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('closing', { maxMs: 14000, leadOutMs: 800 }));

  // Scene 6: Mic drop — confetti + overlay together
  narration.mark('mic-drop');
  showConfetti(page, { spread: 'burst', duration: 3000 });
  await showOverlay(page, 'mic-drop', {
    type: 'lower-third',
    text: 'This demo was recorded by Argo, using Argo.',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('mic-drop', { minMs: 2800, leadOutMs: 400 }));
});
