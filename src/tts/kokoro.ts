import type { TTSEngine, TTSEngineOptions } from './engine.js';

export class KokoroEngine implements TTSEngine {
  private tts: any = null;
  private modelId: string;
  private dtype: string;

  constructor(options?: { modelId?: string; dtype?: string }) {
    this.modelId = options?.modelId ?? 'onnx-community/Kokoro-82M-ONNX';
    this.dtype = options?.dtype ?? 'fp32';
  }

  private async getTTS(): Promise<any> {
    if (this.tts) return this.tts;
    try {
      const { KokoroTTS } = await import('kokoro-js');
      this.tts = await KokoroTTS.from_pretrained(this.modelId, {
        dtype: this.dtype as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
      });
    } catch (err) {
      throw new Error(
        `Failed to initialize Kokoro TTS (model: ${this.modelId}, dtype: ${this.dtype}). ` +
        `This may require an internet connection for first-time model download. ` +
        `Original error: ${(err as Error).message}`
      );
    }
    return this.tts;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getTTS();
    const audio = await tts.generate(text, {
      voice: options.voice ?? 'af_heart',
      speed: options.speed ?? 1.0,
    });
    const samples = audio.data ?? audio.audio;
    if (!samples || !(samples instanceof Float32Array)) {
      throw new Error(
        'kokoro-js returned unexpected audio format: neither .data nor .audio contains Float32Array samples. ' +
        'Check that your kokoro-js version is compatible.'
      );
    }
    const sampleRate = audio.sampling_rate;
    if (typeof sampleRate !== 'number' || sampleRate <= 0) {
      throw new Error(`kokoro-js returned invalid sample rate: ${sampleRate}.`);
    }
    const { createWavBuffer } = await import('./engine.js');
    return createWavBuffer(samples, sampleRate);
  }
}
