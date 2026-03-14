import { test } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';

test('hello-world', async ({ page, narration }) => {
  test.setTimeout(60000);
  await page.goto('/app.html');
  await page.waitForTimeout(800);

  // Scene 1: Hero section
  narration.mark('hero');
  await showOverlay(page, 'hero', {
    type: 'lower-third',
    text: 'Argo — Demo videos, automated',
    placement: 'top-left',
    motion: 'fade-in',
  }, narration.durationFor('hero'));

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
  }, async () => {
    await page.waitForTimeout(narration.durationFor('how-it-works'));
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
  }, narration.durationFor('features'));

  // Scene 4: Closing with confetti
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  showConfetti(page, { spread: 'burst', duration: 3000 });
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'top-right',
    motion: 'fade-in',
  }, narration.durationFor('closing', { maxMs: 6000 }));
});
