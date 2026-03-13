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
    const { KokoroTTS } = await import('kokoro-js');
    this.tts = await KokoroTTS.from_pretrained(this.modelId, {
      dtype: this.dtype as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
    });
    return this.tts;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getTTS();
    const audio = await tts.generate(text, {
      voice: options.voice ?? 'af_heart',
      speed: options.speed ?? 1.0,
    });
    // audio.data is Float32Array, audio.sampling_rate is number
    const samples = audio.data ?? audio.audio;
    const sampleRate = audio.sampling_rate ?? 24000;
    const { createWavBuffer } = await import('./engine.js');
    return createWavBuffer(samples as Float32Array, sampleRate as number);
  }
}
