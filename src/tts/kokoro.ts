import type { TTSEngine, TTSEngineOptions } from './engine.js';

export interface KokoroEngineOptions {
  modelId?: string;
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  device?: 'wasm' | 'webgpu' | 'cpu' | null;
  onProgress?: (progress: { status: string; progress?: number; file?: string }) => void;
}

export class KokoroEngine implements TTSEngine {
  private tts: any = null;
  private modelId: string;
  private dtype: string;
  private device: 'wasm' | 'webgpu' | 'cpu' | null;
  private onProgress?: KokoroEngineOptions['onProgress'];

  constructor(options?: KokoroEngineOptions) {
    this.modelId = options?.modelId ?? 'onnx-community/Kokoro-82M-v1.0-ONNX';
    this.dtype = options?.dtype ?? 'q8';
    this.device = options?.device ?? null;
    this.onProgress = options?.onProgress;
  }

  private async getTTS(): Promise<any> {
    if (this.tts) return this.tts;
    try {
      const { KokoroTTS } = await import('kokoro-js');
      this.tts = await KokoroTTS.from_pretrained(this.modelId, {
        dtype: this.dtype as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
        device: this.device,
        progress_callback: this.onProgress ?? undefined,
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
    const samples: Float32Array = audio.data ?? audio.audio;
    if (!samples || !(samples instanceof Float32Array)) {
      throw new Error('kokoro-js returned unexpected audio format. Check kokoro-js version.');
    }
    const sampleRate: number = audio.sampling_rate;
    const { createWavBuffer } = await import('./engine.js');
    return createWavBuffer(samples, sampleRate);
  }

  /**
   * Stream audio generation sentence-by-sentence.
   * Yields WAV buffers for each sentence as they're generated.
   */
  async *stream(text: string, options: TTSEngineOptions): AsyncGenerator<{ text: string; audio: Buffer }> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getTTS();
    const { createWavBuffer } = await import('./engine.js');
    for await (const chunk of tts.stream(text, {
      voice: options.voice ?? 'af_heart',
      speed: options.speed ?? 1.0,
    })) {
      const samples: Float32Array = chunk.audio.data ?? chunk.audio.audio;
      const sampleRate: number = chunk.audio.sampling_rate;
      yield { text: chunk.text, audio: createWavBuffer(samples, sampleRate) };
    }
  }
}
