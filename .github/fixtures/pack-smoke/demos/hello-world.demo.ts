import { test } from '@argo-video/cli';

/**
 * Silent by design — the scenes manifest has no `text`, so TTS is skipped and
 * CI does not download an engine (~400 MB). Everything this fixture is meant
 * to catch happens after TTS: whether the installed package can drive
 * Playwright, capture a screencast, and hand it to ffmpeg.
 *
 * Full-screen saturated backgrounds so scripts/verify-ci-smoke.py can assert
 * the sampled quadrant is real rendered content rather than padding.
 */
test('hello-world', async ({ page, narration }) => {
  test.setTimeout(60_000);

  await page.setContent(`
    <!doctype html>
    <html><body style="margin:0;font-family:system-ui;color:#fff;overflow:hidden">
      <div id="s1" data-scene style="position:absolute;inset:0;background:#1e3a8a;display:grid;place-items:center;font-size:96px;font-weight:800">One</div>
      <div id="s2" data-scene style="position:absolute;inset:0;background:#7c2d12;display:none;place-items:center;font-size:96px;font-weight:800">Two</div>
      <div id="s3" data-scene style="position:absolute;inset:0;background:#14532d;display:none;place-items:center;font-size:96px;font-weight:800">Three</div>
    </body></html>
  `);
  await page.waitForTimeout(300);

  // The call this fixture exists to protect. Without it the pipeline generates
  // audio, runs the browser, then fails at export with "No screencast
  // recording found" — which is exactly how the shipped example broke.
  await narration.startRecording(page);

  narration.mark('one');
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    (document.getElementById('s1') as HTMLElement).style.display = 'none';
    (document.getElementById('s2') as HTMLElement).style.display = 'grid';
  });
  narration.mark('two');
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    (document.getElementById('s2') as HTMLElement).style.display = 'none';
    (document.getElementById('s3') as HTMLElement).style.display = 'grid';
  });
  narration.mark('three');
  await page.waitForTimeout(2500);
});
