import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { generateClips } from '../src/tts/generate.js';
import { record } from '../src/record.js';
import { checkFfmpeg, exportVideo } from '../src/export.js';
import { runPipeline } from '../src/pipeline.js';
import type { ArgoConfig } from '../src/config.js';

const mockedGenerateClips = vi.mocked(generateClips);
const mockedRecord = vi.mocked(record);
const mockedCheckFfmpeg = vi.mocked(checkFfmpeg);
const mockedExportVideo = vi.mocked(exportVideo);

const defaultConfig: Pick<ArgoConfig, 'baseURL' | 'demosDir' | 'outputDir' | 'tts' | 'video' | 'export'> = {
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 2560, height: 1440, fps: 30 },
  export: { preset: 'slow', crf: 16 },
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedCheckFfmpeg.mockReturnValue(true);
  mockedGenerateClips.mockResolvedValue([]);
  mockedRecord.mockResolvedValue({ videoPath: '.argo/my-demo/video.webm', timingPath: '.argo/my-demo/.timing.json' });
  mockedExportVideo.mockResolvedValue('videos/my-demo.mp4');
});

describe('runPipeline', () => {
  it('calls checkFfmpeg before other steps', async () => {
    const callOrder: string[] = [];
    mockedCheckFfmpeg.mockImplementation(() => { callOrder.push('checkFfmpeg'); return true; });
    mockedGenerateClips.mockImplementation(async () => { callOrder.push('generateClips'); return []; });
    mockedRecord.mockImplementation(async () => { callOrder.push('record'); return { videoPath: '', timingPath: '' }; });
    mockedExportVideo.mockImplementation(async () => { callOrder.push('exportVideo'); return 'out.mp4'; });

    await runPipeline('my-demo', defaultConfig);

    expect(callOrder[0]).toBe('checkFfmpeg');
  });

  it('calls steps in order: generateClips → record → exportVideo', async () => {
    const callOrder: string[] = [];
    mockedCheckFfmpeg.mockImplementation(() => { callOrder.push('checkFfmpeg'); return true; });
    mockedGenerateClips.mockImplementation(async () => { callOrder.push('generateClips'); return []; });
    mockedRecord.mockImplementation(async () => { callOrder.push('record'); return { videoPath: '', timingPath: '' }; });
    mockedExportVideo.mockImplementation(async () => { callOrder.push('exportVideo'); return 'out.mp4'; });

    await runPipeline('my-demo', defaultConfig);

    expect(callOrder).toEqual(['checkFfmpeg', 'generateClips', 'record', 'exportVideo']);
  });

  it('returns the output path from exportVideo', async () => {
    mockedExportVideo.mockResolvedValue('videos/my-demo.mp4');

    const result = await runPipeline('my-demo', defaultConfig);

    expect(result).toBe('videos/my-demo.mp4');
  });

  it('passes correct options to generateClips', async () => {
    await runPipeline('my-demo', defaultConfig);

    expect(mockedGenerateClips).toHaveBeenCalledWith({
      manifestPath: 'demos/my-demo.voiceover.json',
      demoName: 'my-demo',
      engine: undefined,
      projectRoot: '.',
      defaults: { voice: 'af_heart', speed: 1.0 },
    });
  });

  it('passes correct options to record', async () => {
    await runPipeline('my-demo', defaultConfig);

    expect(mockedRecord).toHaveBeenCalledWith('my-demo', {
      demosDir: 'demos',
      baseURL: 'http://localhost:3000',
      video: { width: 2560, height: 1440 },
    });
  });

  it('passes correct options to exportVideo', async () => {
    await runPipeline('my-demo', defaultConfig);

    expect(mockedExportVideo).toHaveBeenCalledWith({
      demoName: 'my-demo',
      argoDir: '.argo',
      outputDir: 'videos',
      preset: 'slow',
      crf: 16,
      fps: 30,
      width: 2560,
      height: 1440,
    });
  });

  it('propagates error from checkFfmpeg', async () => {
    mockedCheckFfmpeg.mockImplementation(() => { throw new Error('ffmpeg not found'); });

    await expect(runPipeline('my-demo', defaultConfig)).rejects.toThrow('ffmpeg not found');
  });

  it('propagates error from generateClips', async () => {
    mockedGenerateClips.mockRejectedValue(new Error('TTS failed'));

    await expect(runPipeline('my-demo', defaultConfig)).rejects.toThrow('TTS failed');
  });

  it('propagates error from record', async () => {
    mockedRecord.mockRejectedValue(new Error('Recording failed'));

    await expect(runPipeline('my-demo', defaultConfig)).rejects.toThrow('Recording failed');
  });

  it('propagates error from exportVideo', async () => {
    mockedExportVideo.mockRejectedValue(new Error('Export failed'));

    await expect(runPipeline('my-demo', defaultConfig)).rejects.toThrow('Export failed');
  });
});
