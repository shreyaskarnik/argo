import type { Page } from '@playwright/test';
import type { NarrationTimeline } from './narration.js';

const CAMERA_ATTR = 'data-argo-camera';
const OVERLAY_ID_PREFIX = 'argo-overlay-';
const CONFETTI_ID = 'argo-confetti';
const ZOOM_WRAPPER_ID = 'argo-camera-zoom-wrapper';

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
  /** Hold the zoomed view for this many ms before zooming back out. Default: 0. */
  holdMs?: number;
  /**
   * When provided, records the zoom as a post-export camera move (ffmpeg crop+scale)
   * instead of applying a browser-side CSS transform. This produces frame-exact,
   * overlay-safe zoom effects. Pass the narration fixture instance.
   */
  narration?: NarrationTimeline;
}

export type SelectorOrLocator =
  | string
  | { boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null> };

async function resolveRect(
  page: Page,
  selectorOrLocator: SelectorOrLocator,
): Promise<{
  selector: string | null;
  rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } | null;
}> {
  if (typeof selectorOrLocator === 'string') {
    return { selector: selectorOrLocator, rect: null };
  }
  const box = await selectorOrLocator.boundingBox();
  if (!box) return { selector: null, rect: null };
  return {
    selector: null,
    rect: {
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
      width: box.width,
      height: box.height,
    },
  };
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
  selectorOrLocator: SelectorOrLocator,
  opts?: SpotlightOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const opacity = opts?.opacity ?? 0.7;
  const padding = opts?.padding ?? 12;
  const wait = opts?.wait ?? false;

  const { selector, rect: preRect } = await resolveRect(page, selectorOrLocator);

  await runCameraEffect(page, ({ selector, preRect, duration, fadeIn, fadeOut, opacity, padding, attr }: any) => {
    const rect = preRect ?? (() => {
      const target = document.querySelector(selector);
      if (!target) { console.warn('[argo] camera effect: no element found for selector "' + selector + '"'); return null; }
      return target.getBoundingClientRect();
    })();
    if (!rect) return;

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
  }, { selector, preRect, duration, fadeIn, fadeOut, opacity, padding, attr: CAMERA_ATTR }, duration + fadeOut, wait);
}

export async function focusRing(
  page: Page,
  selectorOrLocator: SelectorOrLocator,
  opts?: FocusRingOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const color = opts?.color ?? '#3b82f6';
  const ringWidth = opts?.width ?? 3;
  const pulse = opts?.pulse ?? true;
  const wait = opts?.wait ?? false;

  const { selector, rect: preRect } = await resolveRect(page, selectorOrLocator);

  await runCameraEffect(page, ({ selector, preRect, duration, fadeIn, fadeOut, color, ringWidth, pulse, attr }: any) => {
    const rect = preRect ?? (() => {
      const target = document.querySelector(selector);
      if (!target) { console.warn('[argo] camera effect: no element found for selector "' + selector + '"'); return null; }
      return target.getBoundingClientRect();
    })();
    if (!rect) return;

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
    // When using pre-resolved rect, we don't have a DOM target to read borderRadius from
    const borderRadius = preRect ? ringWidth : Math.min(8, parseInt(getComputedStyle(document.querySelector(selector) as Element).borderRadius) || 0) + ringWidth;
    ring.style.cssText = `
      position: fixed; z-index: 99990; pointer-events: none;
      left: ${rect.left - ringWidth}px; top: ${rect.top - ringWidth}px;
      width: ${rect.width + ringWidth * 2}px; height: ${rect.height + ringWidth * 2}px;
      border-radius: ${borderRadius}px;
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
  }, { selector, preRect, duration, fadeIn, fadeOut, color, ringWidth, pulse, attr: CAMERA_ATTR }, duration + fadeOut, wait);
}

export async function dimAround(
  page: Page,
  selectorOrLocator: SelectorOrLocator,
  opts?: DimAroundOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const dimOpacity = opts?.dimOpacity ?? 0.3;
  const wait = opts?.wait ?? false;

  const { selector, rect: preRect } = await resolveRect(page, selectorOrLocator);

  // When a Locator is passed (preRect != null), we don't have a DOM element reference,
  // so sibling-dimming is not possible. Fall back to a spotlight-style full-page dim.
  if (preRect !== null) {
    console.warn('[argo] dimAround: Locator passed — falling back to spotlight-style dim (sibling dimming requires a CSS selector)');
    await runCameraEffect(page, ({ preRect, duration, fadeIn, fadeOut, dimOpacity, attr }: any) => {
      const rect = preRect;
      const padding = 0;
      const overlay = document.createElement('div');
      overlay.setAttribute(attr, 'dim-around');
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99990; pointer-events: none;
        background: rgba(0,0,0,${1 - dimOpacity});
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
    }, { preRect, duration, fadeIn, fadeOut, dimOpacity, attr: CAMERA_ATTR }, duration + fadeOut, wait);
    return;
  }

  await runCameraEffect(page, ({ selector, duration, fadeIn, fadeOut, dimOpacity, attr }: any) => {
    const target = document.querySelector(selector);
    if (!target) { console.warn('[argo] camera effect: no element found for selector "' + selector + '"'); return; }

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
  selectorOrLocator: SelectorOrLocator,
  opts?: ZoomToOptions,
): Promise<void> {
  const duration = opts?.duration ?? 3000;
  const fadeIn = opts?.fadeIn ?? 400;
  const fadeOut = opts?.fadeOut ?? 400;
  const scale = opts?.scale ?? 1.5;
  const wait = opts?.wait ?? false;
  const holdMs = opts?.holdMs ?? 0;

  const { selector, rect: preRect } = await resolveRect(page, selectorOrLocator);

  // Post-export path: record camera move for ffmpeg processing
  if (opts?.narration) {
    // Resolve bounding box in video-pixel coordinates
    let rect = preRect;
    if (!rect && selector) {
      try {
        const box = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        }, selector);
        rect = box;
      } catch {
        // Page may be closed
      }
    }
    if (rect) {
      opts.narration.recordCameraMove({
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        durationMs: fadeIn,
        scale,
        holdMs: holdMs > 0 ? holdMs : duration - fadeIn - fadeOut,
      });
    }
    // Wait if requested so the demo script timing stays consistent
    if (wait) {
      await page.waitForTimeout(duration + fadeOut);
    }
    return;
  }

  // Legacy browser-side path (for VS Code preview / standalone Playwright runs)
  await runCameraEffect(page, ({
    selector,
    preRect,
    duration,
    fadeIn,
    fadeOut,
    scale,
    attr,
    overlayPrefix,
    confettiId,
    wrapperId,
  }: any) => {
    const rect = preRect ?? (() => {
      const target = document.querySelector(selector);
      if (!target) { console.warn('[argo] camera effect: no element found for selector "' + selector + '"'); return null; }
      return target.getBoundingClientRect();
    })();
    if (!rect) return;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const isArgoManaged = (el: Element) =>
      el.hasAttribute(attr) ||
      el.id.startsWith(overlayPrefix) ||
      el.id === confettiId;

    const ensureZoomWrapper = () => {
      let wrapper = document.getElementById(wrapperId) as HTMLElement | null;
      if (wrapper) return wrapper;

      wrapper = document.createElement('div');
      wrapper.id = wrapperId;
      wrapper.style.transformOrigin = '0 0';
      wrapper.style.willChange = 'transform';

      const children = Array.from(document.body.children).filter((child) => {
        if (child.id === wrapperId) return false;
        return !isArgoManaged(child);
      });
      children.forEach((child) => wrapper!.appendChild(child));
      document.body.insertBefore(wrapper, document.body.firstChild);
      return wrapper;
    };

    const unwrapZoomWrapper = () => {
      const wrapper = document.getElementById(wrapperId);
      if (!wrapper) return;
      const children = Array.from(wrapper.children);
      children.forEach((child) => document.body.insertBefore(child, wrapper));
      wrapper.remove();
    };

    const wrapper = ensureZoomWrapper();
    const origTransform = wrapper.style.transform;
    const origTransformOrigin = wrapper.style.transformOrigin;
    const origTransition = wrapper.style.transition;
    const origWillChange = wrapper.style.willChange;
    const origOverflow = document.body.style.overflow;

    // Marker element for cleanup tracking
    const marker = document.createElement('div');
    marker.setAttribute(attr, 'zoom-to');
    marker.style.display = 'none';
    (marker as any).__zoomRestore = {
      wrapperId,
      styles: {
        transform: origTransform,
        transformOrigin: origTransformOrigin,
        transition: origTransition,
        willChange: origWillChange,
      },
      overflow: origOverflow,
    };

    document.body.appendChild(marker);
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

    wrapper.style.transformOrigin = '0 0';
    wrapper.style.transition = `transform ${fadeIn}ms ease-out`;

    requestAnimationFrame(() => {
      wrapper.style.transform = `scale(${scale}) translate(${tx / scale}px, ${ty / scale}px)`;
    });

    setTimeout(() => {
      wrapper.style.transition = `transform ${fadeOut}ms ease-out`;
      wrapper.style.transform = origTransform || '';

      setTimeout(() => {
        const w = document.getElementById(wrapperId) as HTMLElement | null;
        if (w) {
          w.style.transform = origTransform || '';
          w.style.transformOrigin = origTransformOrigin || '';
          w.style.transition = origTransition || '';
          w.style.willChange = origWillChange || '';
        }
        document.body.style.overflow = origOverflow || '';
        unwrapZoomWrapper();
        marker.remove();
      }, fadeOut);
    }, duration);
  }, {
    selector,
    preRect,
    duration,
    fadeIn,
    fadeOut,
    scale,
    attr: CAMERA_ATTR,
    overlayPrefix: OVERLAY_ID_PREFIX,
    confettiId: CONFETTI_ID,
    wrapperId: ZOOM_WRAPPER_ID,
  }, duration + fadeOut, wait);
}

export async function resetCamera(page: Page): Promise<void> {
  try {
    await page.evaluate((attr) => {
      const unwrapZoomWrapper = (wrapperId: string) => {
        const wrapper = document.getElementById(wrapperId);
        if (!wrapper) return;
        const children = Array.from(wrapper.children);
        children.forEach((child) => document.body.insertBefore(child, wrapper));
        wrapper.remove();
      };

      // Clean up all camera elements
      document.querySelectorAll(`[${attr}]`).forEach(el => {
        // Restore dim-around originals
        if ((el as any).__dimRestore) (el as any).__dimRestore();
        // Restore zoom-to: reset wrapper transform and unwrap content
        if ((el as any).__zoomRestore) {
          const r = (el as any).__zoomRestore;
          const wrapper = document.getElementById(r.wrapperId) as HTMLElement | null;
          if (wrapper) {
            wrapper.style.transform = r.styles.transform || '';
            wrapper.style.transformOrigin = r.styles.transformOrigin || '';
            wrapper.style.transition = r.styles.transition || '';
            wrapper.style.willChange = r.styles.willChange || '';
          }
          document.body.style.overflow = r.overflow || '';
          unwrapZoomWrapper(r.wrapperId);
        }
        el.remove();
      });
    }, CAMERA_ATTR);
  } catch {
    // Page may be closed
  }
}
