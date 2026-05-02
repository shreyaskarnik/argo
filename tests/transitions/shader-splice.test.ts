import { describe, it, expect, vi } from 'vitest';
import { buildShaderSpliceFilter } from '../../src/transitions/shader-splice.js';

describe('buildShaderSpliceFilter', () => {
  it('produces a three-segment concat per boundary for single-boundary case', () => {
    const result = buildShaderSpliceFilter({
      totalDurationSec: 6.0,
      boundaries: [
        { boundarySec: 3.0, durationMs: 800, extraInputIndex: 2 },
      ],
      videoInputLabel: '[0:v]',
      audioInputLabel: '[1:a]',
      fps: 30,
    });

    expect(result.filterComplex).toContain('trim=0.000:2.600');
    expect(result.filterComplex).toContain('trim=3.400:6.000');
    expect(result.filterComplex).toContain('[2:v]');
    expect(result.filterComplex).toMatch(/concat=n=3:v=1:a=1/);
    expect(result.videoOutput).toBe('[svout]');
    expect(result.audioOutput).toBe('[saout]');
  });

  it('handles two boundaries (five-segment concat)', () => {
    const result = buildShaderSpliceFilter({
      totalDurationSec: 9.0,
      boundaries: [
        { boundarySec: 3.0, durationMs: 600, extraInputIndex: 2 },
        { boundarySec: 6.0, durationMs: 600, extraInputIndex: 3 },
      ],
      videoInputLabel: '[0:v]',
      audioInputLabel: '[1:a]',
      fps: 30,
    });

    expect(result.filterComplex).toMatch(/concat=n=5:v=1:a=1/);
    expect(result.filterComplex).toContain('[2:v]');
    expect(result.filterComplex).toContain('[3:v]');
  });

  it('works without audio', () => {
    const result = buildShaderSpliceFilter({
      totalDurationSec: 4.0,
      boundaries: [{ boundarySec: 2.0, durationMs: 500, extraInputIndex: 1 }],
      videoInputLabel: '[0:v]',
      audioInputLabel: null,
      fps: 30,
    });
    expect(result.filterComplex).toMatch(/concat=n=3:v=1:a=0/);
    expect(result.audioOutput).toBeNull();
  });

  it('clamps sceneEnd when a boundary is near the video start', () => {
    // boundarySec=0.15, rawDHalf=0.2. maxDHalfFromCursor=0.15, so dHalf clamps to 0.15.
    // sceneEnd = 0.15 - 0.15 = 0.000 (zero-length, ffmpeg accepts)
    // transitionEnd = 0.15 + 0.15 = 0.300
    const result = buildShaderSpliceFilter({
      totalDurationSec: 4.0,
      boundaries: [{ boundarySec: 0.15, durationMs: 400, extraInputIndex: 2 }],
      videoInputLabel: '[0:v]',
      audioInputLabel: '[1:a]',
      fps: 30,
    });
    // Scene A trim clamps to trim=0:0 (zero-length, ffmpeg accepts)
    expect(result.filterComplex).toContain('trim=0.000:0.000');
    // After transition window, cursor is 0.300 — rest of video is [0.300, 4.0]
    expect(result.filterComplex).toContain('trim=0.300:4.000');
  });

  it('clamps transitionEnd when a boundary is near the video end', () => {
    // boundarySec=2.85, rawDHalf=0.2. maxDHalfFromTotal=0.15, so dHalf clamps to 0.15.
    // sceneEnd = 2.85 - 0.15 = 2.700, transitionEnd = 2.85 + 0.15 = 3.000
    const result = buildShaderSpliceFilter({
      totalDurationSec: 3.0,
      boundaries: [{ boundarySec: 2.85, durationMs: 400, extraInputIndex: 2 }],
      videoInputLabel: '[0:v]',
      audioInputLabel: null,
      fps: 30,
    });
    // Scene A runs to 2.700, transition ends at 3.0, last segment is [3.0, 3.0]
    expect(result.filterComplex).toContain('trim=0.000:2.700');
    expect(result.filterComplex).toMatch(/concat=n=3/);
  });

  it('skips a boundary when two are closer than the transition duration', () => {
    // Two boundaries at 0.4s and 0.6s with 800ms transitions = 400ms halves.
    // The first transition runs [0, 0.8], pushing cursor to 0.8. The second's
    // sceneEnd would be 0.6 - 0.4 = 0.2 — before cursor. Skip the second.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = buildShaderSpliceFilter({
      totalDurationSec: 3.0,
      boundaries: [
        { boundarySec: 0.4, durationMs: 800, extraInputIndex: 2 },
        { boundarySec: 0.6, durationMs: 800, extraInputIndex: 3 },
      ],
      videoInputLabel: '[0:v]',
      audioInputLabel: '[1:a]',
      fps: 30,
    });
    // First boundary consumes half its requested 800ms (only 400ms before
    // video start, so dHalf clamps to 0.4 → transition runs [0, 0.8]).
    // Second boundary is skipped: its sceneEnd would be before cursor.
    expect(warnSpy).toHaveBeenCalled();
    expect(result.filterComplex).toMatch(/concat=n=3/);
    // Only the first boundary's PNG sequence should appear in the filter
    expect(result.filterComplex).toContain('[2:v]');
    expect(result.filterComplex).not.toContain('[3:v]');
    warnSpy.mockRestore();
  });

  it('clamps dHalf proportionally when boundary is near video start', () => {
    // boundarySec=0.3, requested halfDur=0.4 — only 0.3 available before start
    const result = buildShaderSpliceFilter({
      totalDurationSec: 4.0,
      boundaries: [{ boundarySec: 0.3, durationMs: 800, extraInputIndex: 2 }],
      videoInputLabel: '[0:v]',
      audioInputLabel: '[1:a]',
      fps: 30,
    });
    // Scene A is trim=0:0.000 (zero-length)
    expect(result.filterComplex).toContain('trim=0.000:0.000');
    // Transition ends at 0.3 + 0.3 = 0.6
    expect(result.filterComplex).toContain('trim=0.600:4.000');
    expect(result.filterComplex).toMatch(/concat=n=3/);
  });

  it('normalizes SAR=1 on every concat input to avoid mismatch', () => {
    // webkit screencast emits SAR 108:109; PNG sequence is 0:1. Without
    // setsar=1 on each input, ffmpeg concat fails with "parameters do not
    // match". Every video segment (scene + transition) must include setsar=1.
    const result = buildShaderSpliceFilter({
      totalDurationSec: 6.0,
      boundaries: [{ boundarySec: 3.0, durationMs: 800, extraInputIndex: 2 }],
      videoInputLabel: '[0:v]',
      audioInputLabel: '[1:a]',
      fps: 30,
    });
    // Scene segments (trim+setpts+setsar)
    expect(result.filterComplex).toMatch(/trim=0\.000:2\.600,setpts=PTS-STARTPTS,setsar=1/);
    expect(result.filterComplex).toMatch(/trim=3\.400:6\.000,setpts=PTS-STARTPTS,setsar=1/);
    // PNG transition segment also normalized
    expect(result.filterComplex).toMatch(/\[2:v\]setpts=PTS-STARTPTS,setsar=1/);
  });

  it('clamps dHalf when boundary is near video end', () => {
    // boundarySec=2.85, requested halfDur=0.4 — only 0.15 available after
    const result = buildShaderSpliceFilter({
      totalDurationSec: 3.0,
      boundaries: [{ boundarySec: 2.85, durationMs: 800, extraInputIndex: 2 }],
      videoInputLabel: '[0:v]',
      audioInputLabel: null,
      fps: 30,
    });
    // Scene A runs until 2.85 - 0.15 = 2.70
    expect(result.filterComplex).toContain('trim=0.000:2.700');
    // Final segment is [3.0, 3.0] zero-length — ffmpeg tolerates
    expect(result.filterComplex).toMatch(/concat=n=3/);
  });
});
