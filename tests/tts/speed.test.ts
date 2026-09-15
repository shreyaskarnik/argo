import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAtempoChain, convertToWav } from '../../src/tts/engine.js';
import { execFileSync } from 'node:child_process';

// `engine.ts` reads `execFileSync` off the namespace at call time, so the whole
// module has to be replaced — an ESM namespace object cannot be spied on.
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => Buffer.from('fake-wav')),
}));

/**
 * Regression coverage for #38: `TTSEngineOptions.speed` was silently dropped by
 * every engine that renders audio server-side and post-converts with ffmpeg
 * (ElevenLabs, Gemini). Those engines have no native speed control, so the rate
 * change has to happen during the WAV conversion.
 *
 * `atempo` is the right filter rather than `asetrate`: it resamples in the time
 * domain, so speeding up does not raise the pitch. Its cost is a hard 0.5–2.0
 * clamp per instance, which is why anything outside that range must be split
 * across several chained instances whose product is the requested speed.
 */
describe('buildAtempoChain', () => {
  /** Multiply the `atempo=N` values out of a chain back into one speed. */
  function effectiveSpeed(args: string[]): number {
    const filter = args[args.indexOf('-filter:a') + 1];
    return filter
      .split(',')
      .map(stage => Number(stage.replace('atempo=', '')))
      .reduce((a, b) => a * b, 1);
  }

  it('emits no filter at all for unchanged speed', () => {
    expect(buildAtempoChain(1)).toEqual([]);
  });

  it('emits a single stage for a speed-up inside atempo range', () => {
    expect(buildAtempoChain(1.5)).toEqual(['-filter:a', 'atempo=1.5']);
  });

  it('emits a single stage for a slow-down inside atempo range', () => {
    expect(buildAtempoChain(0.75)).toEqual(['-filter:a', 'atempo=0.75']);
  });

  it('chains stages for a speed-up above the 2.0 per-instance ceiling', () => {
    const args = buildAtempoChain(3);
    expect(effectiveSpeed(args)).toBeCloseTo(3, 5);
  });

  it('chains stages for a slow-down below the 0.5 per-instance floor', () => {
    const args = buildAtempoChain(0.25);
    expect(effectiveSpeed(args)).toBeCloseTo(0.25, 5);
  });

  it('keeps every individual stage within ffmpeg\'s 0.5-2.0 limit', () => {
    for (const speed of [0.25, 0.3, 0.5, 0.9, 1.1, 2, 3, 4]) {
      const args = buildAtempoChain(speed);
      const stages = args[1].split(',').map(s => Number(s.replace('atempo=', '')));
      for (const stage of stages) {
        expect(stage).toBeGreaterThanOrEqual(0.5);
        expect(stage).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('buildAtempoChain input guard', () => {
  // The chain divides by each stage factor until the remainder lands in range,
  // so these values never converge and would hang TTS rather than fail it.
  it.each([0, -1, NaN, Infinity])('rejects %p instead of looping forever', speed => {
    expect(() => buildAtempoChain(speed)).toThrow(/positive finite number/);
  });

  it('names the offending value in the error', () => {
    expect(() => buildAtempoChain(0)).toThrow('TTS speed must be a positive finite number, got 0');
  });

  it('caps an absurd speed-up at 4x and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const args = buildAtempoChain(100);
    expect(args).toEqual(['-filter:a', 'atempo=2,atempo=2']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamped to 4'));
    warn.mockRestore();
  });

  it('caps an absurd slow-down at 0.25x and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const args = buildAtempoChain(0.01);
    expect(args).toEqual(['-filter:a', 'atempo=0.5,atempo=0.5']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clamped to 0.25'));
    warn.mockRestore();
  });

  it('leaves an in-range speed untouched and stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(buildAtempoChain(1.5)).toEqual(['-filter:a', 'atempo=1.5']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('convertToWav speed', () => {
  const execSpy = vi.mocked(execFileSync);

  beforeEach(() => {
    execSpy.mockClear();
  });

  it('passes no audio filter when speed is left at the default', () => {
    convertToWav(Buffer.from('audio'));
    const args = execSpy.mock.calls[0][1] as string[];
    expect(args).not.toContain('-filter:a');
  });

  it('passes the atempo chain to ffmpeg when a speed is requested', () => {
    convertToWav(Buffer.from('audio'), 1.25);
    const args = execSpy.mock.calls[0][1] as string[];
    expect(args).toContain('-filter:a');
    expect(args[args.indexOf('-filter:a') + 1]).toBe('atempo=1.25');
  });
});
