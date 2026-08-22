import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cursorHighlight, ensureCursorHighlight, resetCursor } from '../src/cursor.js';
import type { Page } from '@playwright/test';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
}

describe('cursorHighlight', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('injects cursor highlight via page.evaluate', async () => {
    await cursorHighlight(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('passes default options to page.evaluate', async () => {
    await cursorHighlight(page);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.color).toBe('#3b82f6');
    expect(args.radius).toBe(20);
    expect(args.pulse).toBe(true);
    expect(args.clickRipple).toBe(true);
    expect(args.opacity).toBe(0.5);
    expect(args.id).toBe('argo-cursor-highlight');
    expect(args.attr).toBe('data-argo-cursor');
  });

  it('accepts custom color and radius', async () => {
    await cursorHighlight(page, { color: '#ff0000', radius: 30 });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.color).toBe('#ff0000');
    expect(args.radius).toBe(30);
  });

  it('accepts custom opacity', async () => {
    await cursorHighlight(page, { opacity: 0.8 });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.opacity).toBe(0.8);
  });

  it('can disable pulse and click ripple', async () => {
    await cursorHighlight(page, { pulse: false, clickRipple: false });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.pulse).toBe(false);
    expect(args.clickRipple).toBe(false);
  });

  it('swallows page disposal errors', async () => {
    (page.evaluate as any).mockRejectedValue(new Error('Target closed'));
    await expect(cursorHighlight(page)).resolves.toBeUndefined();
  });

  it('swallows context destroyed errors', async () => {
    (page.evaluate as any).mockRejectedValue(new Error('context destroyed'));
    await expect(cursorHighlight(page)).resolves.toBeUndefined();
  });

  it('warns on non-disposal errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (page.evaluate as any).mockRejectedValue(new Error('something unexpected'));
    await cursorHighlight(page);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('cursor highlight failed'));
    warnSpy.mockRestore();
  });
});

describe('resetCursor', () => {
  it('calls page.evaluate to clean up', async () => {
    const page = createMockPage();
    await resetCursor(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.attr).toBe('data-argo-cursor');
    expect(args.id).toBe('argo-cursor-highlight');
  });

  it('swallows errors silently', async () => {
    const page = createMockPage();
    (page.evaluate as any).mockRejectedValue(new Error('page closed'));
    await expect(resetCursor(page)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Browser-side behaviour. The function handed to `page.evaluate` is captured
// from the mock and executed against a minimal DOM stub, so the injection
// logic itself (not just its arguments) is under test.
// ---------------------------------------------------------------------------

class FakeEl {
  id = '';
  textContent = '';
  style: any = { cssText: '' };
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private attrs = new Map<string, string>();
  constructor(public tagName: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  hasAttribute(k: string) { return this.attrs.has(k); }
  appendChild(c: FakeEl) { c.parent = this; this.children.push(c); return c; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
}

function createFakeDom({ withBody }: { withBody: boolean }) {
  const documentElement = new FakeEl('html');
  const head = new FakeEl('head');
  documentElement.appendChild(head);
  let body: FakeEl | null = null;
  if (withBody) body = documentElement.appendChild(new FakeEl('body'));

  const listeners: Array<{ type: string; fn: any }> = [];
  const walk = (el: FakeEl): FakeEl[] => [el, ...el.children.flatMap(walk)];
  const all = () => walk(documentElement);

  const document: any = {
    documentElement,
    head,
    get body() { return body; },
    createElement: (tag: string) => new FakeEl(tag),
    getElementById: (id: string) => all().find((e) => e.id === id) ?? null,
    querySelectorAll: (sel: string) => {
      const attr = sel.replace(/^\[|\]$/g, '');
      return all().filter((e) => e.hasAttribute(attr));
    },
    addEventListener: (type: string, fn: any) => { listeners.push({ type, fn }); },
    removeEventListener: (type: string, fn: any) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };

  // Deferred installs (DOMContentLoaded) run outside the evaluate call, so
  // every entry point that can execute page code installs the globals.
  let win: any = {};
  const withGlobals = <T>(cb: () => T): T => {
    const prevDoc = (globalThis as any).document;
    const prevWin = (globalThis as any).window;
    (globalThis as any).document = document;
    (globalThis as any).window = win;
    try { return cb(); } finally {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
    }
  };

  return {
    document,
    listeners,
    withGlobals,
    setWindow: (w: any) => { win = w; },
    attachBody: () => { body = documentElement.appendChild(new FakeEl('body')); },
    fire: (type: string, ev?: any) => withGlobals(() => {
      for (const l of [...listeners].filter((l) => l.type === type)) l.fn(ev);
    }),
    ring: () => document.getElementById('argo-cursor-highlight') as FakeEl | null,
  };
}

async function runInjection(
  fn: (page: Page, opts?: any) => Promise<void>,
  dom: ReturnType<typeof createFakeDom>,
  win: any,
  opts?: any,
) {
  const page = createMockPage();
  await fn(page, opts);
  const [browserFn, args] = (page.evaluate as any).mock.calls[0];
  dom.setWindow(win);
  dom.withGlobals(() => browserFn(args));
}

describe('cursor injection (browser side)', () => {
  it('installs the ring immediately when document.body exists', async () => {
    const dom = createFakeDom({ withBody: true });
    await runInjection(cursorHighlight, dom, {});
    expect(dom.ring()).not.toBeNull();
    expect(dom.ring()!.parent!.tagName).toBe('body');
  });

  it('defers installation until DOMContentLoaded when body is not parsed yet', async () => {
    // `framenavigated` fires at navigation commit — the parser may not have
    // produced <body>. The old code called document.body.appendChild and threw.
    const dom = createFakeDom({ withBody: false });
    const win: any = {};

    await expect(runInjection(cursorHighlight, dom, win)).resolves.toBeUndefined();
    expect(dom.ring()).toBeNull();
    expect(win.__argoCursorPending).toBe(true);
    expect(dom.listeners.some((l) => l.type === 'DOMContentLoaded')).toBe(true);

    dom.attachBody();
    dom.fire('DOMContentLoaded');
    expect(dom.ring()).not.toBeNull();
    expect(win.__argoCursorPending).toBe(false);
  });

  it('ensureCursorHighlight is a no-op when a ring is already installed', async () => {
    const dom = createFakeDom({ withBody: true });
    const win: any = {};
    await runInjection(cursorHighlight, dom, win);
    const first = dom.ring();
    const genAfterFirst = win.__argoCursorGen;

    await runInjection(ensureCursorHighlight, dom, win);
    expect(dom.ring()).toBe(first);           // same node, not rebuilt
    expect(win.__argoCursorGen).toBe(genAfterFirst);
  });

  it('ensureCursorHighlight is a no-op while an install is queued', async () => {
    const dom = createFakeDom({ withBody: false });
    const win: any = {};
    await runInjection(cursorHighlight, dom, win);
    const queued = dom.listeners.filter((l) => l.type === 'DOMContentLoaded').length;

    await runInjection(ensureCursorHighlight, dom, win);
    expect(dom.listeners.filter((l) => l.type === 'DOMContentLoaded')).toHaveLength(queued);
  });

  it('ensureCursorHighlight installs when no ring is present', async () => {
    const dom = createFakeDom({ withBody: true });
    await runInjection(ensureCursorHighlight, dom, {});
    expect(dom.ring()).not.toBeNull();
  });

  it('replacing a ring runs the previous cleanup so listeners do not leak', async () => {
    const dom = createFakeDom({ withBody: true });
    const win: any = {};
    await runInjection(cursorHighlight, dom, win);
    const before = dom.listeners.filter((l) => l.type === 'mousemove' || l.type === 'click').length;
    expect(before).toBe(2);

    // cursorHighlight() explicitly replaces — the old document listeners must go.
    await runInjection(cursorHighlight, dom, win);
    const after = dom.listeners.filter((l) => l.type === 'mousemove' || l.type === 'click').length;
    expect(after).toBe(2);
  });

  it('a superseded deferred install does not stack a second ring', async () => {
    const dom = createFakeDom({ withBody: false });
    const win: any = {};
    await runInjection(cursorHighlight, dom, win);
    await runInjection(cursorHighlight, dom, win);

    dom.attachBody();
    dom.fire('DOMContentLoaded');

    const rings = dom.document.querySelectorAll('[data-argo-cursor]')
      .filter((e: FakeEl) => e.id === 'argo-cursor-highlight');
    expect(rings).toHaveLength(1);
  });
});
