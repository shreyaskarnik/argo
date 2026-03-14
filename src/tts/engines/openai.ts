import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface OpenAIEngineOptions {
  apiKey?: string;
  model?: 'tts-1' | 'tts-1-hd';
}

export class OpenAIEngine implements TTSEngine {
  private apiKey: string;
  private model: string;

  constructor(options?: OpenAIEngineOptions) {
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = options?.model ?? 'tts-1';
    if (!this.apiKey) {
      throw new Error(
        'OpenAI TTS engine requires an API key. ' +
        'Set OPENAI_API_KEY environment variable or pass apiKey option.'
      );
    }
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

    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.audio.speech.create({
      model: this.model,
      voice: options.voice ?? 'alloy',
      input: text,
      speed: options.speed ?? 1.0,
      response_format: 'wav',
    });

    const arrayBuffer = await response.arrayBuffer();
    const wavBuffer = Buffer.from(arrayBuffer);

    // OpenAI returns 16-bit PCM WAV — convert to Float32 24kHz
    const { convertToWav } = await import('../engine.js');
    return convertToWav(wavBuffer);
  }
}
