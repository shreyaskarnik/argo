import type { Page } from '@playwright/test';

const CURSOR_ATTR = 'data-argo-cursor';
const CURSOR_ID = 'argo-cursor-highlight';

export interface CursorHighlightOptions {
  /** Continuous ring, or brief locator circles on appearance/click/Control release. Default: 'continuous'. */
  mode?: 'continuous' | 'click';
  /** Highlight ring color. Default: '#3b82f6' */
  color?: string;
  /** Radius of the highlight circle in px. Default: 20 */
  radius?: number;
  /** Show a breathing glow in continuous mode. Default: true */
  pulse?: boolean;
  /** Show a ripple effect on click. Default: true */
  clickRipple?: boolean;
  /** Opacity of the ring or locator animation. Default: 0.5 */
  opacity?: number;
}

/**
 * Shared implementation for `cursorHighlight` (always replaces) and
 * `ensureCursorHighlight` (no-op when a ring is already installed).
 */
async function applyCursorHighlight(
  page: Page,
  opts: CursorHighlightOptions | undefined,
  skipIfPresent: boolean,
): Promise<void> {
  const color = opts?.color ?? '#3b82f6';
  const radius = opts?.radius ?? 20;
  const pulse = opts?.pulse ?? true;
  const clickRipple = opts?.clickRipple ?? true;
  const opacity = opts?.opacity ?? 0.5;
  const mode = opts?.mode ?? 'continuous';

  try {
    await page.evaluate(
      ({ color, radius, pulse, clickRipple, opacity, mode, attr, id, skipIfPresent }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;

        // Idempotent path: the caller only wants a ring to exist, and one is
        // already installed (or queued behind DOMContentLoaded). Bail before
        // touching the DOM so same-document (SPA) navigations don't tear down
        // and rebuild a perfectly good overlay.
        if (skipIfPresent && (document.getElementById(id) || w.__argoCursorPending)) return;

        // Generation counter: a later call supersedes any install still
        // waiting on DOMContentLoaded, so we never stack two rings.
        const gen = (w.__argoCursorGen = (w.__argoCursorGen || 0) + 1);

        const install = (): void => {
          if (w.__argoCursorGen !== gen) return; // superseded
          w.__argoCursorPending = false;

          // Remove existing highlight. Invoke its stored cleanup first —
          // otherwise the previous document-level mousemove/click listeners
          // survive as leaks bound to a detached node.
          const previous = document.getElementById(id);
          if (previous) {
            try { (previous as any).__cleanup?.(); } catch { /* best-effort */ }
            previous.remove();
          }
          document.querySelectorAll(`[${attr}]`).forEach(el => el.remove());

          // Inject keyframe styles
          const style = document.createElement('style');
          style.setAttribute(attr, 'style');
          style.textContent = `
            @keyframes argo-cursor-pulse {
              0%, 100% { box-shadow: 0 0 0 2px ${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}, 0 0 ${radius * 0.6}px ${color}33; }
              50% { box-shadow: 0 0 0 3px ${color}${Math.round(opacity * 255 * 0.8).toString(16).padStart(2, '0')}, 0 0 ${radius}px ${color}55; }
            }
            @keyframes argo-cursor-ripple {
              0% { transform: translate(-50%, -50%) scale(1); opacity: ${opacity}; }
              100% { transform: translate(-50%, -50%) scale(3); opacity: 0; }
            }
            @keyframes argo-cursor-locate {
              0% { transform: translate(-50%, -50%) scale(2.4); opacity: 0; }
              15%, 70% { opacity: ${opacity}; }
              100% { transform: translate(-50%, -50%) scale(.2); opacity: 0; }
            }
          `;
          (document.head ?? document.documentElement).appendChild(style);

          // Create highlight element
          const dot = document.createElement('div');
          dot.id = id;
          dot.setAttribute(attr, 'highlight');
          dot.style.cssText = `
            position: fixed; z-index: 2147483646; pointer-events: none;
            width: ${radius * 2}px; height: ${radius * 2}px;
            border-radius: 50%;
            border: 2px solid ${color};
            opacity: ${opacity};
            visibility: ${mode === 'click' ? 'hidden' : 'visible'};
            transform: translate(-50%, -50%);
            left: -100px; top: -100px;
            transition: left 0.05s ease-out, top 0.05s ease-out;
            ${pulse ? `animation: argo-cursor-pulse 1.5s ease-in-out infinite;` : `box-shadow: 0 0 0 2px ${color}${Math.round(opacity * 255).toString(16).padStart(2, '0')}, 0 0 ${radius * 0.6}px ${color}33;`}
          `;
          document.body.appendChild(dot);

          let lastPoint: { x: number; y: number } | null = null;
          let locateTimer: ReturnType<typeof setTimeout> | undefined;
          const locate = (x: number, y: number) => {
            // Retrigger one circle on rapid clicks/Control presses. Leave it at
            // the event position instead of attaching it to the moving arrow.
            clearTimeout(locateTimer);
            document.querySelectorAll(`[${attr}="ripple"]`).forEach(el => el.remove());
            const circle = document.createElement('div');
            circle.setAttribute(attr, 'ripple');
            circle.setAttribute('aria-hidden', 'true');
            circle.style.cssText = `
              position: fixed; z-index: 2147483645; pointer-events: none;
              width: ${radius * 2}px; height: ${radius * 2}px;
              border-radius: 50%; border: 2px solid white;
              box-shadow: 0 0 0 2px ${color}, inset 0 0 0 1px ${color};
              left: ${x}px; top: ${y}px;
              animation: argo-cursor-locate .7s ease-out both;
            `;
            document.body.appendChild(circle);
            locateTimer = setTimeout(() => circle.remove(), 700);
          };

          // Track mouse movement
          const onMove = (e: MouseEvent) => {
            dot.style.left = e.clientX + 'px';
            dot.style.top = e.clientY + 'px';
            if (mode === 'click' && !lastPoint) locate(e.clientX, e.clientY);
            lastPoint = { x: e.clientX, y: e.clientY };
          };
          document.addEventListener('mousemove', onMove, true);

          // Store cleanup reference
          (dot as any).__cleanup = () => {
            document.removeEventListener('mousemove', onMove, true);
            clearTimeout(locateTimer);
          };

          if (mode === 'click') {
            const onKeyUp = (e: KeyboardEvent) => {
              if (e.key === 'Control' && lastPoint) locate(lastPoint.x, lastPoint.y);
            };
            document.addEventListener('keyup', onKeyUp, true);
            const origCleanup = (dot as any).__cleanup;
            (dot as any).__cleanup = () => {
              origCleanup();
              document.removeEventListener('keyup', onKeyUp, true);
            };
          }

          // Click ripple effect
          if (clickRipple) {
            const onClick = (e: MouseEvent) => {
              if (mode === 'click') {
                locate(e.clientX, e.clientY);
                return;
              }
              const ripple = document.createElement('div');
              ripple.setAttribute(attr, 'ripple');
              ripple.style.cssText = `
                position: fixed; z-index: 2147483645; pointer-events: none;
                width: ${radius * 2}px; height: ${radius * 2}px;
                border-radius: 50%;
                border: 2px solid ${color};
                left: ${e.clientX}px; top: ${e.clientY}px;
                transform: translate(-50%, -50%);
                animation: argo-cursor-ripple 0.4s ease-out forwards;
              `;
              document.body.appendChild(ripple);
              setTimeout(() => ripple.remove(), 400);
            };
            document.addEventListener('click', onClick, true);

            const origCleanup = (dot as any).__cleanup;
            (dot as any).__cleanup = () => {
              origCleanup();
              document.removeEventListener('click', onClick, true);
            };
          }
        };

        // `framenavigated` fires at navigation commit — the parser may not have
        // produced <body> yet, and `document.body.appendChild` would throw a
        // TypeError that isn't a disposal error (so it would surface as a
        // warning and leave the page permanently cursor-less). Defer instead.
        if (document.body) {
          install();
        } else {
          w.__argoCursorPending = true;
          document.addEventListener('DOMContentLoaded', install, { once: true });
        }
      },
      { color, radius, pulse, clickRipple, opacity, mode, attr: CURSOR_ATTR, id: CURSOR_ID, skipIfPresent },
    );
  } catch (err) {
    const msg = (err as Error)?.message ?? '';
    if (!msg.includes('Target closed') && !msg.includes('destroyed') && !msg.includes('closed') && !msg.includes('disposed')) {
      console.warn(`Warning: cursor highlight failed: ${msg}`);
    }
  }
}

/**
 * Enables cursor feedback until `resetCursor(page)` is called. By default a
 * ring follows the mouse; mode:'click' shows only brief locator animations.
 * Calling again replaces the existing highlight.
 */
export async function cursorHighlight(
  page: Page,
  opts?: CursorHighlightOptions,
): Promise<void> {
  return applyCursorHighlight(page, opts, false);
}

/**
 * Installs the cursor highlight only when one isn't already present.
 *
 * Used by the automatic (`video.cursorHighlight`) path after a navigation:
 * Playwright emits `framenavigated` for same-document history navigations too,
 * so an unconditional reinstall would rebuild the ring on every SPA route
 * change — resetting it off-screen until the next mouse event and leaking the
 * previous document listeners.
 */
export async function ensureCursorHighlight(
  page: Page,
  opts?: CursorHighlightOptions,
): Promise<void> {
  return applyCursorHighlight(page, opts, true);
}

/**
 * Removes the cursor highlight and all related elements.
 */
export async function resetCursor(page: Page): Promise<void> {
  try {
    await page.evaluate(({ attr, id }) => {
      // Invalidate any install still queued behind DOMContentLoaded.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      w.__argoCursorGen = (w.__argoCursorGen || 0) + 1;
      w.__argoCursorPending = false;

      const dot = document.getElementById(id);
      if (dot && (dot as any).__cleanup) {
        (dot as any).__cleanup();
      }
      dot?.remove();
      document.querySelectorAll(`[${attr}]`).forEach(el => el.remove());
    }, { attr: CURSOR_ATTR, id: CURSOR_ID });
  } catch {
    // Page may be closed
  }
}
