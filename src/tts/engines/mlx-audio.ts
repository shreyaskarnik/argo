import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface MlxAudioEngineOptions {
  model?: string;
  pythonPath?: string;
}

export class MlxAudioEngine implements TTSEngine {
  private model: string;
  private pythonPath: string;

  constructor(options?: MlxAudioEngineOptions) {
    this.model = options?.model ?? 'mlx-community/Kokoro-82M-bf16';
    this.pythonPath = options?.pythonPath ?? 'python3';
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    const { execFileSync } = await import('node:child_process');
    const { readFileSync, readdirSync, rmSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'argo-mlx-'));

    try {
      const args = [
        '-m', 'mlx_audio.tts.generate',
        '--model', this.model,
        '--text', text,
        '--output_path', tmpDir,
        '--file_prefix', 'argo',
        '--audio_format', 'wav',
        '--lang_code', 'a',
      ];

      if (options.voice) {
        args.push('--voice', options.voice);
      }
      if (options.speed) {
        args.push('--speed', String(options.speed));
      }

      execFileSync(this.pythonPath, args, { stdio: 'pipe', timeout: 120_000 });

      // Find the generated WAV file
      const files = readdirSync(tmpDir).filter(f => f.endsWith('.wav'));
      if (files.length === 0) {
        throw new Error('mlx-audio did not produce a WAV file');
      }

      const wavBuffer = readFileSync(join(tmpDir, files[0]));

      // Convert to Argo WAV format (mono Float32 24kHz)
      const { convertToWav } = await import('../engine.js');
      return convertToWav(wavBuffer);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('ENOENT') || msg.includes('not found')) {
        throw new Error(
          "mlx-audio TTS requires the 'mlx-audio' Python package. " +
          'Install it with: pip install mlx-audio'
        );
      }
      throw new Error(
        `mlx-audio TTS failed for text "${text.substring(0, 80)}...". ` +
        `Original error: ${msg}`
      );
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
