import { describe, it, expect } from 'vitest';
import { generateChapterMetadata } from '../src/chapters.js';
import type { Placement } from '../src/tts/align.js';

describe('generateChapterMetadata', () => {
  const placements: Placement[] = [
    { scene: 'intro', startMs: 500, endMs: 3000 },
    { scene: 'feature', startMs: 3500, endMs: 7000 },
    { scene: 'closing', startMs: 8000, endMs: 11000 },
  ];

  it('starts with ;FFMETADATA1 header', () => {
    const meta = generateChapterMetadata(placements, 15000);
    expect(meta).toMatch(/^;FFMETADATA1\n/);
  });

  it('creates a chapter for each placement', () => {
    const meta = generateChapterMetadata(placements, 15000);
    expect(meta).toContain('title=intro');
    expect(meta).toContain('title=feature');
    expect(meta).toContain('title=closing');
  });

  it('sets chapter end to next chapter start', () => {
    const meta = generateChapterMetadata(placements, 15000);
    // intro chapter ends at feature start (3500)
    expect(meta).toContain('START=500');
    expect(meta).toContain('END=3500');
  });

  it('sets last chapter end to totalDurationMs', () => {
    const meta = generateChapterMetadata(placements, 15000);
    expect(meta).toContain('END=15000');
  });

  it('uses TIMEBASE=1/1000', () => {
    const meta = generateChapterMetadata(placements, 15000);
    expect(meta).toContain('TIMEBASE=1/1000');
  });
});
