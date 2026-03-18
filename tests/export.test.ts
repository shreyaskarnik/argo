import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { checkFfmpeg, exportVideo } from '../src/export.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------- checkFfmpeg ----------
describe('checkFfmpeg', () => {
  it('returns true when ffmpeg is available', () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ffmpeg version 6.0'));
    expect(checkFfmpeg()).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith('ffmpeg', ['-version'], { stdio: 'pipe' });
  });

  it('throws with install instructions when ffmpeg is missing', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    expect(() => checkFfmpeg()).toThrow(/ffmpeg is not installed/i);
    expect(() => checkFfmpeg()).toThrow(/brew install ffmpeg/);
    expect(() => checkFfmpeg()).toThrow(/apt install ffmpeg/);
    expect(() => checkFfmpeg()).toThrow(/choco install ffmpeg/);
  });
});

// ---------- exportVideo ----------
describe('exportVideo', () => {
  function setupHappy() {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);
  }

  it('builds correct default ffmpeg args', async () => {
    setupHappy();
    const result = await exportVideo({ demoName: 'my-demo', argoDir: '.argo', outputDir: 'videos' });

    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedSpawnSync.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args).toEqual([
      '-i', '.argo/my-demo/video.webm',
      '-i', '.argo/my-demo/narration-aligned.wav',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '16',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-y',
      'videos/my-demo.mp4',
    ]);
    expect(result).toBe('videos/my-demo.mp4');
  });

  it('applies custom preset and crf', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', preset: 'fast', crf: 23 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    expect(args).toContain('fast');
    expect(args).toContain('23');
  });

  it('adds -r flag when fps is specified', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', fps: 30 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const rIdx = (args as string[]).indexOf('-r');
    expect(rIdx).toBeGreaterThan(-1);
    expect((args as string[])[rIdx + 1]).toBe('30');
  });

  it('pads the final video frame when tailPadMs is specified', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', tailPadMs: 1250 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    expect(args).toContain('-vf');
    expect(args).toContain('tpad=stop_mode=clone:stop_duration=1.25');
  });

  it('adds lanczos downscale filter when deviceScaleFactor > 1', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      outputWidth: 1920, outputHeight: 1080, deviceScaleFactor: 2,
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    expect(args).toContain('-vf');
    expect(args).toContain('scale=1920:1080:flags=lanczos');
  });

  it('combines tpad and downscale filters in one -vf chain', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      tailPadMs: 500, outputWidth: 1920, outputHeight: 1080, deviceScaleFactor: 2,
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const vfIdx = (args as string[]).indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    expect((args as string[])[vfIdx + 1]).toBe(
      'tpad=stop_mode=clone:stop_duration=0.5,scale=1920:1080:flags=lanczos'
    );
  });

  it('throws on missing video.webm', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('video.webm')) return false;
      return true;
    });

    await expect(exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' }))
      .rejects.toThrow(/video\.webm/);
  });

  it('exports without audio when narration-aligned.wav is missing (silent mode)', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('narration-aligned.wav')) return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', output: [], pid: 0, signal: null });

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' });
    // Should not include audio input or -c:a args
    const args = mockedSpawnSync.mock.calls[0][1] as string[];
    expect(args).not.toContain('narration-aligned.wav');
    expect(args).not.toContain('-c:a');
  });

  it('creates output directory if it does not exist', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p) === 'out') return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' });

    expect(mockedMkdirSync).toHaveBeenCalledWith('out', { recursive: true });
  });

  it('throws on non-zero exit code', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({ status: 1 } as any);

    await expect(exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' }))
      .rejects.toThrow(/ffmpeg.*failed|exit code/i);
  });

  it('throws with signal info when ffmpeg is killed', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({ status: null, signal: 'SIGKILL' } as any);

    await expect(exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' }))
      .rejects.toThrow(/killed by signal SIGKILL/);
  });

  it('throws with spawn error when ffmpeg cannot be launched', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockReturnValue(true);
    mockedSpawnSync.mockReturnValue({ status: null, error: new Error('ENOENT') } as any);

    await expect(exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' }))
      .rejects.toThrow(/Failed to launch ffmpeg/);
  });

  it('embeds thumbnail as attached picture when thumbnailPath exists', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      thumbnailPath: 'assets/logo-thumb.png',
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // Should have 3 inputs
    expect(a.filter(x => x === '-i').length).toBe(3);
    expect(a).toContain('assets/logo-thumb.png');
    // Should map explicit streams: 0:v, 1:a, 2:v
    const mapIndices = a.reduce<number[]>((acc, x, i) => x === '-map' ? [...acc, i] : acc, []);
    expect(mapIndices.length).toBe(3);
    expect(a[mapIndices[0] + 1]).toBe('0:v');
    expect(a[mapIndices[1] + 1]).toBe('1:a');
    expect(a[mapIndices[2] + 1]).toBe('2:v');
    // Encode thumbnail stream as PNG attached picture
    expect(a).toContain('-c:v:1');
    expect(a).toContain('png');
    expect(a).toContain('-disposition:v:1');
    expect(a).toContain('attached_pic');
    // -shortest must NOT be present (PNG has 0 duration, would truncate output)
    expect(a).not.toContain('-shortest');
  });

  it('skips thumbnail when thumbnailPath does not exist on disk', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p) === 'assets/missing.png') return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      thumbnailPath: 'assets/missing.png',
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a.filter(x => x === '-i').length).toBe(2);
    expect(a).not.toContain('-disposition:v:1');
  });

  it('uses filter_complex speed ramp while preserving chapter and thumbnail inputs', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo',
      argoDir: '.argo',
      outputDir: 'out',
      chapterMetadataPath: '.argo/demo/chapters.txt',
      thumbnailPath: 'assets/logo-thumb.png',
      speedRampSegments: [
        { startMs: 0, endMs: 1000, speed: 2.0 },
        { startMs: 1000, endMs: 2000, speed: 1.0 },
      ],
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('-filter_complex');
    expect(a).toContain('-map_metadata');
    expect(a).toContain('2');
    expect(a.filter(x => x === '-map').length).toBe(3);
    expect(a).toContain('[outv]');
    expect(a).toContain('[outa]');
    expect(a).toContain('3:v');
    expect(a).toContain('-disposition:v:1');
  });
});
