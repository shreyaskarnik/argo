import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/showcase.html');
  await page.waitForTimeout(1500);

  // Scene 1: Hero section — ~12s for voiceover
  narration.mark('hero');
  await showOverlay(page, 'hero', {
    type: 'lower-third',
    text: 'Argo — Demo videos, automated',
    placement: 'top-left',
    motion: 'fade-in',
  }, 12000);

  // Scene 2: How it works — ~14s for voiceover about 3 steps
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Three Simple Steps',
    body: 'Write a script. Record the browser. Export the video.',
    placement: 'top-right',
    motion: 'slide-in',
  }, async () => {
    await page.waitForTimeout(14000);
  });

  // Scene 3: Features — ~12s for voiceover
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await showOverlay(page, 'features', {
    type: 'callout',
    text: 'Overlays, voiceover, and more',
    placement: 'top-left',
    motion: 'fade-in',
  }, 12000);

  // Scene 4: Code example — ~12s for voiceover
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await showOverlay(page, 'code', {
    type: 'lower-third',
    text: 'Familiar Playwright API — nothing new to learn',
    placement: 'top-left',
    motion: 'fade-in',
  }, 12000);

  // Scene 5: Closing — ~12s for voiceover + 4th wall break
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'top-right',
    motion: 'fade-in',
  }, 12000);
});
