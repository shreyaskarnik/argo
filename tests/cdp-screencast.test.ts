import { describe, it, expect } from 'vitest';
import { buildConcatLines } from '../src/cdp-screencast.js';

describe('buildConcatLines', () => {
  it('returns empty for empty input', () => {
    expect(buildConcatLines([], 30)).toEqual([]);
  });

  it('emits file + duration pairs derived from timestamp deltas', () => {
    const lines = buildConcatLines(
      [
        { filename: 'frame-0000000.jpg', paintTimestampSec: 100.000 },
        { filename: 'frame-0000001.jpg', paintTimestampSec: 100.033 },
        { filename: 'frame-0000002.jpg', paintTimestampSec: 100.075 },
      ],
      30,
    );
    // 3 frames → 3 file lines + 3 duration lines + 1 trailing file line repeat
    expect(lines).toEqual([
      "file 'frame-0000000.jpg'",
      'duration 0.033000',
      "file 'frame-0000001.jpg'",
      'duration 0.042000',
      "file 'frame-0000002.jpg'",
      // last frame: avg of (33ms, 42ms) = 37.5ms — falls back to overall avg
      'duration 0.037500',
      // concat demuxer requires the last file line repeated for its duration
      // to actually apply (otherwise ffmpeg uses the JPEG's intrinsic duration).
      "file 'frame-0000002.jpg'",
    ]);
  });

  it('falls back to 1/fps for the single-frame case', () => {
    const lines = buildConcatLines(
      [{ filename: 'frame-0000000.jpg', paintTimestampSec: 100.0 }],
      30,
    );
    expect(lines).toEqual([
      "file 'frame-0000000.jpg'",
      `duration ${(1 / 30).toFixed(6)}`,
      "file 'frame-0000000.jpg'",
    ]);
  });

  it('falls back to 1/fps when a delta is non-positive (clock weirdness)', () => {
    const lines = buildConcatLines(
      [
        { filename: 'a.jpg', paintTimestampSec: 100.0 },
        { filename: 'b.jpg', paintTimestampSec: 100.0 }, // identical timestamps
      ],
      30,
    );
    // First duration is 0 → clamped to 1/30; last duration is the avg → also 0 → clamped.
    expect(lines).toContain(`duration ${(1 / 30).toFixed(6)}`);
    expect(lines.some((l) => l === 'duration 0.000000')).toBe(false);
  });

  it('clamps absurdly long deltas (clock jump) to 60s', () => {
    const lines = buildConcatLines(
      [
        { filename: 'a.jpg', paintTimestampSec: 100.0 },
        { filename: 'b.jpg', paintTimestampSec: 1_000_000.0 },
      ],
      30,
    );
    // First delta is enormous; should clamp to 60.
    expect(lines).toContain('duration 60.000000');
  });
});
