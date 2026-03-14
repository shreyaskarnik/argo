import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../src/tts/generate.js', () => ({
  generateClips: vi.fn(),
}));

vi.mock('../src/record.js', () => ({
  record: vi.fn(),
}));

vi.mock('../src/export.js', () => ({
  checkFfmpeg: vi.fn(),
  exportVideo: vi.fn(),
}));

// Mock execFileSync (used by getVideoDurationMs for ffprobe)
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue('16.240\n'),
}));

import { execFileSync } from 'node:child_process';
import { generateClips } from '../src/tts/generate.js';
import { record } from '../src/record.js';
import { checkFfmpeg, exportVideo } from '../src/export.js';
import { runPipeline } from '../src/pipeline.js';
import { createWavBuffer } from '../src/tts/engine.js';
import type { ArgoConfig } from '../src/config.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedGenerateClips = vi.mocked(generateClips);
const mockedRecord = vi.mocked(record);
const mockedCheckFfmpeg = vi.mocked(checkFfmpeg);
const mockedExportVideo = vi.mocked(exportVideo);

const DEMO_NAME = 'test-demo';
const ARGO_DIR = join('.argo', DEMO_NAME);
const TIMING_PATH = join(ARGO_DIR, '.timing.json');
const VIDEO_PATH = join(ARGO_DIR, 'video.webm');

const mockEngine = { generate: vi.fn().mockResolvedValue(Buffer.from('fake')) };

const defaultConfig: Pick<ArgoConfig, 'baseURL' | 'demosDir' | 'outputDir' | 'tts' | 'video' | 'export' | 'overlays'> = {
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0, engine: mockEngine },
  video: { width: 1920, height: 1080, fps: 30, browser: 'chromium' as const, deviceScaleFactor: 1 },
  export: { preset: 'slow', crf: 16, thumbnailPath: 'assets/thumb.png' },
  overlays: { autoBackground: false },
};

function setupFixtures() {
  mkdirSync(join(ARGO_DIR, 'clips'), { recursive: true });
  // Write a minimal timing file
  writeFileSync(TIMING_PATH, JSON.stringify({ intro: 1000, done: 5000 }));
  // Write a minimal video placeholder (ffprobe is mocked)
  writeFileSync(VIDEO_PATH, Buffer.from('fake-video'));
  // Write clip WAV files
  const silence = createWavBuffer(new Float32Array(24000), 24000); // 1s silence
  writeFileSync(join(ARGO_DIR, 'clips', 'intro.wav'), silence);
  writeFileSync(join(ARGO_DIR, 'clips', 'done.wav'), silence);
}

beforeEach(() => {
  vi.resetAllMocks();
  rmSync('.argo', { recursive: true, force: true });
  setupFixtures();

  mockedExecFileSync.mockReturnValue('16.240\n');
  mockedCheckFfmpeg.mockReturnValue(true);
  mockedGenerateClips.mockResolvedValue([
    { scene: 'intro', clipPath: join(ARGO_DIR, 'clips', 'intro.wav'), durationMs: 1000 },
    { scene: 'done', clipPath: join(ARGO_DIR, 'clips', 'done.wav'), durationMs: 1000 },
  ]);
  mockedRecord.mockResolvedValue({ videoPath: VIDEO_PATH, timingPath: TIMING_PATH });
  mockedExportVideo.mockResolvedValue(`videos/${DEMO_NAME}.mp4`);
});

describe('runPipeline', () => {
  it('calls checkFfmpeg before other steps', async () => {
    const callOrder: string[] = [];
    mockedCheckFfmpeg.mockImplementation(() => { callOrder.push('checkFfmpeg'); return true; });
    mockedGenerateClips.mockImplementation(async () => {
      callOrder.push('generateClips');
      return [
        { scene: 'intro', clipPath: join(ARGO_DIR, 'clips', 'intro.wav'), durationMs: 1000 },
        { scene: 'done', clipPath: join(ARGO_DIR, 'clips', 'done.wav'), durationMs: 1000 },
      ];
    });
    mockedRecord.mockImplementation(async () => { callOrder.push('record'); return { videoPath: VIDEO_PATH, timingPath: TIMING_PATH }; });
    mockedExportVideo.mockImplementation(async () => { callOrder.push('exportVideo'); return 'out.mp4'; });

    await runPipeline(DEMO_NAME, defaultConfig);
    expect(callOrder[0]).toBe('checkFfmpeg');
  });

  it('calls steps in order: generateClips → record → exportVideo', async () => {
    const callOrder: string[] = [];
    mockedCheckFfmpeg.mockImplementation(() => { callOrder.push('checkFfmpeg'); return true; });
    mockedGenerateClips.mockImplementation(async () => {
      callOrder.push('generateClips');
      return [
        { scene: 'intro', clipPath: join(ARGO_DIR, 'clips', 'intro.wav'), durationMs: 1000 },
        { scene: 'done', clipPath: join(ARGO_DIR, 'clips', 'done.wav'), durationMs: 1000 },
      ];
    });
    mockedRecord.mockImplementation(async () => { callOrder.push('record'); return { videoPath: VIDEO_PATH, timingPath: TIMING_PATH }; });
    mockedExportVideo.mockImplementation(async () => { callOrder.push('exportVideo'); return 'out.mp4'; });

    await runPipeline(DEMO_NAME, defaultConfig);
    expect(callOrder).toEqual(['checkFfmpeg', 'generateClips', 'record', 'exportVideo']);
  });

  it('returns the output path from exportVideo', async () => {
    const result = await runPipeline(DEMO_NAME, defaultConfig);
    expect(result).toBe(`videos/${DEMO_NAME}.mp4`);
  });

  it('passes correct options to generateClips', async () => {
    await runPipeline(DEMO_NAME, defaultConfig);
    expect(mockedGenerateClips).toHaveBeenCalledWith({
      manifestPath: `demos/${DEMO_NAME}.voiceover.json`,
      demoName: DEMO_NAME,
      engine: mockEngine,
      projectRoot: '.',
      defaults: { voice: 'af_heart', speed: 1.0 },
    });
  });

  it('passes correct options to record', async () => {
    await runPipeline(DEMO_NAME, defaultConfig);
    expect(mockedRecord).toHaveBeenCalledWith(DEMO_NAME, {
      demosDir: 'demos',
      baseURL: 'http://localhost:3000',
      video: { width: 1920, height: 1080 },
      browser: 'chromium',
      deviceScaleFactor: 1,
      autoBackground: false,
    });
  });

  it('passes correct options to exportVideo', async () => {
    await runPipeline(DEMO_NAME, defaultConfig);
    expect(mockedExportVideo).toHaveBeenCalledWith({
      demoName: DEMO_NAME,
      argoDir: '.argo',
      outputDir: 'videos',
      preset: 'slow',
      crf: 16,
      fps: 30,
      outputWidth: 1920,
      outputHeight: 1080,
      deviceScaleFactor: 1,
      thumbnailPath: 'assets/thumb.png',
      chapterMetadataPath: '.argo/test-demo/chapters.txt',
    });
  });

  it('writes scene durations metadata for recording-time pacing', async () => {
    mockedGenerateClips.mockResolvedValue([
      { scene: 'intro', clipPath: join(ARGO_DIR, 'clips', 'intro.wav'), durationMs: 1200 },
      { scene: 'done', clipPath: join(ARGO_DIR, 'clips', 'done.wav'), durationMs: 900 },
    ]);

    await runPipeline(DEMO_NAME, defaultConfig);

    const metadata = JSON.parse(readFileSync(join(ARGO_DIR, '.scene-durations.json'), 'utf-8'));
    expect(metadata).toEqual({ intro: 1200, done: 900 });
  });

  it('pads export when aligned audio outlasts the recording', async () => {
    mockedExecFileSync.mockReturnValue('5.000\n');

    await runPipeline(DEMO_NAME, defaultConfig);

    expect(mockedExportVideo).toHaveBeenCalledWith(expect.objectContaining({
      tailPadMs: 1100,
    }));
  });

  it('writes narration-aligned.wav to .argo/<demo>/', async () => {
    const { existsSync } = await import('node:fs');
    await runPipeline(DEMO_NAME, defaultConfig);
    expect(existsSync(join(ARGO_DIR, 'narration-aligned.wav'))).toBe(true);
  });

  it('propagates error from checkFfmpeg', async () => {
    mockedCheckFfmpeg.mockImplementation(() => { throw new Error('ffmpeg not found'); });
    await expect(runPipeline(DEMO_NAME, defaultConfig)).rejects.toThrow('ffmpeg not found');
  });

  it('propagates error from generateClips', async () => {
    mockedGenerateClips.mockRejectedValue(new Error('TTS failed'));
    await expect(runPipeline(DEMO_NAME, defaultConfig)).rejects.toThrow('TTS failed');
  });

  it('propagates error from record', async () => {
    mockedRecord.mockRejectedValue(new Error('Recording failed'));
    await expect(runPipeline(DEMO_NAME, defaultConfig)).rejects.toThrow('Recording failed');
  });

  it('propagates error from exportVideo', async () => {
    mockedExportVideo.mockRejectedValue(new Error('Export failed'));
    await expect(runPipeline(DEMO_NAME, defaultConfig)).rejects.toThrow('Export failed');
  });
});
