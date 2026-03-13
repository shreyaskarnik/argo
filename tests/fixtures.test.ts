import { describe, it, expect, vi } from 'vitest';
import { createNarrationFixture, demoType } from '../src/fixtures.js';

// ---------- createNarrationFixture ----------
describe('createNarrationFixture', () => {
  it('creates timeline, calls start, provides it via use, calls flush after', async () => {
    const mockTimeline = {
      start: vi.fn(),
      mark: vi.fn(),
      getTimings: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const factory = vi.fn().mockReturnValue(mockTimeline);

    let provided: unknown;
    const use = vi.fn(async (value: unknown) => {
      provided = value;
    });
    const testInfo = { title: 'my test' };

    const fixture = createNarrationFixture(factory);
    await fixture({ /* placeholder */ } as any, use, testInfo as any);

    expect(factory).toHaveBeenCalledWith('my test');
    expect(mockTimeline.start).toHaveBeenCalled();
    expect(use).toHaveBeenCalledWith(mockTimeline);
    expect(provided).toBe(mockTimeline);
    expect(mockTimeline.flush).toHaveBeenCalled();
  });

  it('calls flush even if test (use callback) throws', async () => {
    const mockTimeline = {
      start: vi.fn(),
      mark: vi.fn(),
      getTimings: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    };
    const factory = vi.fn().mockReturnValue(mockTimeline);

    const use = vi.fn(async () => {
      throw new Error('test failure');
    });
    const testInfo = { title: 'failing test' };

    const fixture = createNarrationFixture(factory);
    await expect(fixture({} as any, use, testInfo as any)).rejects.toThrow('test failure');

    expect(mockTimeline.flush).toHaveBeenCalled();
  });
});

// ---------- demoType ----------
describe('demoType', () => {
  it('calls locator(selector).pressSequentially(text, {delay: 60})', async () => {
    const pressSequentially = vi.fn().mockResolvedValue(undefined);
    const locator = vi.fn().mockReturnValue({ pressSequentially });
    const page = { locator } as any;

    await demoType(page, '#input', 'hello');

    expect(locator).toHaveBeenCalledWith('#input');
    expect(pressSequentially).toHaveBeenCalledWith('hello', { delay: 60 });
  });

  it('accepts custom delay', async () => {
    const pressSequentially = vi.fn().mockResolvedValue(undefined);
    const locator = vi.fn().mockReturnValue({ pressSequentially });
    const page = { locator } as any;

    await demoType(page, '#input', 'hello', 120);

    expect(pressSequentially).toHaveBeenCalledWith('hello', { delay: 120 });
  });
});
