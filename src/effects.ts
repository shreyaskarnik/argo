import type { Page } from '@playwright/test';

export interface ConfettiOptions {
  /** Milliseconds before auto-fade. Default: 3000 */
  duration?: number;
  /** Number of confetti pieces. Default: 150 */
  pieces?: number;
  /** 'burst' fans from center-top (Raycast-style), 'rain' falls across full width. Default: 'burst' */
  spread?: 'burst' | 'rain';
  /** Hex color strings for confetti pieces. Default: blue, cyan, green, amber, red, purple */
  colors?: string[];
  /** Fade-out duration in ms. Default: 800 */
  fadeOut?: number;
  /** Block until animation completes. Default: false (non-blocking, fire-and-forget safe). */
  wait?: boolean;
}

const DEFAULT_COLORS = ['#3b82f6', '#06b6d4', '#4ade80', '#f59e0b', '#ef4444', '#a78bfa'];

const CONFETTI_ID = 'argo-confetti';

export async function showConfetti(
  page: Page,
  opts?: ConfettiOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const pieces = opts?.pieces ?? 150;
  const spread = opts?.spread ?? 'burst';
  const colors = opts?.colors ?? DEFAULT_COLORS;
  const fadeOut = opts?.fadeOut ?? 800;
  const wait = opts?.wait ?? false;

  await page.evaluate(
    ({ pieces, spread, colors, duration, fadeOut, id }) => {
      // Remove any existing confetti
      document.getElementById(id)?.remove();

      const canvas = document.createElement('canvas');
      canvas.id = id;
      canvas.style.cssText =
        'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999';
      document.body.appendChild(canvas);
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d')!;

      const particles: {
        x: number;
        y: number;
        w: number;
        h: number;
        color: string;
        vx: number;
        vy: number;
        rot: number;
        rv: number;
      }[] = [];

      for (let i = 0; i < pieces; i++) {
        const color = colors[Math.floor(Math.random() * colors.length)];
        const w = 6 + Math.random() * 8;
        const h = 4 + Math.random() * 6;
        const rot = Math.random() * Math.PI * 2;
        const rv = (Math.random() - 0.5) * 0.2;

        if (spread === 'burst') {
          // Raycast-style: burst from center-top, fan outward
          const cx = canvas.width / 2;
          const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
          const speed = 4 + Math.random() * 8;
          particles.push({
            x: cx + (Math.random() - 0.5) * 40,
            y: -10,
            w,
            h,
            color,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            rot,
            rv,
          });
        } else {
          // Rain: spawn across full width above viewport
          particles.push({
            x: Math.random() * canvas.width,
            y: -Math.random() * canvas.height,
            w,
            h,
            color,
            vx: (Math.random() - 0.5) * 4,
            vy: 2 + Math.random() * 4,
            rot,
            rv,
          });
        }
      }

      const startTime = performance.now();

      function frame() {
        const elapsed = performance.now() - startTime;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.rot += p.rv;
          p.vy += 0.15; // gravity
          if (spread === 'burst') {
            p.vx *= 0.99; // air resistance for burst spread
          }

          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx.restore();
        }

        // Start fade-out when duration reached
        if (elapsed >= duration) {
          const fadeProgress = Math.min(1, (elapsed - duration) / fadeOut);
          canvas.style.opacity = String(1 - fadeProgress);
          if (fadeProgress >= 1) {
            canvas.remove();
            return;
          }
        }

        if (particles.some((p) => p.y < canvas.height + 50) || elapsed < duration + fadeOut) {
          requestAnimationFrame(frame);
        } else {
          canvas.remove();
        }
      }

      requestAnimationFrame(frame);
    },
    { pieces, spread, colors, duration, fadeOut, id: CONFETTI_ID },
  );

  if (wait) {
    await page.waitForTimeout(duration + fadeOut);
  }
}
