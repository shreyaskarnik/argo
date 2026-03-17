import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cursorHighlight, resetCursor } from '../src/cursor.js';
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
