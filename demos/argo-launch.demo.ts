// Argo × Hyperframes crossover demo (Plan A — tight launch teaser).
//
// Three-scene structure:
//   1. argo-launch-intro composition (4s, hand-rolled, hyperframes contract)
//   2. recorded Argo showcase hero (8s, the real running app)
//   3. argo-launch-outro composition (3s, hand-rolled)
//
// Total ~15s. Demonstrates the crossover seam: composition scenes book-end
// a real Playwright recording in a single argo pipeline invocation.
//
// Prerequisite: showcase server running —
//   python3 -m http.server 8976 --directory demos
//
// Run: BASE_URL=http://127.0.0.1:8976 \
//   npx argo pipeline argo-launch --config demos/argo-launch.config.mjs
import { test } from '@argo-video/cli';
import { renderComposition, spotlight, focusRing, resetCamera } from '@argo-video/cli';

test('argo-launch', async ({ page, narration }) => {
  test.setTimeout(120_000);

  // Scene 1 — intro composition. Starts recording itself after the
  // composition is ready, so the recording's first frame is the intro's
  // first animated frame.
  await renderComposition(page, narration, 'compositions/argo-launch-intro.html', {
    scene: 'intro',
  });

  // Scene 2 — recorded Argo showcase hero. The recording is already active
  // from the intro composition; just navigate to the showcase and let
  // CDP-direct capture the page.
  await page.goto('/showcase.html');
  await page.waitForTimeout(400);
  narration.mark('hero');
  spotlight(page, '#hero-command', { duration: 5000, padding: 18 });
  focusRing(page, '#hero', { color: '#60a5fa', duration: 3500 });
  await page.waitForTimeout(7600);
  await resetCamera(page);

  // Scene 3 — outro composition.
  await renderComposition(page, narration, 'compositions/argo-launch-outro.html', {
    scene: 'outro',
  });
});
