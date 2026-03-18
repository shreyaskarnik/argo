import { describe, expect, it } from 'vitest';
import { buildTransitionFilters } from '../src/transitions.js';

describe('buildTransitionFilters', () => {
  const placements = [
    { scene: 'intro', startMs: 0, endMs: 1000 },
    { scene: 'feature', startMs: 2000, endMs: 3000 },
  ];

  it('builds fade-through-black with split+trim+fade+concat filter_complex', () => {
    const result = buildTransitionFilters(placements, { type: 'fade-through-black', durationMs: 400 }, true);

    // Should return filter_complex object, not simple string[]
    expect(Array.isArray(result)).toBe(false);
    expect(result).toHaveProperty('filterComplex');
    expect(result).toHaveProperty('videoOutput');

    const fc = (result as any).filterComplex;
    expect(fc).toContain('split=');
    expect(fc).toContain('trim=');
    expect(fc).toContain('fade=t=out');
    expect(fc).toContain('fade=t=in');
    expect(fc).toContain('concat=');
    // Should NOT use alpha fades or drawbox stepping
    expect(fc).not.toContain('alpha=1');
    expect(fc).not.toContain('drawbox=x=0:y=0:w=iw:h=ih:color=black@');
    expect(fc).not.toContain('color=black:s=');
    expect(fc).not.toContain('aevalsrc=');
  });

  it('builds dissolve with split+trim+fade+concat (shorter fade duration)', () => {
    const result = buildTransitionFilters(placements, { type: 'dissolve', durationMs: 400 }, true);

    expect(Array.isArray(result)).toBe(false);
    const fc = (result as any).filterComplex;
    expect(fc).toContain('split=');
    expect(fc).toContain('fade=t=out');
    expect(fc).toContain('concat=');
  });

  it('builds directional wipe filters as simple -vf array', () => {
    const left = buildTransitionFilters(placements, { type: 'wipe-left', durationMs: 400 });
    const right = buildTransitionFilters(placements, { type: 'wipe-right', durationMs: 400 });

    // Wipes return simple string arrays
    expect(Array.isArray(left)).toBe(true);
    expect(Array.isArray(right)).toBe(true);
    expect((left as string[]).some((f) => f.includes('drawbox'))).toBe(true);
    expect((right as string[]).some((f) => f.includes('drawbox'))).toBe(true);
    expect((left as string[]).join('\n')).not.toEqual((right as string[]).join('\n'));
  });

  it('handles no-audio case without asplit', () => {
    const result = buildTransitionFilters(placements, { type: 'fade-through-black', durationMs: 400 }, false);

    expect(Array.isArray(result)).toBe(false);
    const fc = (result as any).filterComplex;
    expect(fc).not.toContain('asplit=');
    expect(fc).not.toContain('atrim=');
    expect(fc).not.toContain('aevalsrc=');
    expect(fc).toContain('concat=n=2:v=1:a=0');
    expect((result as any).audioOutput).toBeNull();
  });

  it('uses the provided fps to make fade-out end one frame before the cut', () => {
    const result = buildTransitionFilters(
      placements,
      { type: 'fade-through-black', durationMs: 400 },
      true,
      60,
    );

    expect(Array.isArray(result)).toBe(false);
    const fc = (result as any).filterComplex;
    expect(fc).toContain('fade=t=out:st=1.7833:d=0.2000');
    expect(fc).not.toContain('0.067');
    expect(fc).not.toContain(':r=30');
  });
});
