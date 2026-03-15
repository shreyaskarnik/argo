import { test, demoType } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(160000);
  await page.goto('/showcase.html');
  await page.waitForTimeout(800);

  // Scene 1: Hero — spotlight the terminal command
  narration.mark('hero');
  spotlight(page, '#hero-command', { duration: 4000, padding: 16 });
  await showOverlay(page, 'hero', {
    type: 'headline-card',
    kicker: 'PLAYWRIGHT TO VIDEO',
    title: 'One command. Full demo.',
    body: 'Argo turns Playwright scripts into polished product videos with AI voiceover.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('hero', { maxMs: 7000 }));

  // Scene 2: How it works — zoom into each step
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Write. Record. Export.',
    body: 'Camera effects guide the viewer through each step.',
    placement: 'top-left',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    await zoomTo(page, '#step-write', { scale: 1.22, duration: 1700, wait: true });
    await zoomTo(page, '#step-record', { scale: 1.22, duration: 1700, wait: true });
    await zoomTo(page, '#step-export', { scale: 1.22, duration: 1700, wait: true });
    await resetCamera(page);
  });

  // Scene 3: Features — dim-around each card
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await withOverlay(page, 'features', {
    type: 'callout',
    text: 'Four pillars — overlays, voiceover, camera, and pipeline',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    await dimAround(page, '#feature-overlays', { duration: 1300, wait: true });
    await dimAround(page, '#feature-voiceover', { duration: 1300, wait: true });
    await dimAround(page, '#feature-camera', { duration: 1300, wait: true });
    await dimAround(page, '#feature-pipeline', { duration: 1300, wait: true });
    await resetCamera(page);
  });

  // Scene 4: TTS engines — scroll to section, highlight each engine
  narration.mark('tts');
  await page.locator('#tts-engines').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await withOverlay(page, 'tts', {
    type: 'lower-third',
    text: 'Six TTS engines — swap with one config line',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    await dimAround(page, '#engine-kokoro', { duration: 1000, wait: true });
    await dimAround(page, '#engine-openai', { duration: 1000, wait: true });
    await dimAround(page, '#engine-elevenlabs', { duration: 1000, wait: true });
    await dimAround(page, '#engine-gemini', { duration: 1000, wait: true });
    await dimAround(page, '#engine-sarvam', { duration: 1000, wait: true });
    await dimAround(page, '#engine-mlx', { duration: 1000, wait: true });
    await resetCamera(page);
  });

  // Scene 5: Camera effects section — demo each effect on its own card
  narration.mark('camera');
  await page.locator('#camera-effects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  spotlight(page, '#effect-spotlight', { duration: 2000, padding: 8 });
  await page.waitForTimeout(2200);
  focusRing(page, '#effect-focus-ring', { color: '#ef4444', duration: 2000 });
  await page.waitForTimeout(2200);
  dimAround(page, '#effect-dim-around', { duration: 2000 });
  await page.waitForTimeout(2200);
  await zoomTo(page, '#effect-zoom-to', { scale: 1.2, duration: 2000, wait: true });
  await resetCamera(page);
  await showOverlay(page, 'camera', {
    type: 'callout',
    text: 'Each effect demonstrated on its own card',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('camera', { minMs: 2000, maxMs: 4000 }));

  // Scene 6: Code — zoom into the demo script
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await withOverlay(page, 'code', {
    type: 'lower-third',
    text: 'Familiar Playwright API — all effects are one-liners',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    await zoomTo(page, '#demo-script-code', { scale: 1.15, duration: 2500, wait: true });
    await resetCamera(page);
  });

  // Scene 7: Toggle to light mode — show autoBackground adapting
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1500 });
  await page.waitForTimeout(500);
  await page.click('#theme-toggle');
  await page.waitForTimeout(800);
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('closing', { maxMs: 10000, leadOutMs: 800 }));

  // Scene 8: Mic drop
  narration.mark('mic-drop');
  showConfetti(page, { spread: 'burst', duration: 3000, pieces: 180 });
  await showOverlay(page, 'mic-drop', {
    type: 'lower-third',
    text: 'This demo was recorded by Argo, using Argo.',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('mic-drop', { minMs: 2800, leadOutMs: 400 }));
});
