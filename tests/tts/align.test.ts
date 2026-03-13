import { describe, it, expect } from 'vitest';
import {
  alignClips,
  type SceneTiming,
  type ClipInfo,
  type Placement,
  type AlignResult,
} from '../../src/tts/align.js';

function makeClip(scene: string, durationMs: number, fillValue = 0): ClipInfo {
  const sampleRate = 24_000;
  const numSamples = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(numSamples);
  if (fillValue !== 0) samples.fill(fillValue);
  return { scene, durationMs, samples };
}

describe('alignClips', () => {
  it('places clips at their scene timestamps (no overlap)', () => {
    const timing: SceneTiming = { intro: 0, middle: 5000, end: 10000 };
    const clips: ClipInfo[] = [
      makeClip('intro', 2000),
      makeClip('middle', 2000),
      makeClip('end', 2000),
    ];
    const result = alignClips(timing, clips, 15000);
    expect(result.placements).toEqual([
      { scene: 'intro', startMs: 0, endMs: 2000 },
      { scene: 'middle', startMs: 5000, endMs: 7000 },
      { scene: 'end', startMs: 10000, endMs: 12000 },
    ]);
  });

  it('prevents overlap with 100ms gap', () => {
    const timing: SceneTiming = { a: 0, b: 1000 };
    // Clip 'a' is 2000ms, so it extends past b's timestamp of 1000ms
    const clips: ClipInfo[] = [
      makeClip('a', 2000),
      makeClip('b', 500),
    ];
    const result = alignClips(timing, clips, 5000);
    // 'b' should be pushed to 2000 + 100 = 2100
    expect(result.placements).toEqual([
      { scene: 'a', startMs: 0, endMs: 2000 },
      { scene: 'b', startMs: 2100, endMs: 2600 },
    ]);
  });

  it('output buffer has correct total duration', () => {
    const timing: SceneTiming = { x: 0 };
    const clips: ClipInfo[] = [makeClip('x', 500)];
    const sampleRate = 24_000;
    const totalDurationMs = 10000;
    const result = alignClips(timing, clips, totalDurationMs, sampleRate);
    const expectedSamples = Math.round((totalDurationMs / 1000) * sampleRate);
    expect(result.samples.length).toBe(expectedSamples);
  });

  it('mixes samples at correct positions', () => {
    const timing: SceneTiming = { a: 1000 };
    const fillValue = 0.5;
    const clips: ClipInfo[] = [makeClip('a', 100, fillValue)];
    const sampleRate = 24_000;
    const result = alignClips(timing, clips, 3000, sampleRate);

    const startSample = Math.round((1000 / 1000) * sampleRate);
    const clipSamples = Math.round((100 / 1000) * sampleRate);

    // Before clip: silence
    expect(result.samples[0]).toBe(0);
    // At clip start
    expect(result.samples[startSample]).toBe(fillValue);
    // At clip end - 1
    expect(result.samples[startSample + clipSamples - 1]).toBe(fillValue);
    // After clip: silence
    expect(result.samples[startSample + clipSamples]).toBe(0);
  });

  it('handles empty clips array', () => {
    const timing: SceneTiming = { a: 0 };
    const result = alignClips(timing, [], 5000);
    expect(result.placements).toEqual([]);
    expect(result.samples.length).toBe(Math.round((5000 / 1000) * 24_000));
    expect(result.requiredDurationMs).toBe(0);
    expect(result.overflowMs).toBe(0);
    // All silence
    expect(result.samples.every((s) => s === 0)).toBe(true);
  });

  it('orders by timestamp, not input order', () => {
    const timing: SceneTiming = { first: 0, second: 3000, third: 6000 };
    // Provide clips in reverse order
    const clips: ClipInfo[] = [
      makeClip('third', 1000),
      makeClip('first', 1000),
      makeClip('second', 1000),
    ];
    const result = alignClips(timing, clips, 10000);
    expect(result.placements.map((p) => p.scene)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('skips clips whose scene is not in timing data', () => {
    const timing: SceneTiming = { a: 0, b: 3000 };
    const clips: ClipInfo[] = [
      makeClip('a', 1000),
      makeClip('unknown', 1000),
      makeClip('b', 1000),
    ];
    const result = alignClips(timing, clips, 6000);
    expect(result.placements).toEqual([
      { scene: 'a', startMs: 0, endMs: 1000 },
      { scene: 'b', startMs: 3000, endMs: 4000 },
    ]);
    expect(result.placements.some((p) => p.scene === 'unknown')).toBe(false);
  });

  it('extends the output buffer when aligned audio runs past the video length', () => {
    const timing: SceneTiming = { ending: 4500 };
    const clips: ClipInfo[] = [makeClip('ending', 1000)];
    const sampleRate = 24_000;

    const result = alignClips(timing, clips, 5000, sampleRate);

    expect(result.requiredDurationMs).toBe(5500);
    expect(result.overflowMs).toBe(500);
    expect(result.samples.length).toBe(Math.round((5500 / 1000) * sampleRate));
  });
});
