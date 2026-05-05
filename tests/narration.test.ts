import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { NarrationTimeline } from '../src/narration.js';

// ---------- start ----------
describe('start', () => {
  it('sets t=0 — a mark immediately after should be <50ms', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('intro');
    const timings = timeline.getTimings();
    expect(timings.intro).toBeGreaterThanOrEqual(0);
    expect(timings.intro).toBeLessThan(50);
  });

  it('clears existing timings on re-start', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('scene1');
    timeline.start();
    expect(timeline.getTimings()).toEqual({});
  });
});

// ---------- mark ----------
describe('mark', () => {
  it('throws if called before start()', () => {
    const timeline = new NarrationTimeline();
    expect(() => timeline.mark('intro')).toThrow();
  });

  it('records elapsed ms (~100ms delay)', async () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    await new Promise((r) => setTimeout(r, 100));
    timeline.mark('after-delay');
    const timings = timeline.getTimings();
    expect(timings['after-delay']).toBeGreaterThanOrEqual(80);
    expect(timings['after-delay']).toBeLessThan(300);
  });

  it('throws on duplicate scene name', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('scene1');
    expect(() => timeline.mark('scene1')).toThrow();
  });
});

// ---------- getTimings ----------
describe('getTimings', () => {
  it('returns empty object before any marks', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    expect(timeline.getTimings()).toEqual({});
  });

  it('returns all recorded marks', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('a');
    timeline.mark('b');
    timeline.mark('c');
    const timings = timeline.getTimings();
    expect(Object.keys(timings)).toEqual(['a', 'b', 'c']);
  });

  it('returns a copy — mutations do not affect internal state', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('scene1');
    const timings = timeline.getTimings();
    timings.scene1 = 99999;
    timings.injected = 1;
    const fresh = timeline.getTimings();
    expect(fresh.scene1).not.toBe(99999);
    expect(fresh).not.toHaveProperty('injected');
  });
});

// ---------- paint-trigger ----------
describe('mark — paint trigger', () => {
  it('calls page.evaluate after mark() once recording page is attached', () => {
    const timeline = new NarrationTimeline();
    timeline.start();

    const evaluate = vi.fn().mockResolvedValue(undefined);
    // Stand in for the real Playwright page just enough to satisfy
    // _triggerPaint(). The other ScreencastPage members aren't exercised here.
    (timeline as unknown as { _recordingPage: unknown })._recordingPage = { evaluate };

    timeline.mark('intro');
    expect(evaluate).toHaveBeenCalledTimes(1);
    // The injected function does the documentElement nudge — the runtime
    // doesn't get to inspect its body, but it must be a function.
    expect(typeof evaluate.mock.calls[0][0]).toBe('function');
  });

  it('does not call page.evaluate when no recording page is set', () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    // No page attached — mark() must not throw or attempt paint trigger.
    expect(() => timeline.mark('intro')).not.toThrow();
  });

  it('swallows page.evaluate rejections (page disposed during teardown)', async () => {
    const timeline = new NarrationTimeline();
    timeline.start();

    const evaluate = vi.fn().mockRejectedValue(new Error('Target page closed'));
    (timeline as unknown as { _recordingPage: unknown })._recordingPage = { evaluate };

    timeline.mark('intro');
    // Drain microtasks so the .catch() runs; nothing should throw.
    await Promise.resolve();
    expect(evaluate).toHaveBeenCalled();
  });
});

// ---------- flush ----------
describe('flush', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'argo-narration-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a .timing.json file', async () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('intro');
    timeline.mark('outro');
    const outPath = join(tmpDir, 'demo.timing.json');
    await timeline.flush(outPath);

    const raw = await readFile(outPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data).toHaveProperty('intro');
    expect(data).toHaveProperty('outro');
    expect(typeof data.intro).toBe('number');
  });

  it('creates parent directories if they do not exist', async () => {
    const timeline = new NarrationTimeline();
    timeline.start();
    timeline.mark('scene1');
    const outPath = join(tmpDir, 'nested', 'deep', 'output.timing.json');
    await timeline.flush(outPath);

    const info = await stat(outPath);
    expect(info.isFile()).toBe(true);
  });
});

// ---------- durationFor ----------
describe('durationFor', () => {
  it('returns fallback when no durations loaded', () => {
    const timeline = new NarrationTimeline();
    expect(timeline.durationFor('missing')).toBe(5000);
  });

  it('returns custom fallback', () => {
    const timeline = new NarrationTimeline();
    expect(timeline.durationFor('missing', { fallbackMs: 7000 })).toBe(7000);
  });

  it('computes duration from clip length with default lead-in/out', () => {
    const timeline = new NarrationTimeline({ hero: 4000 });
    // 4000 * 1 + 200 + 400 = 4600
    expect(timeline.durationFor('hero')).toBe(4600);
  });

  it('applies multiplier', () => {
    const timeline = new NarrationTimeline({ hero: 4000 });
    // 4000 * 1.2 + 200 + 400 = 5400
    expect(timeline.durationFor('hero', { multiplier: 1.2 })).toBe(5400);
  });

  it('clamps to minMs', () => {
    const timeline = new NarrationTimeline({ short: 500 });
    // 500 * 1 + 200 + 400 = 1100, but min is 2200
    expect(timeline.durationFor('short')).toBe(2200);
  });

  it('clamps to maxMs', () => {
    const timeline = new NarrationTimeline({ long: 20000 });
    // 20000 * 1 + 200 + 400 = 20600, under default max of 30000
    expect(timeline.durationFor('long')).toBe(20600);
    // Explicit maxMs still works
    expect(timeline.durationFor('long', { maxMs: 8000 })).toBe(8000);
  });

  it('respects custom min/max', () => {
    const timeline = new NarrationTimeline({ scene: 500 });
    // 500 + 200 + 400 = 1100, custom min 1000
    expect(timeline.durationFor('scene', { minMs: 1000, maxMs: 2000 })).toBe(1100);
  });

  it('returns the remaining wait once a marked scene is already in progress', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const timeline = new NarrationTimeline({ hero: 4000 });
    timeline.start();
    timeline.mark('hero');

    vi.advanceTimersByTime(1000);

    expect(timeline.durationFor('hero')).toBe(3600);
    vi.useRealTimers();
  });

  it('extends later scenes when earlier audio pushes the schedule back', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const timeline = new NarrationTimeline({ first: 4000, second: 500 });
    timeline.start();
    timeline.mark('first');

    vi.advanceTimersByTime(1000);
    timeline.mark('second');

    expect(timeline.durationFor('second')).toBe(4000);
    vi.useRealTimers();
  });
});

describe('sceneDuration', () => {
  it('returns the same value before and after time elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeline = new NarrationTimeline({ hero: 4000 });
    timeline.start();
    timeline.mark('hero');
    const before = timeline.sceneDuration('hero');
    vi.advanceTimersByTime(2000);
    expect(timeline.sceneDuration('hero')).toBe(before);
    vi.useRealTimers();
  });

  it('returns fallback for unknown scene', () => {
    const timeline = new NarrationTimeline();
    expect(timeline.sceneDuration('missing')).toBe(5000);
  });
});

describe('_closeRecording', () => {
  it('throws when stream finalization fails', async () => {
    const timeline = new NarrationTimeline();
    const stop = vi.fn().mockResolvedValue(undefined);
    const cleanup = vi.fn().mockRejectedValue(new Error('concat exited 1'));
    (timeline as unknown as { _screencastStop: unknown })._screencastStop = stop;
    (timeline as unknown as { _streamCleanup: unknown })._streamCleanup = cleanup;

    await expect(timeline._closeRecording()).rejects.toThrow(
      'Recording teardown failed: failed to finalize stream-encode: concat exited 1',
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('surfaces both stop and cleanup failures', async () => {
    const timeline = new NarrationTimeline();
    const stop = vi.fn().mockRejectedValue(new Error('stop failed'));
    const cleanup = vi.fn().mockRejectedValue(new Error('cleanup failed'));
    (timeline as unknown as { _screencastStop: unknown })._screencastStop = stop;
    (timeline as unknown as { _streamCleanup: unknown })._streamCleanup = cleanup;

    await expect(timeline._closeRecording()).rejects.toThrow(
      'Recording teardown failed: failed to stop screencast: stop failed; failed to finalize stream-encode: cleanup failed',
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
