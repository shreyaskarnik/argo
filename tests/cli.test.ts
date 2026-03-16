import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../src/record.js', () => ({
  record: vi.fn(),
}));

vi.mock('../src/tts/generate.js', () => ({
  generateClips: vi.fn(),
}));

vi.mock('../src/export.js', () => ({
  exportVideo: vi.fn(),
}));

vi.mock('../src/pipeline.js', () => ({
  runPipeline: vi.fn(),
}));

vi.mock('../src/init.js', () => ({
  init: vi.fn(),
}));

import { loadConfig } from '../src/config.js';
import { record } from '../src/record.js';
import { generateClips } from '../src/tts/generate.js';
import { exportVideo } from '../src/export.js';
import { runPipeline } from '../src/pipeline.js';
import { init } from '../src/init.js';
import { createProgram } from '../src/cli.js';

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedRecord = vi.mocked(record);
const mockedGenerateClips = vi.mocked(generateClips);
const mockedExportVideo = vi.mocked(exportVideo);
const mockedRunPipeline = vi.mocked(runPipeline);
const mockedInit = vi.mocked(init);

const defaultConfig = {
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 1920, height: 1080, fps: 30, browser: 'chromium', deviceScaleFactor: 1 },
  export: { preset: 'slow', crf: 16, thumbnailPath: 'assets/logo-thumb.png' },
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedLoadConfig.mockResolvedValue(defaultConfig as any);
  mockedRecord.mockResolvedValue({ videoPath: '', timingPath: '' });
  mockedGenerateClips.mockResolvedValue([]);
  mockedExportVideo.mockResolvedValue('videos/onboarding.mp4');
  mockedRunPipeline.mockResolvedValue('videos/onboarding.mp4');
  mockedInit.mockResolvedValue(undefined as any);
});

function run(...args: string[]) {
  const program = createProgram();
  program.exitOverride();
  return program.parseAsync(['node', 'argo', ...args]);
}

describe('CLI', () => {
  describe('argo record <demo>', () => {
    it('calls loadConfig and record with demo name', async () => {
      await run('record', 'onboarding');

      expect(mockedLoadConfig).toHaveBeenCalledWith(process.cwd(), undefined);
      expect(mockedRecord).toHaveBeenCalledWith('onboarding', expect.objectContaining({
        demosDir: 'demos',
      }));
    });

    it('passes --config to loadConfig', async () => {
      await run('--config', 'custom.ts', 'record', 'onboarding');

      expect(mockedLoadConfig).toHaveBeenCalledWith(process.cwd(), 'custom.ts');
    });
  });

  describe('argo tts generate <manifest>', () => {
    it('calls loadConfig and generateClips', async () => {
      await run('tts', 'generate', 'manifest.json');

      expect(mockedLoadConfig).toHaveBeenCalledWith(process.cwd(), undefined);
      expect(mockedGenerateClips).toHaveBeenCalledWith(
        expect.objectContaining({ manifestPath: 'manifest.json' }),
      );
    });
  });

  describe('argo export <demo>', () => {
    it('calls loadConfig and exportVideo', async () => {
      await run('export', 'onboarding');

      expect(mockedLoadConfig).toHaveBeenCalledWith(process.cwd(), undefined);
      expect(mockedExportVideo).toHaveBeenCalledWith({
        demoName: 'onboarding',
        argoDir: '.argo',
        outputDir: 'videos',
        preset: 'slow',
        crf: 16,
        fps: 30,
        outputWidth: 1920,
        outputHeight: 1080,
        deviceScaleFactor: 1,
        thumbnailPath: 'assets/logo-thumb.png',
      });
    });
  });

  describe('argo pipeline <demo>', () => {
    it('calls loadConfig and runPipeline', async () => {
      await run('pipeline', 'onboarding');

      expect(mockedLoadConfig).toHaveBeenCalledWith(process.cwd(), undefined);
      expect(mockedRunPipeline).toHaveBeenCalledWith('onboarding', defaultConfig, { headed: undefined });
    });
  });

  describe('argo init', () => {
    it('calls init()', async () => {
      await run('init');

      expect(mockedInit).toHaveBeenCalled();
    });
  });

  describe('global --config option', () => {
    it('passes config path to loadConfig for export command', async () => {
      await run('-c', 'my-config.ts', 'export', 'onboarding');

      expect(mockedLoadConfig).toHaveBeenCalledWith(process.cwd(), 'my-config.ts');
    });
  });

  describe('demo name validation', () => {
    it('rejects demo names with path traversal', async () => {
      await expect(run('record', '../../../etc/passwd')).rejects.toThrow('Invalid demo name');
    });

    it('rejects demo names with spaces', async () => {
      await expect(run('pipeline', 'my demo')).rejects.toThrow('Invalid demo name');
    });

    it('rejects demo names starting with a dot', async () => {
      await expect(run('export', '.hidden')).rejects.toThrow('Invalid demo name');
    });

    it('accepts valid demo names with hyphens and underscores', async () => {
      await run('record', 'my-demo_v2');
      expect(mockedRecord).toHaveBeenCalledWith('my-demo_v2', expect.anything());
    });
  });

  describe('tts generate demoName derivation', () => {
    it('derives demoName from manifest filename using basename', async () => {
      await run('tts', 'generate', 'demos/signup.scenes.json');
      expect(mockedGenerateClips).toHaveBeenCalledWith(
        expect.objectContaining({ demoName: 'signup' }),
      );
    });

    it('strips nested directory paths', async () => {
      await run('tts', 'generate', 'path/to/demos/foo.scenes.json');
      expect(mockedGenerateClips).toHaveBeenCalledWith(
        expect.objectContaining({ demoName: 'foo' }),
      );
    });
  });
});
