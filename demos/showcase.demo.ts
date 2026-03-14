import { test } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/showcase.html');
  await page.waitForTimeout(800);

  // Scene 1: Hero section
  narration.mark('hero');
  await showOverlay(page, 'hero', {
    type: 'lower-third',
    text: 'Argo — Demo videos, automated',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('hero', { maxMs: 6000 }));

  // Scene 2: How it works
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Three Simple Steps',
    body: 'Write a script. Record the browser. Export the video.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    await page.waitForTimeout(narration.durationFor('how-it-works', { maxMs: 7000 }));
  });

  // Scene 3: Features
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await showOverlay(page, 'features', {
    type: 'callout',
    text: 'Overlays, voiceover, and more',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('features', { maxMs: 5500 }));

  // Scene 4: Code example
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await showOverlay(page, 'code', {
    type: 'lower-third',
    text: 'Familiar Playwright API — nothing new to learn',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('code', { maxMs: 6000 }));

  // Scene 5: Toggle to light mode and show overlay adapting
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
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
