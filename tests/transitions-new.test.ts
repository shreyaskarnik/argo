import { describe, expect, it } from 'vitest';
import { buildTransitionFilters } from '../src/transitions.js';

describe('buildTransitionFilters', () => {
  const placements = [
    { scene: 'intro', startMs: 0, endMs: 1000 },
    { scene: 'feature', startMs: 2000, endMs: 3000 },
  ];

  it('builds directional wipe filters instead of fade fallbacks', () => {
    const left = buildTransitionFilters(placements, { type: 'wipe-left', durationMs: 400 });
    const right = buildTransitionFilters(placements, { type: 'wipe-right', durationMs: 400 });

    expect(left.some((filter) => filter.includes('drawbox'))).toBe(true);
    expect(right.some((filter) => filter.includes('drawbox'))).toBe(true);
    expect(left.join('\n')).not.toContain('fade=t=out');
    expect(right.join('\n')).not.toContain('fade=t=out');
    expect(left.join('\n')).not.toEqual(right.join('\n'));
  });
});
