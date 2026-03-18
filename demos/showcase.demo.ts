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
  await page.waitForTimeout(450);
  await withOverlay(page, 'authoring', async () => {
    const beat = Math.max(1200, Math.floor(narration.durationFor('authoring', { maxMs: 9200 }) / 4));
    await focusRing(page, '#step-from', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#authoring-manifest', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#authoring-silent', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#authoring-duration', { color: '#f59e0b', duration: beat, wait: true });
  });

  narration.mark('voiceover');
  await page.locator('#voiceover').scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  await withOverlay(page, 'voiceover', async () => {
    const beat = Math.max(800, Math.floor(narration.durationFor('voiceover', { maxMs: 10000 }) / 8));
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
  await page.waitForTimeout(500);
  await withOverlay(page, 'preview', async () => {
    await focusRing(page, '#preview-command', { color: '#60a5fa', duration: 1100, wait: true });
    await demoType(page, '#preview-text-field', 'Tighten the preview voice line.');
    await focusRing(page, '#preview-scrubber', { color: '#22d3ee', duration: 1000, wait: true });
    await focusRing(page, '#preview-regen', { color: '#a78bfa', duration: 1000, wait: true });
    await focusRing(page, '#preview-export', { color: '#4ade80', duration: 1100, wait: true });
  });

  narration.mark('camera');
  await page.locator('#camera-effects').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const cameraBeat = Math.max(950, Math.floor(narration.durationFor('camera', { maxMs: 8800 }) / 5));
  spotlight(page, '#effect-spotlight', { duration: cameraBeat, padding: 10 });
  await page.waitForTimeout(cameraBeat + 220);
  focusRing(page, '#effect-focus-ring', { color: '#fb7185', duration: cameraBeat });
  await page.waitForTimeout(cameraBeat + 220);
  dimAround(page, '#effect-dim-around', { duration: cameraBeat });
  await page.waitForTimeout(cameraBeat + 220);
  focusRing(page, '#effect-cursor', { color: '#60a5fa', duration: cameraBeat });
  await page.waitForTimeout(cameraBeat + 220);
  showConfetti(page, { spread: 'rain', duration: cameraBeat, pieces: 130 });
  await page.waitForTimeout(cameraBeat + 260);
  await resetCamera(page);

  narration.mark('export');
  await page.locator('#export-stack').scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  await withOverlay(page, 'export', async () => {
    const beat = Math.max(1000, Math.floor(narration.durationFor('export', { maxMs: 9000 }) / 5));
    await focusRing(page, '#export-config', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#export-transitions', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#export-speed-ramp', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#export-formats', { color: '#4ade80', duration: beat, wait: true });
    await focusRing(page, '#export-report', { color: '#f59e0b', duration: beat, wait: true });
  });

  narration.mark('ops');
  await page.locator('#ops').scrollIntoViewIfNeeded();
  await page.waitForTimeout(450);
  await withOverlay(page, 'ops', async () => {
    const beat = Math.max(1000, Math.floor(narration.durationFor('ops', { maxMs: 8200 }) / 4));
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
  await page.locator('#cta').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1200 });
  await page.waitForTimeout(650);
  await page.click('#theme-toggle');
  await page.waitForTimeout(650);
  await showOverlay(page, 'closing', narration.durationFor('closing', { maxMs: 8200, leadOutMs: 700 }));

  narration.mark('mic-drop');
  await resetCamera(page);
  resetCursor(page);
  showConfetti(page, { emoji: ['🎬', '🚀', '✨'], spread: 'burst', duration: 3200, pieces: 200 });
  await showOverlay(page, 'mic-drop', narration.durationFor('mic-drop', { minMs: 3000, leadOutMs: 500 }));
});
