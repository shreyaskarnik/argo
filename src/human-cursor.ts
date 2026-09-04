// Adapted from OleksandrKucherenko's prototype in Argo issue #37:
// https://github.com/shreyaskarnik/argo/issues/37#issuecomment-5330757879
// Seeded Bezier movement inspired by CloverLabsAI/human-cursor (MIT), with
// real mouse events as in feder-cr/invisible_playwright (MIT).
import type { Locator, Page } from '@playwright/test';

const CURSOR_ID = 'argo-human-cursor';
const STYLE_ID = 'argo-human-cursor-style';

export interface CursorPoint { x: number; y: number }

export interface HumanCursorOptions {
  /** Identical seeds and targets produce reproducible paths. */
  seed?: string;
  /** Width of the SVG pointer in CSS pixels. Default: 30. */
  size?: number;
  /** Initial position as viewport fractions. Default: { x: 0.5, y: 0.5 }. */
  start?: CursorPoint;
}

export interface CursorMoveOptions {
  /** Override the distance-based 300–1100 ms travel duration. */
  durationMs?: number;
  /** Target point as fractions of the element's bounding box. */
  target?: CursorPoint;
}

export interface CursorClickOptions extends CursorMoveOptions {
  dwellMs?: number;
  holdMs?: number;
  afterMs?: number;
}

export interface HumanCursor {
  moveTo(target: Locator, options?: CursorMoveOptions): Promise<void>;
  click(target: Locator, options?: CursorClickOptions): Promise<void>;
  /** Hide the glyph until the next moveTo/click. The ring is independent. */
  hide(): Promise<void>;
  /** Remove the glyph, native-cursor override, and navigation listener. */
  dispose(): Promise<void>;
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function buildHumanCursorPath(from: CursorPoint, to: CursorPoint, seed: string, steps: number): CursorPoint[] {
  const count = Math.max(2, Math.round(steps));
  const next = seededRandom(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // Avoid subpixel roundoff turning a stationary path into one-pixel mouse
  // events when the browser converts client coordinates to integers.
  if (distance === 0) return Array.from({ length: count }, () => ({ ...from }));
  const normal = { x: -dy / Math.max(distance, 1), y: dx / Math.max(distance, 1) };
  const bend = Math.min(96, distance * 0.13) * (next() > 0.5 ? 1 : -1) * (0.72 + next() * 0.42);
  const a = { x: from.x + dx * 0.32 + normal.x * bend, y: from.y + dy * 0.32 + normal.y * bend };
  const b = { x: from.x + dx * 0.72 + normal.x * bend * 0.7, y: from.y + dy * 0.72 + normal.y * bend * 0.7 };
  return Array.from({ length: count }, (_, i) => {
    if (i === 0) return { ...from };
    if (i === count - 1) return { ...to };
    const progress = i / (count - 1);
    const t = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    const inverse = 1 - t;
    const noise = (next() - 0.5) * Math.min(1.4, distance / 180);
    return {
      x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * a.x + 3 * inverse * t ** 2 * b.x + t ** 3 * to.x + normal.x * noise,
      y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * a.y + 3 * inverse * t ** 2 * b.y + t ** 3 * to.y + normal.y * noise,
    };
  });
}

/**
 * Draw an SVG pointer and move it using real Playwright mouse events.
 * Pair with cursorHighlight() (or video.cursorHighlight) for a continuous ring
 * or mode:'click' locator animations. The glyph emits no duplicate feedback.
 */
export async function createHumanCursor(page: Page, options: HumanCursorOptions = {}): Promise<HumanCursor> {
  const size = options.size ?? 30;
  if (!Number.isFinite(size) || size <= 0) throw new Error('Cursor size must be positive.');
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  const start = options.start ?? { x: 0.5, y: 0.5 };
  let position = { x: Math.round(viewport.width * start.x), y: Math.round(viewport.height * start.y) };
  let movement = 0;
  let visible = true;
  let disposed = false;
  let restorePending = Promise.resolve();

  const install = async () => {
    if (disposed) return;
    await page.evaluate(({ id, styleId, size, position, visible }) => {
      const previous = document.getElementById(id) as (HTMLElement & { __cleanup?: () => void }) | null;
      previous?.__cleanup?.();
      previous?.remove();
      document.getElementById(styleId)?.remove();
      const style = document.createElement('style');
      style.id = styleId;
      // Same easing as cursorHighlight keeps the circle centered on the SVG
      // tip during travel. Offset the SVG's (2, 2) hotspot to the mouse point.
      style.textContent = `
        html, html * { cursor: none !important; }
        #${id} { position: fixed; z-index: 2147483647; pointer-events: none;
          width: ${size}px; height: ${size * 39 / 30}px;
          transform: translate(${-size * 2 / 30}px, ${-size * 2 / 30}px);
          transition: left .05s ease-out, top .05s ease-out; }
        #${id} svg { display: block; width: 100%; height: 100%; overflow: visible;
          filter: drop-shadow(0 2px 2px rgb(0 0 0 / .48)); }
        #${id}[data-pressed="true"] svg { transform: scale(.9); transform-origin: ${size * 2 / 30}px ${size * 2 / 30}px; }
      `;
      document.head.appendChild(style);
      const cursor = document.createElement('div');
      cursor.id = id;
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.left = position.x + 'px';
      cursor.style.top = position.y + 'px';
      cursor.style.visibility = visible ? 'visible' : 'hidden';
      // Static, author-owned SVG. Its tip is the actual click hotspot.
      cursor.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 39" aria-hidden="true">
        <path d="M2 2L2 30L9.4 23.5L15 36.5L21 33.8L15.4 21H26L2 2Z"
          fill="#fff" stroke="#111827" stroke-width="2.3" stroke-linejoin="round" />
      </svg>`;
      document.body.appendChild(cursor);
      const onMove = (event: MouseEvent) => {
        cursor.style.left = event.clientX + 'px';
        cursor.style.top = event.clientY + 'px';
      };
      const onDown = () => { cursor.dataset.pressed = 'true'; };
      const onUp = () => { cursor.dataset.pressed = 'false'; };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('mouseup', onUp, true);
      (cursor as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('mouseup', onUp, true);
      };
    }, { id: CURSOR_ID, styleId: STYLE_ID, size, position, visible });
  };
  const onNavigation = () => {
    restorePending = restorePending.then(install).catch((error: Error) => {
      if (!disposed && !page.isClosed() && !error.message.includes('destroyed')) {
        console.warn(`Warning: SVG cursor restoration failed: ${error.message}`);
      }
    });
  };
  // DOMContentLoaded runs after body exists. Unlike a permanent init script,
  // this listener can be removed by dispose(), including on future documents.
  page.on('domcontentloaded', onNavigation);
  try {
    await install();
    await page.mouse.move(position.x, position.y);
  } catch (error) {
    page.off('domcontentloaded', onNavigation);
    throw error;
  }

  const setVisible = async (value: boolean) => {
    if (disposed) throw new Error('This human cursor has been disposed.');
    await restorePending;
    visible = value;
    await page.evaluate(({ id, visible }) => {
      const cursor = document.getElementById(id);
      if (cursor) cursor.style.visibility = visible ? 'visible' : 'hidden';
    }, { id: CURSOR_ID, visible });
  };
  const moveTo = async (target: Locator, opts: CursorMoveOptions = {}) => {
    await setVisible(true);
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error('Cannot move the cursor to an invisible target.');
    // Land inside the control's padding so the pointer does not cover its label.
    const point = opts.target ?? { x: 0.08, y: 0.78 };
    const destination = { x: Math.round(box.x + box.width * point.x), y: Math.round(box.y + box.height * point.y) };
    const distance = Math.hypot(destination.x - position.x, destination.y - position.y);
    const duration = opts.durationMs ?? Math.min(1100, Math.max(300, 300 + 700 * distance / Math.hypot(viewport.width, viewport.height)));
    const steps = Math.min(64, Math.max(18, Math.round(duration / 16)));
    const path = buildHumanCursorPath(position, destination, `${options.seed ?? 'argo'}:${movement++}:${destination.x}:${destination.y}`, steps);
    for (const point of path.slice(1)) {
      await page.mouse.move(point.x, point.y);
      await page.waitForTimeout(duration / (path.length - 1));
    }
    position = destination;
  };
  return {
    moveTo,
    async click(target, opts = {}) {
      await moveTo(target, opts);
      await page.waitForTimeout(opts.dwellMs ?? 350);
      await page.mouse.down();
      await page.waitForTimeout(opts.holdMs ?? 90);
      await page.mouse.up();
      await page.waitForTimeout(opts.afterMs ?? 350);
    },
    hide: () => setVisible(false),
    async dispose() {
      if (disposed) return;
      disposed = true;
      page.off('domcontentloaded', onNavigation);
      await restorePending;
      if (page.isClosed()) return;
      await page.evaluate(({ id, styleId }) => {
        const cursor = document.getElementById(id) as (HTMLElement & { __cleanup?: () => void }) | null;
        cursor?.__cleanup?.();
        cursor?.remove();
        document.getElementById(styleId)?.remove();
      }, { id: CURSOR_ID, styleId: STYLE_ID });
    },
  };
}
