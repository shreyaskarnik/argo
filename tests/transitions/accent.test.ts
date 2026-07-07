import { describe, it, expect } from 'vitest';
import { deriveAccentColors, DEFAULT_ACCENT } from '../../src/transitions/accent.js';

describe('deriveAccentColors', () => {
  it('parses 6-digit hex into normalized rgb', () => {
    const { accent } = deriveAccentColors('#ff8000');
    expect(accent[0]).toBeCloseTo(1.0, 5);
    expect(accent[1]).toBeCloseTo(128 / 255, 5);
    expect(accent[2]).toBeCloseTo(0.0, 5);
  });

  it('accepts hex without leading #', () => {
    expect(deriveAccentColors('0ea5e9').accent).toEqual(deriveAccentColors('#0ea5e9').accent);
  });

  it('defaults to DEFAULT_ACCENT when called without args', () => {
    expect(DEFAULT_ACCENT).toBe('#0ea5e9');
    expect(deriveAccentColors().accent).toEqual(deriveAccentColors(DEFAULT_ACCENT).accent);
  });

  it('derives dark as 0.35x and bright as mix-toward-white 0.65', () => {
    const { accent, accentDark, accentBright } = deriveAccentColors('#0ea5e9');
    for (let i = 0; i < 3; i++) {
      expect(accentDark[i]).toBeCloseTo(accent[i] * 0.35, 5);
      expect(accentBright[i]).toBeCloseTo(accent[i] + (1 - accent[i]) * 0.65, 5);
    }
  });

  it('throws a clear error on malformed input', () => {
    expect(() => deriveAccentColors('#12')).toThrow(/Invalid accent color/);
    expect(() => deriveAccentColors('red')).toThrow(/Invalid accent color/);
  });
});
