import { test, demoType } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(160000);
  await page.goto('/showcase.html');
  await page.waitForTimeout(800);

  // Scene 1: Hero — spotlight + voiceover together
  narration.mark('hero');
  spotlight(page, '#hero-command', { duration: 5000, padding: 16 });
  await showOverlay(page, 'hero', {
    type: 'headline-card',
    kicker: 'PLAYWRIGHT TO VIDEO',
    title: 'One command. Full demo.',
    body: 'AI voiceover and camera direction included.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('hero', { maxMs: 8000 }));

  // Scene 2: How it works — voiceover plays WHILE zooming through steps
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Write. Record. Export.',
    placement: 'top-left',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    const stepDur = Math.floor(narration.durationFor('how-it-works') / 4);
    await zoomTo(page, '#step-write', { scale: 1.22, duration: stepDur, wait: true });
    await zoomTo(page, '#step-record', { scale: 1.22, duration: stepDur, wait: true });
    await zoomTo(page, '#step-export', { scale: 1.22, duration: stepDur, wait: true });
    await resetCamera(page);
  });

  // Scene 3: Features — dim each card in sync with voiceover
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'features', {
    type: 'callout',
    text: 'Overlays, voiceover, camera, and pipeline',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    const cardDur = Math.floor(narration.durationFor('features') / 5);
    await dimAround(page, '#feature-overlays', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-voiceover', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-camera', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-pipeline', { duration: cardDur, wait: true });
    await resetCamera(page);
  });

  // Scene 4: TTS engines — dim each engine card in sync
  narration.mark('tts');
  await page.locator('#tts-engines').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'tts', {
    type: 'lower-third',
    text: 'Six TTS engines — swap with one config line',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    const engDur = Math.floor(narration.durationFor('tts') / 7);
    await dimAround(page, '#engine-kokoro', { duration: engDur, wait: true });
    await dimAround(page, '#engine-mlx', { duration: engDur, wait: true });
    await dimAround(page, '#engine-openai', { duration: engDur, wait: true });
    await dimAround(page, '#engine-elevenlabs', { duration: engDur, wait: true });
    await dimAround(page, '#engine-gemini', { duration: engDur, wait: true });
    await dimAround(page, '#engine-sarvam', { duration: engDur, wait: true });
    await resetCamera(page);
  });

  // Scene 5: Camera effects — demo each effect timed to voiceover
  narration.mark('camera');
  await page.locator('#camera-effects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const totalCamMs = narration.durationFor('camera');
  const camDur = Math.floor(totalCamMs / 4);
  spotlight(page, '#effect-spotlight', { duration: camDur, padding: 8 });
  await page.waitForTimeout(camDur + 500);
  focusRing(page, '#effect-focus-ring', { color: '#ef4444', duration: camDur });
  await page.waitForTimeout(camDur + 500);
  dimAround(page, '#effect-dim-around', { duration: camDur });
  await page.waitForTimeout(camDur + 500);
  focusRing(page, '#effect-zoom-to', { color: '#3b82f6', duration: camDur });
  await page.waitForTimeout(camDur + 500);

  // Scene 6: Code — zoom into demo script
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  focusRing(page, '#demo-script-code', { color: '#06b6d4', duration: narration.durationFor('code') });
  await showOverlay(page, 'code', {
    type: 'lower-third',
    text: 'All effects are one-liners in your Playwright script',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('code'));

  // Scene 7: Theme toggle — autoBackground adapts
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1200 });
  await page.waitForTimeout(600);
  await page.click('#theme-toggle');
  await page.waitForTimeout(600);
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('closing', { maxMs: 10000, leadOutMs: 600 }));

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
