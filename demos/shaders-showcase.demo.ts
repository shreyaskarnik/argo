import { test } from '@argo-video/cli';

test('shaders-showcase', async ({ page, narration }) => {
  test.setTimeout(180_000);

  const backgrounds = [
    'linear-gradient(135deg,#0f172a,#1e293b,#334155)',
    'linear-gradient(135deg,#701a75,#be185d,#db2777)',
    'linear-gradient(135deg,#0c4a6e,#0369a1,#0284c7)',
    'linear-gradient(135deg,#14532d,#166534,#16a34a)',
    'linear-gradient(135deg,#78350f,#b45309,#d97706)',
    'linear-gradient(135deg,#450a0a,#991b1b,#dc2626)',
  ];

  const scenes = ['intro', 'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak'];

  for (let i = 0; i < scenes.length; i++) {
    await page.setContent(`
      <!DOCTYPE html><html><body style="margin:0;background:${backgrounds[i]};height:100vh;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center">
        <div style="text-align:center">
          <div style="font-size:72px;font-weight:800;letter-spacing:-0.02em">${scenes[i]}</div>
          <div style="font-size:24px;opacity:0.7;margin-top:12px">scene ${i + 1}</div>
        </div>
      </body></html>
    `);
    await page.waitForTimeout(300);

    // Start capture once the first scene is on screen — before this, the page
    // is blank and would be recorded as such.
    if (i === 0) await narration.startRecording(page);

    narration.mark(scenes[i]);
    await page.waitForTimeout(narration.durationFor(scenes[i], { minMs: 2500, maxMs: 4000 }));
  }
});
