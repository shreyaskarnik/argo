/**
 * Example Argo demo script — use as a starting template.
 *
 * Key points:
 * - Import `test` from '@argo-video/cli', NOT '@playwright/test'
 * - Every scene in the .scenes.json manifest needs a matching narration.mark()
 * - Use durationFor() instead of hardcoded waitForTimeout values
 * - Code before the first mark() is auto-trimmed from the final video
 */
import { test } from '@argo-video/cli';
import {
  showOverlay,
  withOverlay,
  spotlight,
  showConfetti,
  cursorHighlight,
  resetCursor,
  resetCamera,
  demoType,
} from '@argo-video/cli';
// Also available: focusRing, dimAround, zoomTo, hideOverlay

test('my-demo', async ({ page, narration }) => {
  // Extend timeout for demos longer than 30s
  test.setTimeout(90_000);

  // --- OFF-CAMERA SETUP (auto-trimmed from final video) ---
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Optional: enable cursor highlight for the whole recording
  cursorHighlight(page, { color: '#3b82f6', radius: 20 });

  // --- ON-CAMERA: Scene 1 — Intro ---
  narration.mark('intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  // --- Scene 2 — Feature walkthrough ---
  narration.mark('feature');
  const featureDur = narration.durationFor('feature');

  // Camera effect timed to voiceover
  spotlight(page, '#main-feature', { duration: Math.floor(featureDur / 2) });

  await withOverlay(page, 'feature', async () => {
    await page.waitForTimeout(featureDur);
  });

  // --- Scene 3 — Demo interaction ---
  narration.mark('interaction');
  await demoType(page, page.getByLabel('Search'), 'hello world');
  await page.waitForTimeout(narration.durationFor('interaction'));

  // --- Scene 4 — Closing ---
  narration.mark('closing');
  resetCamera(page);
  resetCursor(page);
  showConfetti(page, { spread: 'burst' });
  await showOverlay(page, 'closing', narration.durationFor('closing'));
});
