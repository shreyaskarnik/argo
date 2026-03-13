import { describe, it, expect, vi, beforeEach } from 'vitest';
import { showOverlay, hideOverlay, withOverlay } from '../../src/overlays/index.js';
import type { Page } from '@playwright/test';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
}

describe('showOverlay', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('injects overlay and removes after duration', async () => {
    await showOverlay(page, 'intro', { type: 'lower-third', text: 'Hello' }, 2000);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
  });

  it('defaults to bottom-center zone', async () => {
    await showOverlay(page, 'intro', { type: 'lower-third', text: 'Hi' }, 1000);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args[0]).toContain('bottom-center');
  });

  it('uses specified zone', async () => {
    await showOverlay(page, 'intro', {
      type: 'headline-card', title: 'Title', placement: 'top-left',
    }, 1000);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args[0]).toContain('top-left');
  });
});

describe('hideOverlay', () => {
  it('removes overlay from specified zone', async () => {
    const page = createMockPage();
    await hideOverlay(page, 'top-left');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('defaults to bottom-center', async () => {
    const page = createMockPage();
    await hideOverlay(page);
    const [, arg] = (page.evaluate as any).mock.calls[0];
    expect(arg).toContain('bottom-center');
  });
});

describe('withOverlay', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('shows overlay during action and removes after', async () => {
    let actionRan = false;
    await withOverlay(page, 'demo', { type: 'callout', text: 'Watch' }, async () => {
      actionRan = true;
    });
    expect(actionRan).toBe(true);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('removes overlay even if action throws', async () => {
    await expect(
      withOverlay(page, 'demo', { type: 'lower-third', text: 'Hi' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
