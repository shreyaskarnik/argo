import { describe, it, expect, vi, beforeEach } from 'vitest';
import { injectIntoZone, removeZone, ZONE_ID_PREFIX } from '../../src/overlays/zones.js';
import type { Page } from '@playwright/test';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
}

describe('ZONE_ID_PREFIX', () => {
  it('is argo-overlay-', () => {
    expect(ZONE_ID_PREFIX).toBe('argo-overlay-');
  });
});

describe('injectIntoZone', () => {
  let page: Page;

  beforeEach(() => {
    page = createMockPage();
  });

  it('calls page.evaluate with zone ID', async () => {
    await injectIntoZone(page, 'top-left', '<div>Hello</div>', { color: 'red' });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [fn, args] = (page.evaluate as any).mock.calls[0];
    expect(typeof fn).toBe('function');
    expect(args[0]).toBe('argo-overlay-top-left');
  });

  it('uses bottom-center zone ID correctly', async () => {
    await injectIntoZone(page, 'bottom-center', '<span>text</span>', {});
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args[0]).toBe('argo-overlay-bottom-center');
  });
});

describe('removeZone', () => {
  it('calls page.evaluate to remove element by zone ID', async () => {
    const page = createMockPage();
    await removeZone(page, 'top-left');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    const [fn, arg] = (page.evaluate as any).mock.calls[0];
    expect(typeof fn).toBe('function');
    expect(arg).toBe('argo-overlay-top-left');
  });
});
