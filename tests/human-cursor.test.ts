import { describe, it, expect } from 'vitest';
import { buildHumanCursorPath } from '../src/human-cursor.js';

describe('human cursor paths', () => {
  const from = { x: 100, y: 80 };
  const to = { x: 800, y: 400 };

  it('reproduces the curve for the same seed, with exact endpoints', () => {
    const path = buildHumanCursorPath(from, to, 'demo:1', 40);
    expect(path).toEqual(buildHumanCursorPath(from, to, 'demo:1', 40));
    expect(path).not.toEqual(buildHumanCursorPath(from, to, 'demo:2', 40));
    expect(path[0]).toEqual(from);
    expect(path.at(-1)).toEqual(to);
    expect(path).toHaveLength(40);
    // At least one intermediate point must be off the straight-line path.
    expect(path.some(p => Math.abs((p.x - from.x) * (to.y - from.y) - (p.y - from.y) * (to.x - from.x)) > 100)).toBe(true);
  });

  it('does not wander when clicking the same point twice', () => {
    expect(buildHumanCursorPath(from, from, 'stationary', 18)).toEqual(Array(18).fill(from));
  });
});
