/**
 * Canonical showcase demo.
 *
 * Each scene maps to a major Argo capability cluster so one recording can tell
 * the full product story without fragmenting into multiple demos.
 *
 * Prerequisites:
 *   1. Serve the HTML:  python3 -m http.server 8976 --directory demos
 *   2. Run pipeline:    npx tsx bin/argo.js pipeline showcase --config demos/showcase.config.mjs
 *   3. Optional clips:  npx argo release-prep showcase --gif
 */
import { test, demoType } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, resetCamera } from '@argo-video/cli';
import { cursorHighlight, resetCursor } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(300_000);
  await page.goto('/showcase.html');
  cursorHighlight(page, { color: '#60a5fa', radius: 18 });
  await page.waitForTimeout(700);

  narration.mark('hero');
  spotlight(page, '#hero-command', { duration: 4800, padding: 18 });
  await showOverlay(page, 'hero', narration.durationFor('hero', { maxMs: 7800 }));

  narration.mark('authoring');
  await page.locator('#authoring').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'authoring', async () => {
    const totalMs = narration.durationFor('authoring', { maxMs: 9200 }) - 400;
    const beat = Math.floor(totalMs / 4);
    await focusRing(page, '#step-from', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#authoring-manifest', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#authoring-silent', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#authoring-duration', { color: '#f59e0b', duration: beat, wait: true });
  });

  narration.mark('voiceover');
  await page.locator('#voiceover').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'voiceover', async () => {
    const totalMs = narration.durationFor('voiceover', { maxMs: 10000 }) - 400;
    const beat = Math.floor(totalMs / 8);
    await dimAround(page, '#engine-kokoro', { duration: beat, wait: true });
    await dimAround(page, '#engine-transformers', { duration: beat, wait: true });
    await dimAround(page, '#engine-mlx', { duration: beat, wait: true });
    await dimAround(page, '#engine-openai', { duration: beat, wait: true });
    await dimAround(page, '#engine-elevenlabs', { duration: beat, wait: true });
    await dimAround(page, '#engine-gemini', { duration: beat, wait: true });
    await dimAround(page, '#engine-sarvam', { duration: beat, wait: true });
    await focusRing(page, '#voiceover-config', { color: '#22d3ee', duration: beat, wait: true });
    await resetCamera(page);
  });

  narration.mark('preview');
  await page.locator('#preview-editor').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'preview', async () => {
    // 5 beats: command, type, scrubber, regen, export
    // demoType takes ~1.8s for the text (30 chars * 60ms), so give it a beat
    const totalMs = narration.durationFor('preview', { maxMs: 9000 }) - 400;
    const beat = Math.floor(totalMs / 5);
    await focusRing(page, '#preview-command', { color: '#60a5fa', duration: beat, wait: true });
    await demoType(page, '#preview-text-field', 'Tighten the preview voice line.');
    await page.waitForTimeout(Math.max(0, beat - 1800)); // demoType takes ~1.8s
    await focusRing(page, '#preview-scrubber', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#preview-regen', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#preview-export', { color: '#4ade80', duration: beat, wait: true });
  });

  narration.mark('camera');
  await page.locator('#camera-effects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  // Total scene time = durationFor. Divide evenly across 5 effects.
  // Each beat includes the effect duration + a small gap.
  const totalCameraMs = narration.durationFor('camera', { maxMs: 9000 });
  const cameraGap = 150;
  const cameraBeat = Math.floor((totalCameraMs - 400) / 5) - cameraGap;
  spotlight(page, '#effect-spotlight', { duration: cameraBeat, padding: 10 });
  await page.waitForTimeout(cameraBeat + cameraGap);
  focusRing(page, '#effect-focus-ring', { color: '#fb7185', duration: cameraBeat });
  await page.waitForTimeout(cameraBeat + cameraGap);
  dimAround(page, '#effect-dim-around', { duration: cameraBeat });
  await page.waitForTimeout(cameraBeat + cameraGap);
  focusRing(page, '#effect-cursor', { color: '#60a5fa', duration: cameraBeat });
  await page.waitForTimeout(cameraBeat + cameraGap);
  showConfetti(page, { spread: 'rain', duration: cameraBeat, pieces: 130 });
  await page.waitForTimeout(cameraBeat + cameraGap);
  await resetCamera(page);

  narration.mark('export');
  await page.locator('#export-stack').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'export', async () => {
    const totalMs = narration.durationFor('export', { maxMs: 9000 }) - 400;
    const beat = Math.floor(totalMs / 5);
    await focusRing(page, '#export-config', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#export-transitions', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#export-speed-ramp', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#export-formats', { color: '#4ade80', duration: beat, wait: true });
    await focusRing(page, '#export-report', { color: '#f59e0b', duration: beat, wait: true });
  });

  narration.mark('ops');
  await page.locator('#ops').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'ops', async () => {
    const totalMs = narration.durationFor('ops', { maxMs: 8200 }) - 400;
    const beat = Math.floor(totalMs / 4);
    await focusRing(page, '#ops-batch', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#ops-dashboard', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#ops-validate', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#ops-doctor', { color: '#4ade80', duration: beat, wait: true });
  });

  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  focusRing(page, '#demo-script-card', { color: '#22d3ee', duration: narration.durationFor('code', { maxMs: 7600 }) });
  await showOverlay(page, 'code', narration.durationFor('code', { maxMs: 7600 }));

  narration.mark('closing');
  // Scroll CTA to center of viewport, not just into view
  await page.evaluate(() => {
    const cta = document.querySelector('#cta');
    if (cta) cta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await page.waitForTimeout(800);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1200 });
  await page.waitForTimeout(650);
  await page.click('#theme-toggle');
  await page.waitForTimeout(650);
  await showOverlay(page, 'closing', narration.durationFor('closing', { maxMs: 8200, leadOutMs: 700 }));

  // Mic-drop stays on the CTA section — no scroll, just confetti
  narration.mark('mic-drop');
  await resetCamera(page);
  resetCursor(page);
  showConfetti(page, { emoji: ['🎬', '🚀', '✨'], spread: 'burst', duration: 3200, pieces: 200 });
  await showOverlay(page, 'mic-drop', narration.durationFor('mic-drop', { minMs: 3000, leadOutMs: 500 }));
});
