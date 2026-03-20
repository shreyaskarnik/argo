import { describe, expect, it } from 'vitest';
import {
  resolveFreezes,
  buildFreezeFilter,
  adjustPlacementsForFreezes,
  totalFreezeDurationMs,
  type FreezeSpec,
  type ResolvedFreeze,
} from '../src/freeze.js';

describe('resolveFreezes', () => {
  it('converts scene-relative offsets to absolute timeline positions', () => {
    const freezes: FreezeSpec[] = [
      { scene: 'intro', atMs: 500, durationMs: 1000 },
      { scene: 'cta', atMs: 1800, durationMs: 1200 },
    ];
    const placements = [
      { scene: 'intro', startMs: 0, endMs: 3000 },
      { scene: 'cta', startMs: 5000, endMs: 8000 },
    ];

    const resolved = resolveFreezes(freezes, placements);

    expect(resolved).toEqual([
      { absoluteMs: 500, durationMs: 1000 },
      { absoluteMs: 6800, durationMs: 1200 },
    ]);
  });

  it('drops freezes for scenes not in placements', () => {
    const freezes: FreezeSpec[] = [
      { scene: 'missing', atMs: 100, durationMs: 500 },
    ];
    const placements = [{ scene: 'intro', startMs: 0, endMs: 3000 }];

    expect(resolveFreezes(freezes, placements)).toEqual([]);
  });

  it('sorts resolved freezes chronologically', () => {
    const freezes: FreezeSpec[] = [
      { scene: 'outro', atMs: 200, durationMs: 500 },
      { scene: 'intro', atMs: 100, durationMs: 500 },
    ];
    const placements = [
      { scene: 'intro', startMs: 0, endMs: 3000 },
      { scene: 'outro', startMs: 5000, endMs: 8000 },
    ];

    const resolved = resolveFreezes(freezes, placements);
    expect(resolved[0].absoluteMs).toBe(100);
    expect(resolved[1].absoluteMs).toBe(5200);
  });
});

describe('buildFreezeFilter', () => {
  it('returns null for empty freezes', () => {
    expect(buildFreezeFilter([], 10000, '0:v')).toBeNull();
  });

  it('generates trim+tpad+concat for a single freeze', () => {
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 2000, durationMs: 1000 },
    ];

    const result = buildFreezeFilter(freezes, 5000, '0:v');
    expect(result).not.toBeNull();
    expect(result!.outputLabel).toBe('frzout');
    expect(result!.addedDurationMs).toBe(1000);

    // Should contain: trim before, frozen frame with tpad, trim after, concat
    expect(result!.filter).toContain('trim=start=0.000:end=2.000');
    expect(result!.filter).toContain('tpad=stop_mode=clone:stop_duration=1.000');
    expect(result!.filter).toContain('trim=start=2.000:end=5.000');
    expect(result!.filter).toContain('concat=n=3:v=1:a=0[frzout]');
  });

  it('generates correct filter for multiple freezes', () => {
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 1000, durationMs: 500 },
      { absoluteMs: 3000, durationMs: 800 },
    ];

    const result = buildFreezeFilter(freezes, 5000, '0:v');
    expect(result).not.toBeNull();
    expect(result!.addedDurationMs).toBe(1300);

    // Should have 5 segments: before1, hold1, before2, hold2, after
    expect(result!.filter).toContain('concat=n=5:v=1:a=0[frzout]');
  });

  it('handles freeze at the very start of the video', () => {
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 0, durationMs: 500 },
    ];

    const result = buildFreezeFilter(freezes, 5000, '0:v');
    expect(result).not.toBeNull();
    // No leading segment — just the freeze hold and the rest
    expect(result!.filter).toContain('tpad=stop_mode=clone:stop_duration=0.500');
    expect(result!.filter).toContain('trim=start=0.000:end=5.000');
  });

  it('uses the provided input label', () => {
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 1000, durationMs: 200 },
    ];

    const result = buildFreezeFilter(freezes, 3000, 'outv');
    expect(result!.filter).toContain('[outv]trim=');
  });
});

describe('adjustPlacementsForFreezes', () => {
  it('shifts placements after freeze points', () => {
    const placements = [
      { scene: 'intro', startMs: 0, endMs: 2000 },
      { scene: 'middle', startMs: 3000, endMs: 5000 },
      { scene: 'outro', startMs: 6000, endMs: 8000 },
    ];
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 1000, durationMs: 500 },
    ];

    const adjusted = adjustPlacementsForFreezes(placements, freezes);

    // intro starts at 0 (freeze is at 1000, after start but before end)
    expect(adjusted[0]).toEqual({ scene: 'intro', startMs: 0, endMs: 2500 });
    // middle and outro are fully after the freeze
    expect(adjusted[1]).toEqual({ scene: 'middle', startMs: 3500, endMs: 5500 });
    expect(adjusted[2]).toEqual({ scene: 'outro', startMs: 6500, endMs: 8500 });
  });

  it('handles multiple freezes with cumulative shift', () => {
    const placements = [
      { scene: 'a', startMs: 0, endMs: 2000 },
      { scene: 'b', startMs: 4000, endMs: 6000 },
    ];
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 1000, durationMs: 500 },
      { absoluteMs: 3000, durationMs: 800 },
    ];

    const adjusted = adjustPlacementsForFreezes(placements, freezes);

    // Scene a: start unshifted (freeze at 1000 > start 0), end shifted by 500 (freeze at 1000 <= 2000)
    expect(adjusted[0]).toEqual({ scene: 'a', startMs: 0, endMs: 2500 });
    // Scene b: start shifted by 500+800=1300, end shifted by 1300
    expect(adjusted[1]).toEqual({ scene: 'b', startMs: 5300, endMs: 7300 });
  });

  it('returns original placements when no freezes', () => {
    const placements = [{ scene: 'a', startMs: 0, endMs: 2000 }];
    expect(adjustPlacementsForFreezes(placements, [])).toEqual(placements);
  });
});

describe('totalFreezeDurationMs', () => {
  it('sums all freeze durations', () => {
    const freezes: ResolvedFreeze[] = [
      { absoluteMs: 1000, durationMs: 500 },
      { absoluteMs: 3000, durationMs: 800 },
    ];
    expect(totalFreezeDurationMs(freezes)).toBe(1300);
  });

  it('returns 0 for empty array', () => {
    expect(totalFreezeDurationMs([])).toBe(0);
  });
});
