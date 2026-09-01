import { describe, it, expect } from 'vitest';
import {
  buildCameraMoveFilter,
  detectChainedPairs,
  exportTimelineRemap,
  remapCameraMoves,
  shiftCameraMoves,
  scaleCameraMoves,
  type CameraMove,
} from '../src/camera-move.js';
import { computeSegments, remapTimeMs } from '../src/speed-ramp.js';
import { adjustPlacementsForFreezes } from '../src/freeze.js';

describe('buildCameraMoveFilter', () => {
  const baseMove: CameraMove = {
    startMs: 2000,
    durationMs: 400,
    x: 960,
    y: 540,
    w: 400,
    h: 300,
    scale: 1.5,
    holdMs: 1000,
  };

  it('returns null for empty moves array', () => {
    expect(buildCameraMoveFilter([], 1920, 1080, '[0:v]')).toBeNull();
  });

  it('returns null for invalid dimensions', () => {
    expect(buildCameraMoveFilter([baseMove], 0, 1080, '[0:v]')).toBeNull();
    expect(buildCameraMoveFilter([baseMove], 1920, 0, '[0:v]')).toBeNull();
  });

  it('returns null when scale <= 1.0', () => {
    const noZoom = { ...baseMove, scale: 1.0 };
    expect(buildCameraMoveFilter([noZoom], 1920, 1080, '[0:v]')).toBeNull();
  });

  it('builds a zoompan filter for a single move', () => {
    const result = buildCameraMoveFilter([baseMove], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    expect(result!.filter).toContain('zoompan=');
    expect(result!.filter).toContain('s=1920x1080');
    expect(result!.filter).toContain('fps=30');
    expect(result!.filter).toContain('between(in_time');
    expect(result!.outputLabel).toBe('camfinal');
  });

  /**
   * Read the `z` expression back out of the filter and evaluate it.
   *
   * ffmpeg's `if` and `between` map straight onto JS, and — the property under test
   * here — the two agree on operator precedence for `+ - * /`. Asserting on values
   * rather than on substrings is deliberate: issue #31 was a precedence bug that a
   * substring assertion had locked in place, because the expected text was copied
   * from the output rather than derived from what the curve should do.
   */
  function zoomAt(filter: string, inTime: number): number {
    const match = filter.match(/zoompan=z='([^']+)'/);
    if (match === null) throw new Error('no zoompan z expression in filter');
    const js = match[1].replace(/\\,/g, ',');
    const IF = (cond: boolean, then: number, otherwise: number): number =>
      cond ? then : otherwise;
    const BETWEEN = (x: number, lo: number, hi: number): boolean => x >= lo && x <= hi;
    return new Function(
      'in_time',
      'IF',
      'BETWEEN',
      `return ${js.replace(/\bif\(/g, 'IF(').replace(/\bbetween\(/g, 'BETWEEN(')}`,
    )(inTime, IF, BETWEEN) as number;
  }

  describe('the zoom curve', () => {
    // baseMove: starts at 2.0s, 400ms in, 1000ms hold, 400ms out.
    const zoomInEnd = 2.4;
    const holdEnd = 3.4;
    const zoomOutEnd = 3.8;

    function curve(): (t: number) => number {
      const result = buildCameraMoveFilter([baseMove], 1920, 1080, '[0:v]');
      expect(result).not.toBeNull();
      return (t: number) => zoomAt(result!.filter, t);
    }

    it('zooms in from 1.0 to the requested scale', () => {
      const z = curve();
      expect(z(2.0)).toBeCloseTo(1.0, 4);
      expect(z(2.2)).toBeCloseTo(1.25, 4);
      expect(z(zoomInEnd)).toBeCloseTo(1.5, 4);
    });

    it('holds at the requested scale', () => {
      const z = curve();
      expect(z(2.9)).toBeCloseTo(1.5, 4);
      expect(z(holdEnd)).toBeCloseTo(1.5, 4);
    });

    // The regression. Without the parentheses around `progress` this began at 2.0.
    it('does not jump when the zoom-out begins', () => {
      const z = curve();
      // One millisecond into a 400ms fade the curve may legitimately travel
      // (scale-1)/400 ≈ 0.00125. The bug moved it by 0.5 in that same instant.
      expect(Math.abs(z(holdEnd + 0.001) - z(holdEnd))).toBeLessThan(0.002);
    });

    // And this ended at 2-(scale-1) = 1.65, then snapped to 1.0 as the clause expired.
    it('zooms out all the way back to 1.0', () => {
      const z = curve();
      expect(z(3.6)).toBeCloseTo(1.25, 4);
      expect(z(zoomOutEnd)).toBeCloseTo(1.0, 4);
    });

    it('never exceeds the requested scale, at any point in the move', () => {
      const z = curve();
      for (let t = 1.9; t <= 4.0; t += 1 / 120) {
        expect(z(t)).toBeLessThanOrEqual(1.5 + 1e-6);
      }
    });

    it('leaves no discontinuity at the end of the move', () => {
      const z = curve();
      // The clause expires here and the default (1.0) takes over; the curve has to
      // have arrived there already, or the last frame of the move is a visible snap.
      expect(z(zoomOutEnd + 0.001)).toBeCloseTo(z(zoomOutEnd), 3);
    });
  });

  it('builds unified expression for multiple moves', () => {
    const move2: CameraMove = {
      startMs: 5000,
      durationMs: 300,
      x: 200,
      y: 100,
      w: 600,
      h: 400,
      scale: 1.3,
      holdMs: 500,
    };
    const result = buildCameraMoveFilter([baseMove, move2], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    // Single unified zoompan filter (not chained per-move)
    expect(result!.filter).toContain('[camfinal]');
    // Both moves' focus points appear in the expression
    expect(result!.filter).toContain('960.0000'); // move1 x
    expect(result!.filter).toContain('200.0000'); // move2 x
  });

  it('connects adjacent moves with smooth pan instead of bounce', () => {
    // Two moves close together (gap < 1500ms) → connected handoff
    const move1: CameraMove = {
      startMs: 2000, durationMs: 400,
      x: 960, y: 540, w: 400, h: 300,
      scale: 1.5, holdMs: 500,
    };
    const move2: CameraMove = {
      startMs: 4000, durationMs: 300,
      x: 200, y: 100, w: 600, h: 400,
      scale: 1.3, holdMs: 500,
    };
    // Gap: 4000 - (2000 + 400 + 500 + 400) = 700ms < 1500ms → chained
    const result = buildCameraMoveFilter([move1, move2], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    // Should contain ease-out pan expression (pow for cubic bezier approx)
    expect(result!.filter).toContain('pow(1-');
    // Should contain lerp between scales
    expect(result!.filter).toContain('1.5000+(1.3000-1.5000)');
  });

  it('does not connect moves with large gap', () => {
    const move1: CameraMove = {
      startMs: 1000, durationMs: 300,
      x: 500, y: 300, w: 200, h: 200,
      scale: 1.5, holdMs: 200,
    };
    const move2: CameraMove = {
      startMs: 10000, durationMs: 300,
      x: 800, y: 600, w: 200, h: 200,
      scale: 1.3, holdMs: 200,
    };
    // Gap: 10000 - (1000 + 300 + 200 + 300) = 8200ms >> 1500ms → not chained
    const result = buildCameraMoveFilter([move1, move2], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    // Should NOT contain lerp between scales (no connected pan)
    expect(result!.filter).not.toContain('1.5000+(1.3000-1.5000)');
    // Each move zooms out independently
    expect(result!.filter).toContain('1+(1-(in_time');
  });

  it('does not chain overlapping moves (negative gap)', () => {
    const move1: CameraMove = {
      startMs: 1000, durationMs: 500,
      x: 500, y: 300, w: 200, h: 200,
      scale: 1.5, holdMs: 3000,
    };
    const move2: CameraMove = {
      startMs: 3000, durationMs: 500,
      x: 800, y: 600, w: 200, h: 200,
      scale: 1.3, holdMs: 500,
    };
    // move1 ends at 1000+500+3000+500=5000, move2 starts at 3000 → gap = -2000 (overlapping)
    expect(detectChainedPairs([move1, move2]).size).toBe(0);
    const result = buildCameraMoveFilter([move1, move2], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    // Should NOT chain — each zooms independently
    expect(result!.filter).not.toContain('1.5000+(1.3000-1.5000)');
  });

  it('uses default scale of 1.5 when not specified', () => {
    const noScale = { ...baseMove, scale: undefined };
    const result = buildCameraMoveFilter([noScale], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    expect(result!.filter).toContain("*0.5000");
  });

  it('uses the provided input label', () => {
    const result = buildCameraMoveFilter([baseMove], 1920, 1080, '[outv]');
    expect(result).not.toBeNull();
    expect(result!.filter).toContain('[outv]');
  });

  it('defaults holdMs to 0 when not specified', () => {
    const noHold = { ...baseMove, holdMs: undefined };
    const result = buildCameraMoveFilter([noHold], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    // The filter should still be valid
    expect(result!.filter).toContain('zoompan=');
  });

  it('renames the actual last generated label when trailing moves are skipped', () => {
    const skippedLast = { ...baseMove, startMs: 5000, scale: 1.0 };
    const result = buildCameraMoveFilter([baseMove, skippedLast], 1920, 1080, '[0:v]');
    expect(result).not.toBeNull();
    expect(result!.outputLabel).toBe('camfinal');
    expect(result!.filter).toContain('[camfinal]');
    expect(result!.filter).not.toContain('[cam1]');
  });

  it('uses the provided fps for zoompan output cadence', () => {
    const result = buildCameraMoveFilter([baseMove], 1920, 1080, '[0:v]', 60);
    expect(result).not.toBeNull();
    expect(result!.filter).toContain('fps=60');
  });
});

describe('shiftCameraMoves', () => {
  it('shifts startMs by the offset', () => {
    const moves: CameraMove[] = [
      { startMs: 2000, durationMs: 400, x: 100, y: 100, w: 200, h: 200 },
      { startMs: 5000, durationMs: 300, x: 300, y: 300, w: 100, h: 100 },
    ];
    const shifted = shiftCameraMoves(moves, 1000);
    expect(shifted[0].startMs).toBe(1000);
    expect(shifted[1].startMs).toBe(4000);
  });

  it('clamps to 0 when offset exceeds startMs', () => {
    const moves: CameraMove[] = [
      { startMs: 500, durationMs: 400, x: 100, y: 100, w: 200, h: 200 },
    ];
    const shifted = shiftCameraMoves(moves, 1000);
    expect(shifted[0].startMs).toBe(0);
  });

  it('returns original array when offset is 0', () => {
    const moves: CameraMove[] = [
      { startMs: 2000, durationMs: 400, x: 100, y: 100, w: 200, h: 200 },
    ];
    const result = shiftCameraMoves(moves, 0);
    expect(result).toBe(moves);
  });
});

describe('scaleCameraMoves', () => {
  it('scales coordinates by deviceScaleFactor', () => {
    const moves: CameraMove[] = [
      { startMs: 1000, durationMs: 400, x: 100, y: 200, w: 300, h: 400 },
    ];
    const scaled = scaleCameraMoves(moves, 2);
    expect(scaled[0].x).toBe(200);
    expect(scaled[0].y).toBe(400);
    expect(scaled[0].w).toBe(600);
    expect(scaled[0].h).toBe(800);
    // Timing should not change
    expect(scaled[0].startMs).toBe(1000);
    expect(scaled[0].durationMs).toBe(400);
  });

  it('returns original array when factor is 1', () => {
    const moves: CameraMove[] = [
      { startMs: 1000, durationMs: 400, x: 100, y: 200, w: 300, h: 400 },
    ];
    const result = scaleCameraMoves(moves, 1);
    expect(result).toBe(moves);
  });

  it('supports non-uniform output scaling', () => {
    const moves: CameraMove[] = [
      { startMs: 1000, durationMs: 400, x: 100, y: 200, w: 300, h: 400 },
    ];
    const scaled = scaleCameraMoves(moves, 2, 1.5);
    expect(scaled[0].x).toBe(200);
    expect(scaled[0].y).toBe(300);
    expect(scaled[0].w).toBe(600);
    expect(scaled[0].h).toBe(600);
  });
});

describe('remapCameraMoves', () => {
  // Two one-second scenes in a seven-second timeline, gaps at double speed:
  // [0,1000]@2, [1000,2000]@1, [2000,5000]@2, [5000,6000]@1, [6000,7000]@2.
  const segments = computeSegments(
    [
      { scene: 'intro', startMs: 1000, endMs: 2000 },
      { scene: 'outro', startMs: 5000, endMs: 6000 },
    ],
    7000,
    { gapSpeed: 2.0, minGapMs: 500 },
  );
  const remap = (timeMs: number) => remapTimeMs(timeMs, segments);

  it('shifts a move by the gap time removed ahead of it, keeping its duration', () => {
    const moves: CameraMove[] = [
      { startMs: 1100, durationMs: 300, holdMs: 100, x: 10, y: 20, w: 30, h: 40 },
    ];

    const [move] = remapCameraMoves(moves, remap);

    // 500ms of the leading gap is removed, and the move itself sits inside a
    // scene the ramp does not touch, so it keeps its shape exactly.
    expect(move.startMs).toBe(600);
    expect(move.durationMs).toBe(300);
    expect(move.holdMs).toBe(100);
  });

  it('shrinks a move that spans a compressed gap instead of only shifting it', () => {
    const moves: CameraMove[] = [
      { startMs: 1800, durationMs: 200, holdMs: 800, x: 10, y: 20, w: 30, h: 40 },
    ];

    const [move] = remapCameraMoves(moves, remap);

    // Recorded span is 200 + 800 + 200 = 1200ms running from 1800 to 3000.
    // On the ramped timeline that is 1300 to 2000, so the move has to occupy
    // 700ms. Shifting alone would leave it running 500ms past its content.
    expect(move.startMs).toBe(1300);
    const spanMs = move.durationMs * 2 + (move.holdMs ?? 0);
    // Within a millisecond of the ramped span: duration and hold are rounded to
    // whole milliseconds independently, so they can disagree with the exact
    // span by 1ms. At 30fps that is a thirtieth of a frame.
    expect(Math.abs(spanMs - (remap(3000) - remap(1800)))).toBeLessThanOrEqual(1);
  });

  it('leaves moves untouched when the timeline is not remapped', () => {
    const moves: CameraMove[] = [
      { startMs: 1800, durationMs: 200, holdMs: 800, x: 10, y: 20, w: 30, h: 40 },
    ];

    expect(remapCameraMoves(moves, (timeMs) => timeMs)).toEqual(moves);
  });

  it('keeps a closing move at its authored speed when its tail overhangs the end', () => {
    // Second scene runs to the very end, so there is no trailing segment for
    // the zoom-out to land in and the move's span runs past 7000.
    const closing = computeSegments(
      [{ scene: 'intro', startMs: 1000, endMs: 2000 }, { scene: 'outro', startMs: 4000, endMs: 7000 }],
      7000,
      { gapSpeed: 2.0, minGapMs: 500 },
    );
    const moves: CameraMove[] = [
      { startMs: 6500, durationMs: 400, holdMs: 2200, x: 10, y: 20, w: 30, h: 40 },
    ];

    const [move] = remapCameraMoves(moves, (timeMs) => remapTimeMs(timeMs, closing));

    // The ramp leaves this scene alone, so only the start shifts. Measuring the
    // span against a saturated endpoint charges the overhang against the 500ms
    // of timeline left, rendering the 400ms ease in two frames.
    expect(move.durationMs).toBe(400);
    expect(move.holdMs).toBe(2200);
  });

  it('never rounds a fade down to zero', () => {
    const moves: CameraMove[] = [
      { startMs: 0, durationMs: 10, holdMs: 0, x: 10, y: 20, w: 30, h: 40 },
    ];

    // A 25x scene compresses a 10ms fade to 0.4ms. Rounding that to 0 would
    // make buildCameraMoveFilter divide by zero, which ffmpeg accepts and
    // renders as a move that does nothing at all.
    const [move] = remapCameraMoves(moves, (timeMs) => timeMs / 25);
    expect(move.durationMs).toBeGreaterThanOrEqual(1);
  });
});

describe('exportTimelineRemap', () => {
  it('measures freezes against the ramped clock, not the recorded one', () => {
    // Halve everything, then hold 1000ms at ramped t=1000.
    const remap = exportTimelineRemap(
      (timeMs) => timeMs / 2,
      [{ absoluteMs: 1000, durationMs: 1000 }],
    );

    // Recorded 1000 lands at ramped 500, which is before the freeze, so it is
    // untouched. Comparing the freeze against the recorded 1000 instead would
    // wrongly push it to 1500.
    expect(remap(1000)).toBe(500);

    // Recorded 4000 lands at ramped 2000, past the freeze, so it takes the
    // full inserted hold.
    expect(remap(4000)).toBe(3000);
  });

  it('pushes a time landing exactly on a freeze, as adjustPlacementsForFreezes does', () => {
    const freezes = [{ absoluteMs: 1000, durationMs: 500 }];
    const remap = exportTimelineRemap((timeMs) => timeMs, freezes);

    // `<=`, matching adjustPlacementsForFreezes. The two have to agree or a
    // move and the scene it belongs to drift apart by the whole hold.
    expect(remap(1000)).toBe(1500);
    expect(remap(999)).toBe(999);
    expect(adjustPlacementsForFreezes([{ scene: 'a', startMs: 1000, endMs: 2000 }], freezes)[0].startMs)
      .toBe(1500);
  });

  it('is an identity when there is neither a ramp nor a freeze', () => {
    const remap = exportTimelineRemap((timeMs) => timeMs, []);
    expect(remap(0)).toBe(0);
    expect(remap(12_345)).toBe(12_345);
  });
});
