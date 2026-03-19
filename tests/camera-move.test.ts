import { describe, it, expect } from 'vitest';
import {
  buildCameraMoveFilter,
  shiftCameraMoves,
  scaleCameraMoves,
  type CameraMove,
} from '../src/camera-move.js';

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

  it('chains multiple moves with sequential labels', () => {
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
    // First move feeds into second
    expect(result!.filter).toContain('[cam0]');
    expect(result!.filter).toContain('[camfinal]');
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
});
