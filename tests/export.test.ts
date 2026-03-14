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

  it('throws on missing narration-aligned.wav', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('narration-aligned.wav')) return false;
      return true;
    });

    await expect(exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' }))
      .rejects.toThrow(/narration-aligned\.wav/);
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
});
