import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('../src/progress.js', () => ({
  runFfmpegWithProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/gpu-encoder.js', () => ({
  detectGpuEncoder: vi.fn().mockResolvedValue(null),
  getGpuEncoderName: vi.fn((enc: string | null, _codec: string) => enc ? `h264_${enc}` : 'libx264'),
  isGpuEncodingEnabled: vi.fn().mockReturnValue(true),
  resolveEncoder: vi.fn().mockResolvedValue(null),
}));

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { runFfmpegWithProgress } from '../src/progress.js';
import { checkFfmpeg, exportVideo } from '../src/export.js';
import { detectGpuEncoder, getGpuEncoderName, isGpuEncodingEnabled, resolveEncoder } from '../src/gpu-encoder.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedDetectGpuEncoder = vi.mocked(detectGpuEncoder);
const mockedGetGpuEncoderName = vi.mocked(getGpuEncoderName);
const mockedIsGpuEncodingEnabled = vi.mocked(isGpuEncodingEnabled);
const mockedResolveEncoder = vi.mocked(resolveEncoder);

beforeEach(() => {
  vi.resetAllMocks();
  // Default: no GPU encoder, GPU encoding enabled
  mockedDetectGpuEncoder.mockResolvedValue(null);
  mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc ? `h264_${enc}` : 'libx264');
  mockedIsGpuEncodingEnabled.mockReturnValue(true);
  // resolveEncoder delegates to existing mocks so tests can keep driving
  // behavior through mockedDetectGpuEncoder + mockedIsGpuEncodingEnabled.
  mockedResolveEncoder.mockImplementation(async () => {
    return mockedIsGpuEncodingEnabled() ? await mockedDetectGpuEncoder() : null;
  });
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
    mockedExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.includes('.imported')) return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);
  }

  it('builds correct default ffmpeg args', async () => {
    setupHappy();
    const result = await exportVideo({ demoName: 'my-demo', argoDir: '.argo', outputDir: 'videos' });

    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedSpawnSync.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args).toEqual([
      '-i', '.argo/my-demo/video.mp4',
      '-i', '.argo/my-demo/narration-aligned.wav',
      '-vf', 'scale=in_range=pc:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'slow',
      '-crf', '16',
      '-x264-params', 'aq-mode=3:aq-strength=0.8:deblock=1,1:colorprim=bt709:transfer=bt709:colormatrix=bt709',
      '-colorspace:v', 'bt709',
      '-color_primaries:v', 'bt709',
      '-color_trc:v', 'bt709',
      '-color_range', 'tv',
      '-video_track_timescale', '90000',
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
    const vfIdx = (args as string[]).indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    const vfValue = (args as string[])[vfIdx + 1];
    expect(vfValue).toContain('tpad=stop_mode=clone:stop_duration=1.25');
    expect(vfValue).toContain('scale=in_range=pc:out_range=tv');
  });

  it('adds lanczos downscale filter when deviceScaleFactor > 1', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      outputWidth: 1920, outputHeight: 1080, deviceScaleFactor: 2,
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const vfIdx = (args as string[]).indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    const vfValue = (args as string[])[vfIdx + 1];
    expect(vfValue).toContain('scale=1920:1080:flags=lanczos');
    expect(vfValue).toContain('scale=in_range=pc:out_range=tv');
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
      'tpad=stop_mode=clone:stop_duration=0.5,scale=1920:1080:flags=lanczos,scale=in_range=pc:out_range=tv,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'
    );
  });

  it('throws on missing video file', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      const ps = String(p);
      // No video file at all
      if (ps.includes('video.')) return false;
      return true;
    });

    await expect(exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' }))
      .rejects.toThrow(/No video found/);
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
    // range conversion filter appended after speed ramp; final video label is outvfinal
    expect(a).toContain('[outvfinal]');
    expect(a).toContain('[outa]');
    expect(a).toContain('3:v');
    expect(a).toContain('-disposition:v:1');
  });

  // ---------- background music ----------

  const mockedRunFfmpegWithProgress = vi.mocked(runFfmpegWithProgress);

  it('adds music input with loop and volume filter when musicPath is set', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/bg-music.mp3',
      totalDurationMs: 10000,
    });

    // totalDurationMs triggers the progress path
    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    // Music input should be looped
    expect(a).toContain('-stream_loop');
    expect(a).toContain('-1');
    expect(a).toContain('assets/bg-music.mp3');
    // filter_complex should contain volume and amix
    expect(a).toContain('-filter_complex');
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('volume=0.15');
    expect(fc).toContain('amix=inputs=2:duration=first');
    // Should have audio codec
    expect(a).toContain('-c:a');
    expect(a).toContain('aac');
  });

  it('uses custom musicVolume when specified', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/bg-music.mp3',
      musicVolume: 0.3,
      totalDurationMs: 10000,
    });

    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('volume=0.3');
  });

  it('adds fade-out on music in last 2 seconds', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/bg-music.mp3',
      totalDurationMs: 10000,
    });

    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('afade=t=out:st=8:d=2');
  });

  it('uses music as sole audio in silent mode (no narration)', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p).endsWith('narration-aligned.wav')) return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/bg-music.mp3',
      totalDurationMs: 5000,
    });

    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    // Should have music input
    expect(a).toContain('assets/bg-music.mp3');
    // Should have audio codec (music provides audio)
    expect(a).toContain('-c:a');
    expect(a).toContain('aac');
    // filter_complex should have volume but NOT amix (no narration to mix with)
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('volume=0.15');
    expect(fc).not.toContain('amix');
  });

  it('skips music when musicPath does not exist on disk', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p) === 'assets/missing-music.mp3') return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/missing-music.mp3',
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).not.toContain('assets/missing-music.mp3');
    expect(a).not.toContain('-stream_loop');
  });

  it('applies loudnorm after music mixing', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/bg-music.mp3',
      loudnorm: true,
      totalDurationMs: 10000,
    });

    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    // loudnorm should come after amix
    expect(fc).toContain('amix');
    expect(fc).toContain('loudnorm');
    // loudnorm input should be the amixed output
    expect(fc).toContain('[amixed]loudnorm');
  });

  // amix defaults to normalize=1, which divides every input by the input count:
  // music under narration would cost the narration 6 dB, however quiet the music.
  it('mixes music without normalizing, so the narration keeps its level', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      musicPath: 'assets/bg-music.mp3',
      totalDurationMs: 10000,
    });

    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    const fc = a[a.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[1:a][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[amixed]');
  });

  // ---------- extra audio tracks (composition sound effects) ----------

  it('mixes extra audio tracks over the narration without normalizing or compensating', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      extraAudioTracks: [
        { src: 'sfx/ding.wav', startMs: 1000 },
        { src: 'sfx/whoosh.wav', startMs: 2500, volume: 0.4 },
      ],
    });

    const a = mockedSpawnSync.mock.calls[0][1] as string[];
    const fc = a[a.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[2:a]adelay=1000|1000,volume=0.7[xa0]');
    expect(fc).toContain('[3:a]adelay=2500|2500,volume=0.4[xa1]');
    expect(fc).toContain('[1:a][xa0][xa1]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0[xamixed]');
  });

  it('keeps each extra audio track at its own volume when there is no narration', async () => {
    setupHappy();
    mockedExistsSync.mockImplementation((p) => {
      const path = String(p);
      return !path.includes('.imported') && !path.endsWith('narration-aligned.wav');
    });
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      extraAudioTracks: [
        { src: 'sfx/ding.wav', startMs: 0 },
        { src: 'sfx/whoosh.wav', startMs: 500 },
      ],
    });

    const a = mockedSpawnSync.mock.calls[0][1] as string[];
    const fc = a[a.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[xa0][xa1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[xamixed]');
  });

  // ---------- watermark ----------

  it('adds watermark overlay with default position (bottom-right) and opacity', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      watermark: { src: 'assets/logo.png' },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // Watermark image should be an input
    expect(a).toContain('assets/logo.png');
    // Should have filter_complex with overlay
    expect(a).toContain('-filter_complex');
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    // Default opacity 0.7 → colorchannelmixer
    expect(fc).toContain('colorchannelmixer=aa=0.7');
    // Default position bottom-right with margin 20
    expect(fc).toContain('overlay=x=W-w-20:y=H-h-20:format=auto');
  });

  it('places watermark at top-left with custom margin', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      watermark: { src: 'assets/logo.png', position: 'top-left', margin: 10 },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('overlay=x=10:y=10:format=auto');
  });

  it('places watermark at top-right', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      watermark: { src: 'assets/logo.png', position: 'top-right', margin: 30 },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('overlay=x=W-w-30:y=30:format=auto');
  });

  it('places watermark at bottom-left', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      watermark: { src: 'assets/logo.png', position: 'bottom-left' },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('overlay=x=20:y=H-h-20:format=auto');
  });

  it('skips colorchannelmixer when opacity is 1.0', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      watermark: { src: 'assets/logo.png', opacity: 1.0 },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).not.toContain('colorchannelmixer');
    expect(fc).toContain('overlay=');
  });

  it('skips watermark when src does not exist on disk', async () => {
    mockedExecFileSync.mockReturnValue(Buffer.from('ok'));
    mockedExistsSync.mockImplementation((p) => {
      if (String(p) === 'assets/missing-logo.png') return false;
      return true;
    });
    mockedSpawnSync.mockReturnValue({ status: 0 } as any);

    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      watermark: { src: 'assets/missing-logo.png' },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).not.toContain('assets/missing-logo.png');
    // No filter_complex for watermark
    expect(a).not.toContain('-filter_complex');
  });

  // ---------- overlay PNGs ----------

  it('adds overlay PNG inputs with correct filter_complex for imported videos', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      overlayPngs: [
        { scene: 'intro', pngPath: '/tmp/intro-overlay.png', zone: 'bottom-center', startMs: 0, endMs: 5000 },
        { scene: 'features', pngPath: '/tmp/features-overlay.png', zone: 'top-left', startMs: 5000, endMs: 10000 },
      ],
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // Should have overlay PNG inputs with -loop 1 and -t
    expect(a).toContain('-loop');
    expect(a).toContain('/tmp/intro-overlay.png');
    expect(a).toContain('/tmp/features-overlay.png');
    // Should have filter_complex with overlay enable expressions
    expect(a).toContain('-filter_complex');
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('overlay=');
    expect(fc).toContain("enable='between");
    expect(fc).toContain('0.000');
    expect(fc).toContain('5.000');
    expect(fc).toContain('10.000');
  });

  it('does not use -shortest for imported videos with narration and no overlays', async () => {
    setupHappy();
    mockedExistsSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('.argo/demo/.imported')) return true;
      return true;
    });

    await exportVideo({
      demoName: 'demo',
      argoDir: '.argo',
      outputDir: 'out',
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    expect(args as string[]).not.toContain('-shortest');
  });

  it('overlay PNG input indices account for other inputs', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      chapterMetadataPath: '.argo/demo/chapters.txt',
      overlayPngs: [
        { scene: 'intro', pngPath: '/tmp/intro-overlay.png', zone: 'center', startMs: 0, endMs: 3000 },
      ],
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // Inputs: 0=video, 1=audio, 2=chapters, 3=overlay PNG
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    // Overlay PNG should reference input 3 (after video, audio, chapters)
    expect(fc).toContain('[3:v]');
  });

  it('empty overlayPngs array does not affect output', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      overlayPngs: [],
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // No filter_complex from empty overlays
    expect(a).not.toContain('-filter_complex');
    expect(a).not.toContain('-loop');
  });

  it('watermark input index accounts for other inputs (audio, chapters, thumbnail)', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      chapterMetadataPath: '.argo/demo/chapters.txt',
      thumbnailPath: 'assets/thumb.png',
      watermark: { src: 'assets/logo.png', opacity: 1.0 },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // Inputs: 0=video, 1=audio, 2=chapters, 3=thumbnail, 4=watermark
    const inputPaths = a.reduce<string[]>((acc, x, i) => {
      if (x === '-i' && i + 1 < a.length) acc.push(a[i + 1]);
      return acc;
    }, []);
    expect(inputPaths).toContain('assets/logo.png');
    expect(inputPaths.indexOf('assets/logo.png')).toBe(4); // 5th input (index 4)
    // filter_complex should reference correct watermark input
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];
    expect(fc).toContain('[4:v]');
  });

  // ---------- BT.709 color space tagging ----------

  it('embeds BT.709 color metadata in the output args', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];

    // x264-params should include BT.709 + AQ tuning
    const x264Idx = a.indexOf('-x264-params');
    expect(x264Idx).toBeGreaterThan(-1);
    const x264Params = a[x264Idx + 1];
    expect(x264Params).toContain('colorprim=bt709');
    expect(x264Params).toContain('transfer=bt709');
    expect(x264Params).toContain('colormatrix=bt709');
    expect(x264Params).toContain('aq-mode=3');
    expect(x264Params).toContain('aq-strength=0.8');
    expect(x264Params).toContain('deblock=1,1');

    // Container-level color tags
    expect(a).toContain('-colorspace:v');
    expect(a[a.indexOf('-colorspace:v') + 1]).toBe('bt709');
    expect(a).toContain('-color_primaries:v');
    expect(a[a.indexOf('-color_primaries:v') + 1]).toBe('bt709');
    expect(a).toContain('-color_trc:v');
    expect(a[a.indexOf('-color_trc:v') + 1]).toBe('bt709');
    expect(a).toContain('-color_range');
    expect(a[a.indexOf('-color_range') + 1]).toBe('tv');

    // Frame-level setparams for GPU encoders (videotoolbox/nvenc/vaapi don't
    // honor container-level flags — setparams embeds metadata in the stream).
    const vfIdx2 = a.indexOf('-vf');
    expect(vfIdx2).toBeGreaterThan(-1);
    expect(a[vfIdx2 + 1]).toContain('setparams=color_primaries=bt709');

    // Fixed timescale
    expect(a).toContain('-video_track_timescale');
    expect(a[a.indexOf('-video_track_timescale') + 1]).toBe('90000');
  });

  // ---------- Full-range to TV-range conversion ----------

  it('includes scale=in_range=pc:out_range=tv in video filter args', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];

    // Should appear as a -vf filter
    const vfIdx = a.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    const vfValue = a[vfIdx + 1];
    expect(vfValue).toContain('scale=in_range=pc:out_range=tv');
  });

  it('embeds BT.709 color metadata in blur-fill format variant args', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', formats: ['1:1'] });

    // The second spawnSync call is the blur-fill variant export
    expect(mockedSpawnSync.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, variantArgs] = mockedSpawnSync.mock.calls[1];
    const a = variantArgs as string[];

    // x264-params should include BT.709 + AQ tuning
    const x264Idx = a.indexOf('-x264-params');
    expect(x264Idx).toBeGreaterThan(-1);
    const x264Params = a[x264Idx + 1];
    expect(x264Params).toContain('colorprim=bt709');
    expect(x264Params).toContain('transfer=bt709');
    expect(x264Params).toContain('colormatrix=bt709');
    expect(x264Params).toContain('aq-mode=3');
    expect(x264Params).toContain('aq-strength=0.8');
    expect(x264Params).toContain('deblock=1,1');

    // Container-level color tags
    expect(a).toContain('-colorspace:v');
    expect(a[a.indexOf('-colorspace:v') + 1]).toBe('bt709');
    expect(a).toContain('-color_primaries:v');
    expect(a[a.indexOf('-color_primaries:v') + 1]).toBe('bt709');
    expect(a).toContain('-color_trc:v');
    expect(a[a.indexOf('-color_trc:v') + 1]).toBe('bt709');
    expect(a).toContain('-color_range');
    expect(a[a.indexOf('-color_range') + 1]).toBe('tv');

    // Frame-level setparams for GPU encoders — blur-fill uses filter_complex.
    const fcIdx2 = a.indexOf('-filter_complex');
    expect(fcIdx2).toBeGreaterThan(-1);
    expect(a[fcIdx2 + 1]).toContain('setparams=color_primaries=bt709');

    // Fixed timescale
    expect(a).toContain('-video_track_timescale');
    expect(a[a.indexOf('-video_track_timescale') + 1]).toBe('90000');
  });

  it('includes scale=in_range=pc:out_range=tv in blur-fill format variant filter_complex', async () => {
    setupHappy();
    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', formats: ['1:1'] });

    // The second spawnSync call is the blur-fill variant export
    expect(mockedSpawnSync.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, variantArgs] = mockedSpawnSync.mock.calls[1];
    const a = variantArgs as string[];

    const fcIdx = a.indexOf('-filter_complex');
    expect(fcIdx).toBeGreaterThan(-1);
    const fcValue = a[fcIdx + 1];
    expect(fcValue).toContain('scale=in_range=pc:out_range=tv');
  });

  // ---------- GPU encoder integration ----------

  it('uses GPU encoder codec name when GPU is available', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('videotoolbox');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('h264_videotoolbox');
    expect(a).not.toContain('libx264');
    // GPU encoders do not use -x264-params
    expect(a).not.toContain('-x264-params');
    // Container color tags and timescale still apply
    expect(a).toContain('-colorspace:v');
    expect(a).toContain('-video_track_timescale');
  });

  it('falls back to libx264 when ARGO_USE_GPU=0', async () => {
    setupHappy();
    mockedIsGpuEncodingEnabled.mockReturnValue(false);
    // Even if detectGpuEncoder would return something, isGpuEncodingEnabled=false prevents it
    mockedDetectGpuEncoder.mockResolvedValue('nvenc');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out' });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('libx264');
    expect(a).not.toContain('h264_nvenc');
    // libx264 fallback includes -x264-params
    expect(a).toContain('-x264-params');
  });

  it('uses -cq for nvenc encoder quality flag', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('nvenc');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'nvenc' ? 'h264_nvenc' : 'libx264');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', crf: 18 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('-cq');
    expect(a[a.indexOf('-cq') + 1]).toBe('18');
    expect(a).not.toContain('-crf');
  });

  it('uses -q:v and -allow_sw for videotoolbox encoder', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('videotoolbox');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', crf: 16 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('-q:v');
    // crf=16 → q:v = 100 - 16*2 = 68
    expect(a[a.indexOf('-q:v') + 1]).toBe('68');
    expect(a).toContain('-allow_sw');
    expect(a).toContain('1');
    expect(a).not.toContain('-crf');
  });

  it('uses -qp for vaapi encoder and appends hwupload after scale in -vf (no filter_complex)', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('vaapi');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'vaapi' ? 'h264_vaapi' : 'libx264');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', crf: 20 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('-qp');
    expect(a[a.indexOf('-qp') + 1]).toBe('20');
    expect(a).toContain('vaapi_vld');
    // vaapi_device should appear before the first -i
    const deviceIdx = a.indexOf('-vaapi_device');
    const firstInputIdx = a.indexOf('-i');
    expect(deviceIdx).toBeGreaterThan(-1);
    expect(deviceIdx).toBeLessThan(firstInputIdx);
    // With no filter_complex features, hwupload is appended to the -vf chain
    // (after scale=in_range=pc:out_range=tv) — not as a separate -vf arg
    const vfIdx = a.indexOf('-vf');
    expect(vfIdx).toBeGreaterThan(-1);
    const vfValue = a[vfIdx + 1];
    expect(vfValue).toContain('scale=in_range=pc:out_range=tv');
    expect(vfValue).toContain('hwupload');
    // hwupload must come AFTER scale (software filter before hw upload)
    expect(vfValue.indexOf('hwupload')).toBeGreaterThan(vfValue.indexOf('scale=in_range=pc:out_range=tv'));
    // Only one -vf flag (not two)
    expect(a.filter(x => x === '-vf').length).toBe(1);
  });

  it('VAAPI: hwupload deferred to last filter_complex node when transitions are active', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('vaapi');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'vaapi' ? 'h264_vaapi' : 'libx264');

    // Transitions force a filter_complex graph (split+trim+fade+concat)
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      placements: [
        { scene: 'a', startMs: 0, durationMs: 3000, text: 'A' },
        { scene: 'b', startMs: 3000, durationMs: 3000, text: 'B' },
      ],
      transition: { type: 'fade-through-black', durationMs: 500 },
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // Must use filter_complex (fade transitions require it)
    expect(a).toContain('-filter_complex');
    const fcIdx = a.indexOf('-filter_complex');
    const fc = a[fcIdx + 1];

    // hwupload must be present in the filter_complex
    expect(fc).toContain('hwupload');
    // hwupload must come AFTER split and fade/trim — i.e., after the concat output
    const splitPos = fc.indexOf('split=');
    const hwuploadPos = fc.indexOf('hwupload');
    expect(hwuploadPos).toBeGreaterThan(splitPos);

    // No standalone -vf for hwupload (would conflict with filter_complex)
    const vfIdx = a.indexOf('-vf');
    if (vfIdx >= 0) {
      expect(a[vfIdx + 1]).not.toContain('hwupload');
    }
  });

  it('uses -global_quality for qsv encoder', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('qsv');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'qsv' ? 'h264_qsv' : 'libx264');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', crf: 22 });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    expect(a).toContain('-global_quality');
    expect(a[a.indexOf('-global_quality') + 1]).toBe('22');
    expect(a).not.toContain('-crf');
  });

  it('uses GPU encoder for blur-fill format variants too', async () => {
    setupHappy();
    mockedDetectGpuEncoder.mockResolvedValue('videotoolbox');
    mockedGetGpuEncoderName.mockImplementation((enc, _codec) => enc === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264');

    await exportVideo({ demoName: 'demo', argoDir: '.argo', outputDir: 'out', formats: ['1:1'] });

    // The second spawnSync call is the blur-fill variant export
    expect(mockedSpawnSync.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [, variantArgs] = mockedSpawnSync.mock.calls[1];
    const a = variantArgs as string[];
    expect(a).toContain('h264_videotoolbox');
    expect(a).not.toContain('libx264');
    expect(a).not.toContain('-x264-params');
    // Container color tags still present
    expect(a).toContain('-colorspace:v');
    expect(a).toContain('-video_track_timescale');
  });

  it('routes vFilters through filter_complex when frame effect adds a PNG input', async () => {
    // Regression: without this, `-vf` was pushed before the frame PNG `-i`,
    // and ffmpeg rejected with "Option vf cannot be applied to input url".
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      frame: {
        padding: 48,
        borderRadius: 16,
        shadow: 0.3,
        background: { type: 'gradient', value: 'linear-gradient(135deg, #1a1a2e, #16213e)' },
      },
      framePngPath: '.argo/demo/frame.png',
    });

    const [, args] = mockedSpawnSync.mock.calls[0];
    const a = args as string[];
    // With frame active, there should be NO bare -vf arg — all filters must be
    // inside filter_complex so subsequent -i (frame PNG) is accepted.
    expect(a).not.toContain('-vf');
    expect(a).toContain('-filter_complex');
    // And the frame PNG is registered as a normal -i input
    const inputCount = a.filter(x => x === '-i').length;
    expect(inputCount).toBeGreaterThanOrEqual(3); // video + audio + frame.png
  });

  // ---------- shader transitions ----------

  it('threads shader PNG sequences through ffmpeg with splice filter_complex', async () => {
    setupHappy();
    await exportVideo({
      demoName: 'demo', argoDir: '.argo', outputDir: 'out',
      placements: [
        { scene: 'a', startMs: 0, endMs: 3000 },
        { scene: 'b', startMs: 3000, endMs: 6000 },
      ],
      transition: { type: 'shader', shader: 'crosswarp', durationMs: 800 },
      shaderTransitions: [
        { boundarySec: 3.0, durationMs: 800, pngDir: '.argo/demo/shaders/abc123', frameCount: 24 },
      ],
      totalDurationMs: 6000,
    });

    // totalDurationMs triggers runFfmpegWithProgress path
    const a = mockedRunFfmpegWithProgress.mock.calls[0][0] as string[];
    // PNG sequence input is added
    expect(a).toContain('-framerate');
    const fIdx = a.indexOf('-framerate');
    expect(a[fIdx + 1]).toBe('30');  // default fps
    // frame_%04d.png pattern present
    expect(a.some(x => x.includes('frame_%04d.png'))).toBe(true);
    // filter_complex contains shader splice output
    expect(a).toContain('-filter_complex');
    const fc = a[a.indexOf('-filter_complex') + 1];
    expect(fc).toContain('[svout]');
    expect(fc).toMatch(/concat=n=3/);
  });
});
