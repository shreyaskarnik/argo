import type { Page } from '@playwright/test';

const CAMERA_ATTR = 'data-argo-camera';

interface CameraOptions {
  duration?: number;
  fadeIn?: number;
  fadeOut?: number;
  wait?: boolean;
}

export interface SpotlightOptions extends CameraOptions {
  opacity?: number;
  padding?: number;
}

export interface FocusRingOptions extends CameraOptions {
  color?: string;
  width?: number;
  pulse?: boolean;
}

export interface DimAroundOptions extends CameraOptions {
  dimOpacity?: number;
}

export interface ZoomToOptions extends CameraOptions {
  /** Zoom level — 1.5 means 150% magnification. Default: 1.5 */
  scale?: number;
}

async function runCameraEffect(
  page: Page,
  fn: Function,
  args: Record<string, unknown>,
  totalMs: number,
  wait: boolean,
): Promise<void> {
  try {
    await page.evaluate(fn as any, args);
    if (wait) {
      await page.waitForTimeout(totalMs);
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (!msg.includes('Target closed') && !msg.includes('destroyed') && !msg.includes('closed') && !msg.includes('disposed')) {
      console.warn(`Warning: camera effect failed: ${msg}`);
    }
  }
}

export async function spotlight(
  page: Page,
  selector: string,
  opts?: SpotlightOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const opacity = opts?.opacity ?? 0.7;
  const padding = opts?.padding ?? 12;
  const wait = opts?.wait ?? false;

  await runCameraEffect(page, ({ selector, duration, fadeIn, fadeOut, opacity, padding, attr }: any) => {
    const target = document.querySelector(selector);
    if (!target) return;
    const rect = target.getBoundingClientRect();

    const overlay = document.createElement('div');
    overlay.setAttribute(attr, 'spotlight');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99990; pointer-events: none;
      background: rgba(0,0,0,${opacity});
      clip-path: polygon(
        0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%,
        ${rect.left - padding}px ${rect.top - padding}px,
        ${rect.left - padding}px ${rect.bottom + padding}px,
        ${rect.right + padding}px ${rect.bottom + padding}px,
        ${rect.right + padding}px ${rect.top - padding}px,
        ${rect.left - padding}px ${rect.top - padding}px
      );
      opacity: 0; transition: opacity ${fadeIn}ms ease-out;
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    setTimeout(() => {
      overlay.style.transition = `opacity ${fadeOut}ms ease-out`;
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), fadeOut);
    }, duration);
  }, { selector, duration, fadeIn, fadeOut, opacity, padding, attr: CAMERA_ATTR }, duration + fadeOut, wait);
}

export async function focusRing(
  page: Page,
  selector: string,
  opts?: FocusRingOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const color = opts?.color ?? '#3b82f6';
  const ringWidth = opts?.width ?? 3;
  const pulse = opts?.pulse ?? true;
  const wait = opts?.wait ?? false;

  await runCameraEffect(page, ({ selector, duration, fadeIn, fadeOut, color, ringWidth, pulse, attr }: any) => {
    const target = document.querySelector(selector);
    if (!target) return;
    const rect = target.getBoundingClientRect();

    // Inject pulse animation if needed
    if (pulse) {
      const style = document.createElement('style');
      style.setAttribute(attr, 'focus-ring-style');
      style.textContent = `
        @keyframes argo-focus-pulse {
          0%, 100% { box-shadow: 0 0 0 ${ringWidth}px ${color}66, 0 0 0 ${ringWidth * 2}px ${color}26; }
          50% { box-shadow: 0 0 0 ${ringWidth + 1}px ${color}99, 0 0 0 ${ringWidth * 2 + 2}px ${color}40, 0 0 20px ${color}4d; }
        }
      `;
      document.head.appendChild(style);
    }

    const ring = document.createElement('div');
    ring.setAttribute(attr, 'focus-ring');
    ring.style.cssText = `
      position: fixed; z-index: 99990; pointer-events: none;
      left: ${rect.left - ringWidth}px; top: ${rect.top - ringWidth}px;
      width: ${rect.width + ringWidth * 2}px; height: ${rect.height + ringWidth * 2}px;
      border-radius: ${Math.min(8, parseInt(getComputedStyle(target as Element).borderRadius) || 0) + ringWidth}px;
      box-shadow: 0 0 0 ${ringWidth}px ${color}66, 0 0 0 ${ringWidth * 2}px ${color}26;
      ${pulse ? 'animation: argo-focus-pulse 1.5s ease-in-out infinite;' : ''}
      opacity: 0; transition: opacity ${fadeIn}ms ease-out;
    `;
    document.body.appendChild(ring);
    requestAnimationFrame(() => { ring.style.opacity = '1'; });

    setTimeout(() => {
      ring.style.transition = `opacity ${fadeOut}ms ease-out`;
      ring.style.opacity = '0';
      setTimeout(() => {
        ring.remove();
        document.querySelectorAll(`[${attr}="focus-ring-style"]`).forEach(el => el.remove());
      }, fadeOut);
    }, duration);
  }, { selector, duration, fadeIn, fadeOut, color, ringWidth, pulse, attr: CAMERA_ATTR }, duration + fadeOut, wait);
}

export async function dimAround(
  page: Page,
  selector: string,
  opts?: DimAroundOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const dimOpacity = opts?.dimOpacity ?? 0.3;
  const wait = opts?.wait ?? false;

  await runCameraEffect(page, ({ selector, duration, fadeIn, fadeOut, dimOpacity, attr }: any) => {
    const target = document.querySelector(selector);
    if (!target) return;

    // Find siblings to dim — walk up to a reasonable container
    const parent = target.parentElement;
    if (!parent) return;

    const siblings = Array.from(parent.children).filter(child => child !== target);
    const originals = siblings.map(s => ({
      el: s as HTMLElement,
      opacity: (s as HTMLElement).style.opacity,
      transition: (s as HTMLElement).style.transition,
    }));

    // Mark for cleanup
    const marker = document.createElement('div');
    marker.setAttribute(attr, 'dim-around');
    marker.style.display = 'none';
    (marker as any).__dimRestore = () => {
      originals.forEach(({ el, opacity, transition }) => {
        el.style.opacity = opacity;
        el.style.transition = transition;
      });
    };
    document.body.appendChild(marker);

    // Apply dim
    siblings.forEach(s => {
      (s as HTMLElement).style.transition = `opacity ${fadeIn}ms ease-out`;
      (s as HTMLElement).style.opacity = String(dimOpacity);
    });

    setTimeout(() => {
      siblings.forEach(s => {
        (s as HTMLElement).style.transition = `opacity ${fadeOut}ms ease-out`;
      });
      originals.forEach(({ el, opacity }) => {
        el.style.opacity = opacity || '';
      });
      // Fully restore original styles after fade-out completes
      setTimeout(() => {
        originals.forEach(({ el, opacity, transition }) => {
          el.style.opacity = opacity;
          el.style.transition = transition;
        });
        marker.remove();
      }, fadeOut);
    }, duration);
  }, { selector, duration, fadeIn, fadeOut, dimOpacity, attr: CAMERA_ATTR }, duration + fadeOut, wait);
}

export async function zoomTo(
  page: Page,
  selector: string,
  opts?: ZoomToOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const scale = opts?.scale ?? 1.5;
  const wait = opts?.wait ?? false;

  await runCameraEffect(page, ({
    selector,
    duration,
    fadeIn,
    fadeOut,
    scale,
    attr,
  }: any) => {
    const target = document.querySelector(selector);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Marker element for cleanup tracking
    const overlay = document.createElement('div');
    overlay.setAttribute(attr, 'zoom-to');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 99989;
      pointer-events: none; overflow: hidden;
      opacity: 0; transition: opacity ${fadeIn}ms ease-out;
    `;

    // Use an iframe-like approach: apply transform to html element
    // but clip it so only the target region shows, scaled up
    const html = document.documentElement;
    const origTransform = html.style.transform;
    const origTransformOrigin = html.style.transformOrigin;
    const origTransition = html.style.transition;
    const origOverflow = document.body.style.overflow;

    // Store restore data on the overlay element
    (overlay as any).__zoomRestore = {
      transform: origTransform,
      transformOrigin: origTransformOrigin,
      transition: origTransition,
      overflow: origOverflow,
    };

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Compute translate to center the target in the viewport after scaling.
    // With transform-origin at 0,0: after scale(s), the point (x,y) moves to (x*s, y*s).
    // We want the target center to land at the viewport center, so:
    //   centerX * scale + translateX = viewportWidth / 2
    //   translateX = viewportWidth / 2 - centerX * scale
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tx = vw / 2 - centerX * scale;
    const ty = vh / 2 - centerY * scale;

    html.style.transformOrigin = '0 0';
    html.style.transition = `transform ${fadeIn}ms ease-out`;

    requestAnimationFrame(() => {
      html.style.transform = `scale(${scale}) translate(${tx / scale}px, ${ty / scale}px)`;
      overlay.style.opacity = '1';
    });

    setTimeout(() => {
      html.style.transition = `transform ${fadeOut}ms ease-out`;
      html.style.transform = origTransform || '';
      overlay.style.transition = `opacity ${fadeOut}ms ease-out`;
      overlay.style.opacity = '0';

      setTimeout(() => {
        html.style.transformOrigin = origTransformOrigin || '';
        html.style.transition = origTransition || '';
        document.body.style.overflow = origOverflow || '';
        overlay.remove();
      }, fadeOut);
    }, duration);
  }, {
    selector,
    duration,
    fadeIn,
    fadeOut,
    scale,
    attr: CAMERA_ATTR,
  }, duration + fadeOut, wait);
}

export async function resetCamera(page: Page): Promise<void> {
  try {
    await page.evaluate((attr) => {
      const html = document.documentElement;
      // Clean up all camera elements
      document.querySelectorAll(`[${attr}]`).forEach(el => {
        // Restore dim-around originals
        if ((el as any).__dimRestore) (el as any).__dimRestore();
        // Restore zoom-to: reset html transform
        if ((el as any).__zoomRestore) {
          const r = (el as any).__zoomRestore;
          html.style.transform = r.transform || '';
          html.style.transformOrigin = r.transformOrigin || '';
          html.style.transition = r.transition || '';
          document.body.style.overflow = r.overflow || '';
        }
        el.remove();
      });
    }, CAMERA_ATTR);
  } catch {
    // Page may be closed
  }
}
