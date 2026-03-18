import { describe, expect, it } from 'vitest';
import {
  applySpeedRampToTimeline,
  buildSpeedRampFilter,
  computeSegments,
} from '../src/speed-ramp.js';

describe('speed ramp helpers', () => {
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
