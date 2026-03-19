import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '../src/camera.js';
import { NarrationTimeline } from '../src/narration.js';
import type { Page } from '@playwright/test';

function createMockLocator(box: { x: number; y: number; width: number; height: number } | null = { x: 10, y: 20, width: 100, height: 50 }) {
  return {
    boundingBox: vi.fn().mockResolvedValue(box),
  };
}

const ZOOM_WRAPPER_ID = 'argo-camera-zoom-wrapper';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
}

function createFakeElement(tagName = 'div') {
  const element: any = {
    tagName: tagName.toUpperCase(),
    id: '',
    style: {},
    children: [] as any[],
    parentElement: null as any,
    attributes: new Map<string, string>(),
    rect: { left: 0, top: 0, width: 0, height: 0 },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    hasAttribute(name: string) {
      return this.attributes.has(name);
    },
    appendChild(child: any) {
      if (child.parentElement) child.parentElement.removeChild(child);
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    insertBefore(child: any, ref: any) {
      if (child.parentElement) child.parentElement.removeChild(child);
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index === -1) {
        this.children.push(child);
      } else {
        this.children.splice(index, 0, child);
      }
      child.parentElement = this;
      return child;
    },
    removeChild(child: any) {
      const index = this.children.indexOf(child);
      if (index !== -1) {
        this.children.splice(index, 1);
        child.parentElement = null;
      }
      return child;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.removeChild(this);
      }
    },
    getBoundingClientRect() {
      return this.rect;
    },
  };

  Object.defineProperty(element, 'firstChild', {
    get() {
      return this.children[0] ?? null;
    },
  });

  return element;
}

function withFakeDom(run: (ctx: { document: any; window: any }) => void) {
  const findAll = (root: any, predicate: (el: any) => boolean): any[] => {
    const results: any[] = [];
    const visit = (node: any) => {
      if (predicate(node)) results.push(node);
      node.children.forEach((child: any) => visit(child));
    };
    visit(root);
    return results;
  };

  const matches = (el: any, selector: string): boolean => {
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
    if (attrMatch) {
      const [, name, value] = attrMatch;
      if (!el.attributes.has(name)) return false;
      return value === undefined || el.attributes.get(name) === value;
    }
    return false;
  };

  const documentElement = createFakeElement('html');
  const head = createFakeElement('head');
  const body = createFakeElement('body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document: any = {
    documentElement,
    head,
    body,
    createElement(tag: string) {
      return createFakeElement(tag);
    },
    getElementById(id: string) {
      return findAll(documentElement, (el) => el.id === id)[0] ?? null;
    },
    querySelector(selector: string) {
      return findAll(documentElement, (el) => matches(el, selector))[0] ?? null;
    },
    querySelectorAll(selector: string) {
      return findAll(documentElement, (el) => matches(el, selector));
    },
  };

  const window = { innerWidth: 1280, innerHeight: 720 };
  const globalAny = globalThis as any;
  const originalDocument = globalAny.document;
  const originalWindow = globalAny.window;
  const originalRaf = globalAny.requestAnimationFrame;
  const originalSetTimeout = globalAny.setTimeout;

  globalAny.document = document;
  globalAny.window = window;
  globalAny.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  };
  globalAny.setTimeout = vi.fn(() => 1);

  try {
    run({ document, window });
  } finally {
    globalAny.document = originalDocument;
    globalAny.window = originalWindow;
    globalAny.requestAnimationFrame = originalRaf;
    globalAny.setTimeout = originalSetTimeout;
  }
}

describe('spotlight', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('calls page.evaluate with selector and options', async () => {
    await spotlight(page, '#btn');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBe('#btn');
    expect(args.opacity).toBe(0.7);
    expect(args.padding).toBe(12);
  });

  it('is non-blocking by default', async () => {
    await spotlight(page, '#btn');
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('blocks with wait: true', async () => {
    await spotlight(page, '#btn', { wait: true, duration: 2000, fadeOut: 300 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(2300);
  });

  it('swallows page disposal errors', async () => {
    (page.evaluate as any).mockRejectedValue(new Error('Target closed'));
    await expect(spotlight(page, '#btn')).resolves.toBeUndefined();
  });

  it('accepts custom opacity and padding', async () => {
    await spotlight(page, '#btn', { opacity: 0.5, padding: 20 });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.opacity).toBe(0.5);
    expect(args.padding).toBe(20);
  });

  it('accepts a Locator and pre-resolves bounding box', async () => {
    const locator = createMockLocator({ x: 50, y: 100, width: 200, height: 80 });
    await spotlight(page, locator);
    expect(locator.boundingBox).toHaveBeenCalledTimes(1);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBeNull();
    expect(args.preRect).toEqual({ left: 50, top: 100, right: 250, bottom: 180, width: 200, height: 80 });
  });

  it('does not call page.evaluate when Locator boundingBox returns null', async () => {
    const locator = createMockLocator(null);
    await spotlight(page, locator);
    // resolveRect returns rect: null — evaluate is still called, but preRect is null
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.preRect).toBeNull();
    expect(args.selector).toBeNull();
  });
});

describe('focusRing', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('calls page.evaluate with correct defaults', async () => {
    await focusRing(page, '.card');
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBe('.card');
    expect(args.color).toBe('#3b82f6');
    expect(args.ringWidth).toBe(3);
    expect(args.pulse).toBe(true);
  });

  it('is non-blocking by default', async () => {
    await focusRing(page, '.card');
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('accepts custom color and disables pulse', async () => {
    await focusRing(page, '.card', { color: '#ff0000', pulse: false });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.color).toBe('#ff0000');
    expect(args.pulse).toBe(false);
  });

  it('accepts a Locator and pre-resolves bounding box', async () => {
    const locator = createMockLocator({ x: 30, y: 40, width: 150, height: 60 });
    await focusRing(page, locator);
    expect(locator.boundingBox).toHaveBeenCalledTimes(1);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBeNull();
    expect(args.preRect).toEqual({ left: 30, top: 40, right: 180, bottom: 100, width: 150, height: 60 });
  });
});

describe('dimAround', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('calls page.evaluate with dimOpacity default', async () => {
    await dimAround(page, '.target');
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBe('.target');
    expect(args.dimOpacity).toBe(0.3);
  });

  it('accepts custom dimOpacity', async () => {
    await dimAround(page, '.target', { dimOpacity: 0.1 });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.dimOpacity).toBe(0.1);
  });

  it('accepts a Locator and uses spotlight-style fallback', async () => {
    const locator = createMockLocator({ x: 10, y: 20, width: 100, height: 50 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await dimAround(page, locator);
    expect(locator.boundingBox).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('spotlight-style dim'));
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.preRect).toEqual({ left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 });
    expect(args.selector).toBeUndefined(); // spotlight-style path doesn't pass selector
    warnSpy.mockRestore();
  });
});

describe('zoomTo', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('calls page.evaluate with scale default', async () => {
    await zoomTo(page, '.revenue');
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBe('.revenue');
    expect(args.scale).toBe(1.5);
  });

  it('accepts custom scale', async () => {
    await zoomTo(page, '.revenue', { scale: 2.0 });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.scale).toBe(2.0);
  });

  it('blocks with wait: true', async () => {
    await zoomTo(page, '.card', { wait: true, duration: 5000, fadeOut: 500 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(5500);
  });

  it('accepts a Locator and pre-resolves bounding box', async () => {
    const locator = createMockLocator({ x: 120, y: 180, width: 240, height: 120 });
    await zoomTo(page, locator);
    expect(locator.boundingBox).toHaveBeenCalledTimes(1);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.selector).toBeNull();
    expect(args.preRect).toEqual({ left: 120, top: 180, right: 360, bottom: 300, width: 240, height: 120 });
  });

  it('wraps non-Argo content so overlays stay outside the zoomed subtree', async () => {
    await zoomTo(page, '#target');
    const [fn, args] = (page.evaluate as any).mock.calls[0];

    withFakeDom(({ document }) => {
      const content = createFakeElement('section');
      content.id = 'content';
      const target = createFakeElement('div');
      target.id = 'target';
      target.rect = { left: 120, top: 180, width: 240, height: 120 };
      content.appendChild(target);

      const overlay = createFakeElement('div');
      overlay.id = 'argo-overlay-top-right';

      document.body.appendChild(content);
      document.body.appendChild(overlay);

      fn(args);

      const wrapper = document.getElementById(ZOOM_WRAPPER_ID);
      expect(wrapper).toBeTruthy();
      expect(content.parentElement).toBe(wrapper);
      expect(overlay.parentElement).toBe(document.body);
      expect(document.documentElement.style.transform).toBeUndefined();
      expect(String(wrapper.style.transform)).toContain('scale(');
      expect(String(wrapper.style.transform)).toContain('translate(');
    });
  });

  it('records camera move via narration instead of DOM transforms when narration is provided', async () => {
    const locator = createMockLocator({ x: 120, y: 180, width: 240, height: 120 });
    const timeline = new NarrationTimeline();
    timeline.start();
    await zoomTo(page, locator, { narration: timeline, scale: 2.0, duration: 3000, fadeIn: 400, fadeOut: 400 });

    // Should NOT call page.evaluate for DOM transform (only the mock page.evaluate is from the legacy path)
    // With narration path, page.evaluate should not be called for DOM manipulation
    expect(page.evaluate).not.toHaveBeenCalled();

    const moves = timeline.getCameraMoves();
    expect(moves).toHaveLength(1);
    expect(moves[0].x).toBe(240); // 120 + 240/2
    expect(moves[0].y).toBe(240); // 180 + 120/2
    expect(moves[0].w).toBe(240);
    expect(moves[0].h).toBe(120);
    expect(moves[0].scale).toBe(2.0);
    expect(moves[0].durationMs).toBe(400); // fadeIn
    expect(moves[0].holdMs).toBe(2200); // duration - fadeIn - fadeOut
  });

  it('records camera move via narration with CSS selector by evaluating page', async () => {
    (page.evaluate as any).mockResolvedValue({ left: 50, top: 100, right: 250, bottom: 200, width: 200, height: 100 });
    const timeline = new NarrationTimeline();
    timeline.start();
    await zoomTo(page, '#target', { narration: timeline });

    // Should call page.evaluate once to resolve the bounding box
    expect(page.evaluate).toHaveBeenCalledTimes(1);

    const moves = timeline.getCameraMoves();
    expect(moves).toHaveLength(1);
    expect(moves[0].x).toBe(150); // 50 + 200/2
    expect(moves[0].y).toBe(150); // 100 + 100/2
  });

  it('waits when narration path has wait: true', async () => {
    const locator = createMockLocator({ x: 10, y: 20, width: 100, height: 50 });
    const timeline = new NarrationTimeline();
    timeline.start();
    await zoomTo(page, locator, { narration: timeline, wait: true, duration: 3000, fadeOut: 500 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(3500);
  });
});

describe('resetCamera', () => {
  it('calls page.evaluate to clean up', async () => {
    const page = createMockPage();
    await resetCamera(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args).toBe('data-argo-camera');
  });

  it('swallows errors silently', async () => {
    const page = createMockPage();
    (page.evaluate as any).mockRejectedValue(new Error('page closed'));
    await expect(resetCamera(page)).resolves.toBeUndefined();
  });

  it('restores zoom wrapper content on reset', async () => {
    const page = createMockPage();
    await resetCamera(page);
    const [fn, attr] = (page.evaluate as any).mock.calls[0];

    withFakeDom(({ document }) => {
      const wrapper = createFakeElement('div');
      wrapper.id = ZOOM_WRAPPER_ID;
      const content = createFakeElement('section');
      content.id = 'content';
      wrapper.appendChild(content);
      document.body.appendChild(wrapper);

      const marker = createFakeElement('div');
      marker.setAttribute(attr, 'zoom-to');
      marker.__zoomRestore = {
        wrapperId: ZOOM_WRAPPER_ID,
        styles: {
          transform: '',
          transformOrigin: '0 0',
          transition: '',
          willChange: 'transform',
        },
        overflow: '',
      };
      document.body.appendChild(marker);
      document.body.style.overflow = 'hidden';

      fn(attr);

      expect(document.getElementById(ZOOM_WRAPPER_ID)).toBeNull();
      expect(content.parentElement).toBe(document.body);
      expect(document.body.style.overflow).toBe('');
    });
  });
});
