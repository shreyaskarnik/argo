import { describe, it, expect, vi, beforeEach } from 'vitest';
import { showConfetti } from '../src/effects.js';
import type { Page } from '@playwright/test';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
}

describe('showConfetti', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('injects confetti via page.evaluate', async () => {
    await showConfetti(page);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('is non-blocking by default (does not call waitForTimeout)', async () => {
    await showConfetti(page);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('blocks when wait: true', async () => {
    await showConfetti(page, { wait: true });
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000 + 800); // duration + fadeOut
  });

  it('blocks with custom duration and fadeOut when wait: true', async () => {
    await showConfetti(page, { wait: true, duration: 5000, fadeOut: 500 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(5500);
  });

  it('passes spread, pieces, colors, duration, fadeOut to page.evaluate', async () => {
    await showConfetti(page, {
      spread: 'rain',
      pieces: 200,
      colors: ['#ff0000'],
      duration: 2000,
      fadeOut: 500,
    });
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args).toEqual({
      pieces: 200,
      spread: 'rain',
      colors: ['#ff0000'],
      duration: 2000,
      fadeOut: 500,
      id: 'argo-confetti',
    });
  });

  it('uses burst spread by default', async () => {
    await showConfetti(page);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.spread).toBe('burst');
  });

  it('uses default values when no options provided', async () => {
    await showConfetti(page);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args.pieces).toBe(150);
    expect(args.duration).toBe(3000);
    expect(args.fadeOut).toBe(800);
  });

  it('swallows errors from page.evaluate (fire-and-forget safe)', async () => {
    (page.evaluate as any).mockRejectedValue(new Error('page closed'));
    // Should not throw
    await expect(showConfetti(page)).resolves.toBeUndefined();
  });

  it('swallows errors even with wait: true', async () => {
    (page.evaluate as any).mockRejectedValue(new Error('context destroyed'));
    await expect(showConfetti(page, { wait: true })).resolves.toBeUndefined();
  });
});
