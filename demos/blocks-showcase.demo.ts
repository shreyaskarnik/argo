import { test } from '@argo-video/cli';
import { showOverlay } from '@argo-video/cli';

test('blocks-showcase', async ({ page, narration }) => {
  test.setTimeout(180_000);

  // Use a simple HTML page as the background — blocks are the star.
  await page.setContent(`
    <!DOCTYPE html><html><body style="margin:0;background:linear-gradient(135deg,#1e1b4b,#312e81,#4c1d95);height:100vh;color:#fff;font-family:system-ui">
      <div style="padding:80px 60px">
        <h1 style="font-size:48px;margin:0;font-weight:800;letter-spacing:-0.02em">Argo Blocks</h1>
        <p style="font-size:20px;opacity:0.8;margin-top:12px">Ready-to-use overlay catalog</p>
      </div>
    </body></html>
  `);
  await page.waitForTimeout(500);

  await narration.startRecording(page);

  for (const scene of ['intro', 'x-post', 'macos', 'ytlt', 'chart', 'spotify', 'closing']) {
    narration.mark(scene);
    await showOverlay(page, scene, narration.durationFor(scene, { maxMs: 6000 }));
  }
});
