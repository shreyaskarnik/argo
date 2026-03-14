import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface MlxAudioEngineOptions {
  modelPath?: string;
}

export class MlxAudioEngine implements TTSEngine {
  private modelPath: string;

  constructor(options?: MlxAudioEngineOptions) {
    this.modelPath = options?.modelPath ?? 'lucasnewman/f5-tts-mlx';
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    const { execFileSync } = await import('node:child_process');
    const { readFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'argo-mlx-'));
    const outputPath = join(tmpDir, 'output.wav');

    try {
      // mlx-audio uses a Python CLI
      execFileSync('python3', [
        '-m', 'f5_tts_mlx.generate',
        '--text', text,
        '--output', outputPath,
        ...(options.voice ? ['--voice', options.voice] : []),
        ...(options.speed ? ['--speed', String(options.speed)] : []),
      ], { stdio: 'pipe', timeout: 120_000 });

      const wavBuffer = readFileSync(outputPath);

      // Convert to Argo WAV format
      const { convertToWav } = await import('../engine.js');
      return convertToWav(wavBuffer);
    } catch (err) {
      throw new Error(
        `mlx-audio TTS failed. Ensure 'f5-tts-mlx' is installed: pip install f5-tts-mlx. ` +
        `Original error: ${(err as Error).message}`
      );
    } finally {
      try { unlinkSync(outputPath); } catch { /* ignore */ }
      try {
        const { rmdirSync } = await import('node:fs');
        rmdirSync(tmpDir);
      } catch { /* ignore */ }
    }
  }
}
