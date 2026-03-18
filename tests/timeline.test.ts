import { describe, expect, it } from 'vitest';
import {
  buildPlacementsFromTimingAndDurations,
  computeHeadTrimMs,
  shiftPlacements,
} from '../src/timeline.js';

describe('timeline helpers', () => {
  it('computes head trim with 200ms lead-in and 500ms floor', () => {
    expect(computeHeadTrimMs({ intro: 350 })).toBe(0);
    expect(computeHeadTrimMs({ intro: 900 })).toBe(700);
  });

  it('builds voiced placements with overlap avoidance and keeps silent scenes', () => {
    const timing = { intro: 1000, silent: 1500, outro: 1600 };
    const placements = buildPlacementsFromTimingAndDurations(
      timing,
      { intro: 1000, outro: 800 },
      4000,
    );

    expect(placements).toEqual([
      { scene: 'intro', startMs: 1000, endMs: 2000 },
      { scene: 'silent', startMs: 1500, endMs: 1600 },
      { scene: 'outro', startMs: 2100, endMs: 2900 },
    ]);
  });

  it('shifts placements while clamping to zero', () => {
    expect(shiftPlacements([{ scene: 'intro', startMs: 200, endMs: 900 }], 500)).toEqual([
      { scene: 'intro', startMs: 0, endMs: 400 },
    ]);
  });
});
