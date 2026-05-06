// Imports a hyperframes block via `npx hyperframes add vfx-iphone-device`
// and renders it as an Argo composition scene. Proves the A+B crossover
// shapes — shared composition contract and renderComposition embedding —
// against a real hyperframes block (not a hand-rolled sample).
//
// Block install (one-time):
//   /opt/homebrew/opt/node@22/bin/node node_modules/hyperframes/dist/cli.js \
//     add vfx-iphone-device
import { test } from '@argo-video/cli';
import { renderComposition } from '@argo-video/cli';

test('composition-iphone', async ({ page, narration }) => {
  test.setTimeout(60_000);

  await narration.startRecording(page);

  // Block uses html-in-canvas (CanvasDrawElement). Requires
  // experimentalCanvasDrawElement: true + browserChannel: 'chrome-canary'
  // in the config. Block's data-duration is 15s.
  await renderComposition(page, narration, 'compositions/vfx-iphone-device.html', {
    scene: 'iphone-showcase',
    // ready signal mismatch: hyperframes block uses internal paintReady
    // flag rather than window.__compositionReady — we wait through the
    // readyTimeoutMs and rely on data-duration to size the scene window.
    readyTimeoutMs: 12_000,
  });
});
