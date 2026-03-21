import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectVideoTheme } from '../src/media.js';

// These tests mock spawnSync since we can't guarantee ffmpeg is available in CI
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

const { spawnSync } = await import('node:child_process');
const mockedSpawnSync = vi.mocked(spawnSync);

describe('detectVideoTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns "light" overlay theme for dark video (low luminance)', () => {
    // Create a dark frame: 64x36 pixels, all near-black (RGB 10,10,10)
    const pixelCount = 64 * 36;
    const darkFrame = Buffer.alloc(pixelCount * 3, 10);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: darkFrame,
      stderr: Buffer.from(''),
      signal: null,
      pid: 0,
      output: [null, darkFrame, Buffer.from('')],
    } as any);

    const theme = detectVideoTheme('test.mp4', 0, 5000);
    expect(theme).toBe('light'); // dark video → light overlay for contrast
  });

  it('returns "dark" overlay theme for light video (high luminance)', () => {
    const pixelCount = 64 * 36;
    const lightFrame = Buffer.alloc(pixelCount * 3, 220);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: lightFrame,
      stderr: Buffer.from(''),
      signal: null,
      pid: 0,
      output: [null, lightFrame, Buffer.from('')],
    } as any);

    const theme = detectVideoTheme('test.mp4', 0, 5000);
    expect(theme).toBe('dark'); // light video → dark overlay for contrast
  });

  it('handles non-zero exit code with valid stdout (ffmpeg warnings)', () => {
    // ffmpeg sometimes returns non-zero even with valid output
    const pixelCount = 64 * 36;
    const darkFrame = Buffer.alloc(pixelCount * 3, 5);
    mockedSpawnSync.mockReturnValue({
      status: 255, // non-zero but stdout has data
      stdout: darkFrame,
      stderr: Buffer.from('some warning'),
      signal: null,
      pid: 0,
      output: [null, darkFrame, Buffer.from('some warning')],
    } as any);

    const theme = detectVideoTheme('test.mp4', 0, 5000);
    expect(theme).toBe('light'); // should still detect dark video
  });

  it('falls back to "dark" overlay when ffmpeg produces no output', () => {
    mockedSpawnSync.mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('error'),
      signal: null,
      pid: 0,
      output: [null, Buffer.from(''), Buffer.from('error')],
    } as any);

    const theme = detectVideoTheme('test.mp4', 0, 5000);
    expect(theme).toBe('dark'); // fallback
  });

  it('samples multiple frames across the time range', () => {
    const pixelCount = 64 * 36;
    const frame = Buffer.alloc(pixelCount * 3, 50);
    mockedSpawnSync.mockReturnValue({
      status: 0,
      stdout: frame,
      stderr: Buffer.from(''),
      signal: null,
      pid: 0,
      output: [null, frame, Buffer.from('')],
    } as any);

    detectVideoTheme('test.mp4', 0, 10000);
    // Should sample 5 frames across the range
    expect(mockedSpawnSync).toHaveBeenCalledTimes(5);
  });
});
