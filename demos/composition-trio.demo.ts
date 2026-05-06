// Renders three hyperframes blocks back-to-back as a demo of the
// renderComposition primitive against real catalog blocks (no Canary
// required). Validates that compositional crossover works for the
// stable-chromium subset of the hyperframes catalog.
//
// Block install (one-time, requires Node 22+ for the hyperframes CLI):
//   PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx hyperframes add apple-money-count
//   PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx hyperframes add blue-sweater-intro-video
//
// All composition + asset files are gitignored — install per checkout.
import { test } from '@argo-video/cli';
import { renderComposition } from '@argo-video/cli';

test('composition-trio', async ({ page, narration }) => {
  test.setTimeout(120_000);

  // Don't call startRecording here — the first renderComposition call will
  // start it after that composition's warmup so the recording's first
  // frame is the first animated frame.

  // Block 1 — blue-sweater-intro-video (12s) — AI creator intro card.
  await renderComposition(page, narration, 'compositions/blue-sweater-intro-video.html', {
    scene: 'blue-sweater-intro-video',
  });

  // Block 2 — apple-money-count (5s) — finance counter with money burst.
  await renderComposition(page, narration, 'compositions/apple-money-count.html', {
    scene: 'apple-money-count',
  });
});
