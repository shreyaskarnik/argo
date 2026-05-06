import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCompositionDuration } from '../src/composition.js';

describe('readCompositionDuration', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'argo-comp-'));

  it('reads data-duration in seconds and returns ms', () => {
    const path = join(tmp, 'a.html');
    writeFileSync(path, '<div data-composition-id="x" data-duration="3.5"></div>');
    expect(readCompositionDuration(path)).toBe(3500);
  });

  it('handles integer durations', () => {
    const path = join(tmp, 'b.html');
    writeFileSync(path, '<div data-composition-id="x" data-duration="10"></div>');
    expect(readCompositionDuration(path)).toBe(10000);
  });

  it('returns null for files without a duration attribute', () => {
    const path = join(tmp, 'c.html');
    writeFileSync(path, '<div data-composition-id="x"></div>');
    expect(readCompositionDuration(path)).toBeNull();
  });

  it('returns null for nonexistent files', () => {
    expect(readCompositionDuration(join(tmp, 'missing.html'))).toBeNull();
  });
});
