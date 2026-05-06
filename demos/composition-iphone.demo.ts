// Imports a hyperframes block via `npx hyperframes add vfx-iphone-device`
// and renders it as an Argo composition scene. Proves the A+B crossover
// shapes — shared composition contract and renderComposition embedding —
// against a real hyperframes block (not a hand-rolled sample).
//
// Block install (one-time):
//   /opt/homebrew/opt/node@22/bin/node node_modules/hyperframes/dist/cli.js \
//     add vfx-iphone-device
import { writeFileSync, appendFileSync } from 'node:fs';
import { test } from '@argo-video/cli';
import { renderComposition } from '@argo-video/cli';

// Browser-side logs and errors are buffered by record.ts and only surfaced
// on a Playwright failure, so write them directly to disk for diagnosis
// during iteration. Tail with: tail -f /tmp/comp-iphone-browser.log
const LOG = '/tmp/comp-iphone-browser.log';
writeFileSync(LOG, '');

test('composition-iphone', async ({ page, narration }) => {
  test.setTimeout(60_000);

  // Forward all page console messages + errors to /tmp/comp-iphone-browser.log
  // since record.ts buffers stdout/stderr and only surfaces it on Playwright failure.
  page.on('console', (msg) => appendFileSync(LOG, `[${msg.type()}] ${msg.text()}\n`));
  page.on('pageerror', (err) => appendFileSync(LOG, `[pageerror] ${err.message}\n${err.stack ?? ''}\n`));
  page.on('requestfailed', (req) => appendFileSync(LOG, `[reqfail] ${req.url()} ${req.failure()?.errorText ?? ''}\n`));
  page.on('response', (resp) => {
    if (!resp.ok()) appendFileSync(LOG, `[http ${resp.status()}] ${resp.url()}\n`);
  });

  // Don't call narration.startRecording here — renderComposition starts the
  // recording itself AFTER the composition's warmup (page load + DRACO +
  // GLTF + Three.js init), so the captured video doesn't include 5-10s of
  // black setup time. Mixed demos that have recorded app scenes BEFORE the
  // first composition should still call startRecording themselves.

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
