import type { TTSEngine, TTSEngineOptions } from './engine.js';
import { createWavBuffer } from './engine.js';

export class KokoroEngine implements TTSEngine {
  private pipeline: any = null;

  private async getPipeline(): Promise<any> {
    if (this.pipeline) return this.pipeline;
    const { pipeline } = await import('@huggingface/transformers');
    this.pipeline = await pipeline('text-to-speech', 'onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32' });
    return this.pipeline;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getPipeline();
    const result = await tts(text, {
      voice: options.voice ?? 'af_heart',
      speed: options.speed ?? 1.0,
      ...(options.lang ? { language: options.lang } : {}),
    });
    return createWavBuffer(result.audio as Float32Array, result.sampling_rate as number);
  }
}
