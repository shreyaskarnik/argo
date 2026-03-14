import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '../src/camera.js';
import type { Page } from '@playwright/test';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
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
});

describe('resetCamera', () => {
  it('calls page.evaluate to clean up', async () => {
    const page = createMockPage();
    await resetCamera(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('swallows errors silently', async () => {
    const page = createMockPage();
    (page.evaluate as any).mockRejectedValue(new Error('page closed'));
    await expect(resetCamera(page)).resolves.toBeUndefined();
  });
});
