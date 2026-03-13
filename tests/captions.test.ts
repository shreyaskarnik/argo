import { describe, it, expect, vi } from 'vitest';
import { showCaption, hideCaption, withCaption } from '../src/captions.js';

function createMockPage() {
  const calls: string[] = [];
  const page = {
    evaluate: vi.fn(async () => {
      calls.push('evaluate');
    }),
    waitForTimeout: vi.fn(async () => {
      calls.push('waitForTimeout');
    }),
  };
  return { page: page as any, calls };
}

// ---------- showCaption ----------
describe('showCaption', () => {
  it('calls evaluate to inject, waits for duration, then calls evaluate to remove', async () => {
    const { page, calls } = createMockPage();
    await showCaption(page, 'intro', 'Hello world', 3000);

    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(3000);
    expect(calls).toEqual(['evaluate', 'waitForTimeout', 'evaluate']);
  });
});

// ---------- hideCaption ----------
describe('hideCaption', () => {
  it('calls evaluate once to remove the overlay', async () => {
    const { page } = createMockPage();
    await hideCaption(page);

    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});

// ---------- withCaption ----------
describe('withCaption', () => {
  it('shows caption, runs action, then hides caption in order', async () => {
    const order: string[] = [];
    const page = {
      evaluate: vi.fn(async () => {
        order.push('evaluate');
      }),
      waitForTimeout: vi.fn(async () => {
        order.push('waitForTimeout');
      }),
    } as any;

    const action = async () => {
      order.push('action');
    };

    await withCaption(page, 'demo', 'Doing stuff', action);

    // inject, action, remove
    expect(order).toEqual(['evaluate', 'action', 'evaluate']);
  });

  it('hides caption even if action throws', async () => {
    const { page } = createMockPage();

    const failingAction = async () => {
      throw new Error('boom');
    };

    await expect(
      withCaption(page, 'demo', 'Failing', failingAction),
    ).rejects.toThrow('boom');

    // Should still have called evaluate twice: inject + remove
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});
