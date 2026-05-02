import { test } from '@argo-video/cli';

test('ci-smoke', async ({ page, narration }) => {
  test.setTimeout(60_000);

  await page.setContent(`
    <!doctype html>
    <html><body style="margin:0;font-family:system-ui;color:#fff;overflow:hidden">
      <div id="s1" data-scene style="position:absolute;inset:0;background:#1e3a8a;display:grid;place-items:center;font-size:96px;font-weight:800">Scene 1</div>
      <div id="s2" data-scene style="position:absolute;inset:0;background:#7c2d12;display:none;place-items:center;font-size:96px;font-weight:800">Scene 2</div>
      <div id="s3" data-scene style="position:absolute;inset:0;background:#14532d;display:none;place-items:center;font-size:96px;font-weight:800">Scene 3</div>
    </body></html>
  `);
  await page.waitForTimeout(300);

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
