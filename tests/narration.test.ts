import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
