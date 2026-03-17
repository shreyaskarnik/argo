import type { TTSEngine, TTSEngineOptions, TTSEngineMetadata } from '../engine.js';
import { splitTextForTTS, concatSamples } from '../engine.js';

export interface KokoroEngineOptions {
  modelId?: string;
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  device?: 'wasm' | 'webgpu' | 'cpu' | null;
  onProgress?: (progress: { status: string; progress?: number; file?: string }) => void;
}

export class KokoroEngine implements TTSEngine {
  private tts: any = null;
  private initPromise: Promise<any> | null = null;
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

  describe(): TTSEngineMetadata {
    return { engine: 'kokoro', model: this.modelId, dtype: this.dtype };
  }

  private async getTTS(): Promise<any> {
    if (this.tts) return this.tts;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const { KokoroTTS } = await import('kokoro-js');
          this.tts = await KokoroTTS.from_pretrained(this.modelId, {
            dtype: this.dtype as 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16',
            device: this.device,
            progress_callback: this.onProgress ?? undefined,
          });
        } catch (err) {
          this.initPromise = null;
          throw new Error(
            `Failed to initialize Kokoro TTS (model: ${this.modelId}, dtype: ${this.dtype}). ` +
            `This may require an internet connection for first-time model download. ` +
            `Original error: ${(err as Error).message}`
          );
        }
        return this.tts;
      })();
    }
    return this.initPromise;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getTTS();
    const { createWavBuffer } = await import('../engine.js');

    const chunks = splitTextForTTS(text);
    const audioChunks: Float32Array[] = [];
    let sampleRate = 24000;

    for (const chunk of chunks) {
      let audio;
      try {
        audio = await tts.generate(chunk, {
          voice: options.voice ?? 'af_heart',
          speed: options.speed ?? 1.0,
        });
      } catch (err) {
        throw new Error(
          `Kokoro TTS failed to generate audio for text "${chunk.substring(0, 80)}..." ` +
          `(voice: ${options.voice ?? 'af_heart'}). Original error: ${(err as Error).message}`
        );
      }
      const samples: Float32Array = audio.data ?? audio.audio;
      if (!samples || !(samples instanceof Float32Array)) {
        throw new Error('kokoro-js returned unexpected audio format. Check kokoro-js version.');
      }
      sampleRate = audio.sampling_rate;
      audioChunks.push(samples);
    }

    return createWavBuffer(concatSamples(audioChunks, sampleRate), sampleRate);
  }

  async *stream(text: string, options: TTSEngineOptions): AsyncGenerator<{ text: string; audio: Buffer }> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getTTS();
    const { createWavBuffer } = await import('../engine.js');
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
