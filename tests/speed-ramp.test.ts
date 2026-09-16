import { describe, expect, it } from 'vitest';
import {
  applySpeedRampToTimeline,
  buildSpeedRampFilter,
  computeSegments,
} from '../src/speed-ramp.js';

describe('speed ramp helpers', () => {
  it('caps output gaps without shortening scenes or already-short gaps', () => {
    const plan = applySpeedRampToTimeline(
      [
        { scene: 'intro', startMs: 1000, endMs: 3000 },
        { scene: 'detail', startMs: 16000, endMs: 19000 },
        { scene: 'outro', startMs: 23000, endMs: 25000 },
      ],
      29000,
      { gapSpeed: 1, maxGapMs: 2000 },
    );
    expect(plan.placements).toEqual([
      { scene: 'intro', startMs: 1000, endMs: 3000 },
      { scene: 'detail', startMs: 5000, endMs: 8000 },
      { scene: 'outro', startMs: 10000, endMs: 12000 },
    ]);
    expect(plan.totalDurationMs).toBe(14000);
  });

  it('uses the output cap instead of fixed-gap settings while preserving scene speed', () => {
    const plan = applySpeedRampToTimeline(
      [{ scene: 'detail', startMs: 4000, endMs: 8000 }],
      9000,
      { gapSpeed: 8, minGapMs: 10000, maxGapMs: 2000 },
      { detail: 2 },
    );
    expect(plan.placements).toEqual([{ scene: 'detail', startMs: 2000, endMs: 4000 }]);
    expect(plan.totalDurationMs).toBe(5000);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid output cap %s', (maxGapMs) => {
    expect(() => applySpeedRampToTimeline(
      [{ scene: 'intro', startMs: 0, endMs: 1000 }],
      2000,
      { gapSpeed: 1, maxGapMs },
    )).toThrow(/maxGapMs.*positive.*finite/);
  });

  it('computes gap and scene segments across the whole timeline', () => {
    const segments = computeSegments(
      [
        { scene: 'intro', startMs: 1000, endMs: 2000 },
        { scene: 'outro', startMs: 5000, endMs: 6000 },
      ],
      7000,
      { gapSpeed: 2.0, minGapMs: 500 },
    );

    expect(segments).toEqual([
      { startMs: 0, endMs: 1000, speed: 2.0 },
      { startMs: 1000, endMs: 2000, speed: 1.0 },
      { startMs: 2000, endMs: 5000, speed: 2.0 },
      { startMs: 5000, endMs: 6000, speed: 1.0 },
      { startMs: 6000, endMs: 7000, speed: 2.0 },
    ]);
  });

  it('remaps placements and total duration onto the ramped timeline', () => {
    const plan = applySpeedRampToTimeline(
      [
        { scene: 'intro', startMs: 1000, endMs: 2000 },
        { scene: 'outro', startMs: 5000, endMs: 6000 },
      ],
      7000,
      { gapSpeed: 2.0, minGapMs: 500 },
    );

    expect(plan.placements).toEqual([
      { scene: 'intro', startMs: 500, endMs: 1500 },
      { scene: 'outro', startMs: 3000, endMs: 4000 },
    ]);
    expect(plan.totalDurationMs).toBe(4500);
    expect(plan.segments.length).toBeGreaterThan(0);
  });

  it('builds filter_complex using separate video and audio inputs', () => {
    const filter = buildSpeedRampFilter(
      [
        { startMs: 0, endMs: 1000, speed: 2.0 },
        { startMs: 1000, endMs: 2000, speed: 1.0 },
      ],
      { video: '0:v', audio: '1:a' },
    );

    expect(filter?.filterComplex).toContain('[0:v]trim=start=0.000:end=1.000');
    expect(filter?.filterComplex).toContain('[1:a]atrim=start=0.000:end=1.000');
    expect(filter?.outputLabels).toEqual({ video: 'outv', audio: 'outa' });
  });
});
