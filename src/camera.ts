import type { Page } from '@playwright/test';

const CAMERA_ATTR = 'data-argo-camera';
const OVERLAY_ID_PREFIX = 'argo-overlay-';
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
    overlayPrefix,
    wrapperId,
  }: any) => {
    const target = document.querySelector(selector);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const isArgoManaged = (el: Element) => el.hasAttribute(attr) || el.id.startsWith(overlayPrefix);
    const ensureZoomWrapper = () => {
      let wrapper = document.getElementById(wrapperId) as HTMLElement | null;
      if (wrapper) return wrapper;

      wrapper = document.createElement('div');
      wrapper.id = wrapperId;
      wrapper.style.cssText = 'transform-origin: 0 0; will-change: transform;';

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
    const originalStyles = {
      transform: wrapper.style.transform,
      transformOrigin: wrapper.style.transformOrigin,
      transition: wrapper.style.transition,
    };

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const viewCenterX = window.innerWidth / 2;
    const viewCenterY = window.innerHeight / 2;
    const translateX = viewCenterX - centerX;
    const translateY = viewCenterY - centerY;

    // Mark for cleanup
    const marker = document.createElement('div');
    marker.setAttribute(attr, 'zoom-to');
    marker.style.display = 'none';
    (marker as any).__zoomRestore = {
      wrapperId,
      styles: originalStyles,
    };
    document.body.appendChild(marker);

    wrapper.style.transformOrigin = `${centerX}px ${centerY}px`;
    wrapper.style.transition = `transform ${fadeIn}ms ease-out`;
    wrapper.style.transform = `scale(${scale}) translate(${translateX / scale}px, ${translateY / scale}px)`;

    setTimeout(() => {
      wrapper.style.transition = `transform ${fadeOut}ms ease-out`;
      wrapper.style.transform = '';
      setTimeout(() => {
        const w = document.getElementById(wrapperId) as HTMLElement | null;
        if (w) {
          w.style.transform = originalStyles.transform;
          w.style.transformOrigin = originalStyles.transformOrigin;
          w.style.transition = originalStyles.transition;
        }
        unwrapZoomWrapper();
        marker.remove();
      }, fadeOut);
    }, duration);
  }, {
    selector,
    duration,
    fadeIn,
    fadeOut,
    scale,
    attr: CAMERA_ATTR,
    overlayPrefix: OVERLAY_ID_PREFIX,
    wrapperId: ZOOM_WRAPPER_ID,
  }, duration + fadeOut, wait);
}

export async function resetCamera(page: Page): Promise<void> {
  try {
    await page.evaluate(({ attr, wrapperId }) => {
      // Clean up all camera elements
      document.querySelectorAll(`[${attr}]`).forEach(el => {
        // Restore dim-around originals
        if ((el as any).__dimRestore) (el as any).__dimRestore();
        // Restore zoom-to transform
        if ((el as any).__zoomRestore) {
          const r = (el as any).__zoomRestore;
          const w = document.getElementById(r.wrapperId) as HTMLElement | null;
          if (w) {
            w.style.transform = r.styles.transform;
            w.style.transformOrigin = r.styles.transformOrigin;
            w.style.transition = r.styles.transition;
          }
          const wrapper = document.getElementById(wrapperId);
          if (wrapper) {
            const children = Array.from(wrapper.children);
            children.forEach((child) => document.body.insertBefore(child, wrapper));
            wrapper.remove();
          }
        }
        el.remove();
      });
    }, { attr: CAMERA_ATTR, wrapperId: ZOOM_WRAPPER_ID });
  } catch {
    // Page may be closed
  }
}
