import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface OpenAIEngineOptions {
  apiKey?: string;
  /** TTS model: 'tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', or any future model. */
  model?: string;
  /** System instructions for the model (supported by gpt-4o-mini-tts and newer). */
  instructions?: string;
}

export class OpenAIEngine implements TTSEngine {
  private apiKey: string;
  private model: string;
  private instructions?: string;

  constructor(options?: OpenAIEngineOptions) {
    this.apiKey = options?.apiKey ?? '';
    this.model = options?.model ?? 'tts-1';
    this.instructions = options?.instructions;
  }

  private resolveApiKey(): string {
    const key = this.apiKey || process.env.OPENAI_API_KEY || '';
    if (!key) {
      throw new Error(
        'OpenAI TTS engine requires an API key. ' +
        'Set OPENAI_API_KEY environment variable or pass apiKey option.'
      );
    }
    return key;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    let OpenAI: any;
    try {
      // @ts-ignore — openai is an optional dependency
      ({ OpenAI } = await import('openai'));
    } catch {
      throw new Error(
        "OpenAI TTS engine requires the 'openai' package. Install it with: npm i openai"
      );
    }

    const client = new OpenAI({ apiKey: this.resolveApiKey() });

    // Request raw PCM so we can build an exact WAV without ffmpeg pipe artifacts
    const params: Record<string, unknown> = {
      model: this.model,
      voice: options.voice ?? 'alloy',
      input: text,
      speed: options.speed ?? 1.0,
      response_format: 'pcm',
    };
    if (this.instructions) params.instructions = this.instructions;
    const response = await client.audio.speech.create(params as any);

    const arrayBuffer = await response.arrayBuffer();
    const pcmBuffer = Buffer.from(arrayBuffer);

    // OpenAI PCM format: 24kHz, 16-bit signed LE, mono
    // Convert 16-bit PCM samples to Float32 and build WAV directly
    const sampleRate = 24000;
    const sampleCount = pcmBuffer.length / 2;
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = pcmBuffer.readInt16LE(i * 2) / 32768;
    }

    const { createWavBuffer } = await import('../engine.js');
    return createWavBuffer(samples, sampleRate);
  }
}
