import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/showcase.html');
  await page.waitForTimeout(1500);

  // Scene 1: Hero section — ~12s for voiceover
  narration.mark('hero');
  await showOverlay(page, 'hero', {
    type: 'lower-third',
    text: 'Argo — Demo videos, automated',
    placement: 'top-left',
    motion: 'fade-in',
  }, 12000);

  // Scene 2: How it works — ~14s for voiceover about 3 steps
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Three Simple Steps',
    body: 'Write a script. Record the browser. Export the video.',
    placement: 'top-right',
    motion: 'slide-in',
  }, async () => {
    await page.waitForTimeout(14000);
  });

  // Scene 3: Features — ~12s for voiceover
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await showOverlay(page, 'features', {
    type: 'callout',
    text: 'Overlays, voiceover, and more',
    placement: 'top-left',
    motion: 'fade-in',
  }, 12000);

  // Scene 4: Code example — ~12s for voiceover
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await showOverlay(page, 'code', {
    type: 'lower-third',
    text: 'Familiar Playwright API — nothing new to learn',
    placement: 'top-left',
    motion: 'fade-in',
  }, 12000);

  // Scene 5: Closing
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'top-right',
    motion: 'fade-in',
  }, 8000);

  // Scene 6: Mic drop — male voice 4th wall break + confetti
  narration.mark('mic-drop');

  // Inject confetti canvas
  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.id = 'confetti';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999';
    document.body.appendChild(canvas);
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext('2d')!;
    const colors = ['#3b82f6', '#06b6d4', '#4ade80', '#f59e0b', '#ef4444', '#a78bfa'];
    const pieces: { x: number; y: number; w: number; h: number; color: string; vx: number; vy: number; rot: number; rv: number }[] = [];
    for (let i = 0; i < 150; i++) {
      pieces.push({
        x: Math.random() * canvas.width,
        y: -Math.random() * canvas.height,
        w: 6 + Math.random() * 8,
        h: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2,
        rv: (Math.random() - 0.5) * 0.2,
      });
    }
    function frame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of pieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.rv;
        p.vy += 0.05;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (pieces.some(p => p.y < canvas.height + 50)) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });

  await showOverlay(page, 'mic-drop', {
    type: 'lower-third',
    text: 'This demo was recorded by Argo, using Argo.',
    placement: 'top-left',
    motion: 'fade-in',
  }, 8000);
});
