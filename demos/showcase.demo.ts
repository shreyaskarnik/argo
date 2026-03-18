/**
 * Showcase demo — the canonical Argo feature tour.
 *
 * One demo to rule them all. Covers every major feature:
 * overlays (all 4 templates), camera effects, confetti (burst + rain + emoji),
 * TTS engines, transitions, multi-format export, batch, dashboard,
 * demoType, cursor highlight, and autoBackground.
 *
 * Prerequisites:
 *   1. Serve the HTML:  python3 -m http.server 8976 --directory demos
 *   2. Run pipeline:    npx tsx bin/argo.js pipeline showcase --config demos/showcase.config.mjs
 *   3. Extract clips:   npx argo release-prep showcase --gif
 */
import { test, demoType } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, resetCamera } from '@argo-video/cli';
import { cursorHighlight, resetCursor } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(300_000);
  await page.goto('/showcase.html');
  cursorHighlight(page, { color: '#6366f1', radius: 18 });
  await page.waitForTimeout(800);

  // Scene 1: Hero — spotlight the main command
  narration.mark('hero');
  spotlight(page, '#hero-command', { duration: 5000, padding: 16 });
  await showOverlay(page, 'hero', narration.durationFor('hero', { maxMs: 8000 }));

  // Scene 2: How it works — focus ring each step
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'how-it-works', async () => {
    const stepDur = Math.floor(narration.durationFor('how-it-works') / 4);
    await focusRing(page, '#step-write', { color: '#3b82f6', duration: stepDur, wait: true });
    await focusRing(page, '#step-record', { color: '#8b5cf6', duration: stepDur, wait: true });
    await focusRing(page, '#step-export', { color: '#06b6d4', duration: stepDur, wait: true });
  });

  // Scene 3: Features — dim each card
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'features', async () => {
    const cardDur = Math.floor(narration.durationFor('features') / 5);
    await dimAround(page, '#feature-overlays', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-voiceover', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-camera', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-pipeline', { duration: cardDur, wait: true });
    await resetCamera(page);
  });

  // Scene 4: TTS engines — dim each engine card
  narration.mark('tts');
  await page.locator('#tts-engines').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'tts', async () => {
    const engDur = Math.floor(narration.durationFor('tts') / 7);
    await dimAround(page, '#engine-kokoro', { duration: engDur, wait: true });
    await dimAround(page, '#engine-mlx', { duration: engDur, wait: true });
    await dimAround(page, '#engine-openai', { duration: engDur, wait: true });
    await dimAround(page, '#engine-elevenlabs', { duration: engDur, wait: true });
    await dimAround(page, '#engine-gemini', { duration: engDur, wait: true });
    await dimAround(page, '#engine-sarvam', { duration: engDur, wait: true });
    await resetCamera(page);
  });

  // Scene 5: Camera effects — demonstrate each effect
  narration.mark('camera');
  await page.locator('#camera-effects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const camDur = Math.floor(narration.durationFor('camera') / 4);
  spotlight(page, '#effect-spotlight', { duration: camDur, padding: 8 });
  await page.waitForTimeout(camDur + 300);
  focusRing(page, '#effect-focus-ring', { color: '#ef4444', duration: camDur });
  await page.waitForTimeout(camDur + 300);
  dimAround(page, '#effect-dim-around', { duration: camDur });
  await page.waitForTimeout(camDur + 300);
  // Rain confetti during camera scene for variety
  showConfetti(page, { spread: 'rain', duration: camDur, pieces: 100 });
  await page.waitForTimeout(camDur + 300);

  // Scene 6: Code — focus ring the demo script
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  focusRing(page, '#demo-script-code', { color: '#06b6d4', duration: narration.durationFor('code') });
  await showOverlay(page, 'code', narration.durationFor('code'));

  // Scene 7: Transitions (overlay-only — the config enables actual transitions)
  // Content change happens BEFORE mark() so the transition fades between scenes
  await page.locator('#hero').scrollIntoViewIfNeeded();
  narration.mark('transitions');
  await page.waitForTimeout(300);
  await showOverlay(page, 'transitions', narration.durationFor('transitions'));

  // Scene 8: Multi-format export
  narration.mark('formats');
  await page.waitForTimeout(200);
  await showOverlay(page, 'formats', narration.durationFor('formats'));

  // Scene 9: Batch + dashboard
  narration.mark('batch');
  await page.waitForTimeout(200);
  await showOverlay(page, 'batch', narration.durationFor('batch'));

  // Scene 10: Theme toggle — autoBackground adapts
  narration.mark('closing');
  await page.waitForTimeout(300);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1200 });
  await page.waitForTimeout(600);
  await page.click('#theme-toggle');
  await page.waitForTimeout(600);
  await showOverlay(page, 'closing', narration.durationFor('closing', { maxMs: 10000, leadOutMs: 600 }));

  // Scene 11: Mic drop — emoji confetti
  narration.mark('mic-drop');
  resetCamera(page);
  resetCursor(page);
  showConfetti(page, { emoji: ['🎬', '🚀', '✨'], spread: 'burst', duration: 3000, pieces: 180 });
  await showOverlay(page, 'mic-drop', narration.durationFor('mic-drop', { minMs: 2800, leadOutMs: 400 }));
});
