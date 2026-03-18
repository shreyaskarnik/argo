/**
 * Demo: Argo new features — scene transitions, speed ramp, GIF export,
 * batch pipeline, dashboard, and export progress bar.
 *
 * Prerequisites:
 *   1. Serve the HTML:  python3 -m http.server 8976 --directory demos
 *   2. Run pipeline:    BASE_URL=http://127.0.0.1:8976 npx tsx bin/argo.js pipeline new-features --browser webkit
 */
import { test } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';
import { cursorHighlight } from '@argo-video/cli';

test('new-features', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/new-features.html');
  cursorHighlight(page, { color: '#3b82f6', radius: 18 });
  await page.waitForTimeout(800);

  // Scene 1: Hero — introduce the release
  narration.mark('hero');
  await showOverlay(page, 'hero', narration.durationFor('hero', { maxMs: 8000 }));

  // Scene 2: Feature overview — dim each card in turn
  narration.mark('overview');
  await page.locator('#overview').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'overview', async () => {
    const cardDur = Math.floor(narration.durationFor('overview') / 6);
    await dimAround(page, '#card-transitions', { duration: cardDur, wait: true });
    await dimAround(page, '#card-speed-ramp', { duration: cardDur, wait: true });
    await dimAround(page, '#card-gif', { duration: cardDur, wait: true });
    await dimAround(page, '#card-batch', { duration: cardDur, wait: true });
    await dimAround(page, '#card-dashboard', { duration: cardDur, wait: true });
    await dimAround(page, '#card-progress', { duration: cardDur, wait: true });
    await resetCamera(page);
  });

  // Scene 3: Transitions — zoom into each type
  narration.mark('transitions');
  await page.locator('#transitions').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'transitions', async () => {
    const tDur = Math.floor(narration.durationFor('transitions') / 4);
    await focusRing(page, '#t-fade', { color: '#3b82f6', duration: tDur, wait: true });
    await focusRing(page, '#t-dissolve', { color: '#8b5cf6', duration: tDur, wait: true });
    await focusRing(page, '#t-wipe-left', { color: '#06b6d4', duration: tDur, wait: true });
    await focusRing(page, '#t-wipe-right', { color: '#f59e0b', duration: tDur, wait: true });
  });

  // Scene 4: Speed ramp — spotlight the timeline then the config
  narration.mark('speed-ramp');
  await page.locator('#speed-ramp').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const rampDur = narration.durationFor('speed-ramp');
  spotlight(page, '.speed-timeline', { duration: Math.floor(rampDur / 2), padding: 12 });
  await page.waitForTimeout(Math.floor(rampDur / 2));
  spotlight(page, '.speed-config', { duration: Math.floor(rampDur / 2), padding: 8 });
  await showOverlay(page, 'speed-ramp', Math.floor(rampDur / 2));

  // Scene 5: Multi-format export — highlight each format card
  narration.mark('formats');
  await page.locator('#formats').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'formats', async () => {
    const fmtDur = Math.floor(narration.durationFor('formats') / 3);
    await zoomTo(page, '#fmt-square', { scale: 1.3, duration: fmtDur, wait: true });
    await zoomTo(page, '#fmt-vertical', { scale: 1.3, duration: fmtDur, wait: true });
    await zoomTo(page, '#fmt-gif', { scale: 1.3, duration: fmtDur, wait: true });
    await resetCamera(page);
  });

  // Scene 6: Batch pipeline — zoom into terminal output
  narration.mark('batch');
  await page.locator('#batch').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'batch', async () => {
    const bDur = Math.floor(narration.durationFor('batch') / 2);
    spotlight(page, '#batch-pipeline', { duration: bDur, padding: 12 });
    await page.waitForTimeout(bDur);
    spotlight(page, '#batch-dashboard', { duration: bDur, padding: 12 });
    await page.waitForTimeout(bDur);
  });

  // Scene 7: Progress bar — let the animated bar run
  narration.mark('progress');
  await page.locator('#progress').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  focusRing(page, '#progress-bar', { color: '#06b6d4', duration: narration.durationFor('progress') });
  await showOverlay(page, 'progress', narration.durationFor('progress'));

  // Scene 8: Closing — confetti + CTA
  narration.mark('closing');
  await page.locator('#cta').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  showConfetti(page, { spread: 'burst', duration: 3000, pieces: 200 });
  await showOverlay(page, 'closing', narration.durationFor('closing', { minMs: 3000, leadOutMs: 600 }));
});
