import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface SarvamEngineOptions {
  apiKey?: string;
  model?: string;
}

export class SarvamEngine implements TTSEngine {
  private apiKey: string;
  private model: string;

  constructor(options?: SarvamEngineOptions) {
    this.apiKey = options?.apiKey ?? '';
    this.model = options?.model ?? 'bulbul:v2';
  }

  private resolveApiKey(): string {
    const key = this.apiKey || process.env.SARVAM_API_KEY || '';
    if (!key) {
      throw new Error(
        'Sarvam TTS engine requires an API key. ' +
        'Set SARVAM_API_KEY environment variable or pass apiKey option.'
      );
    }
    return key;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    let SarvamAI: any;
    try {
      // @ts-ignore — sarvamai is an optional dependency
      ({ default: SarvamAI } = await import('sarvamai'));
    } catch {
      throw new Error(
        "Sarvam TTS engine requires the 'sarvamai' package. Install it with: npm i sarvamai"
      );
    }

    const client = new SarvamAI({ apiSubscriptionKey: this.resolveApiKey() });
    const response = await client.textToSpeech.convert({
      inputs: [text],
      target_language_code: options.lang ?? 'hi-IN',
      speaker: options.voice ?? 'meera',
      model: this.model,
      pitch: 0,
      pace: options.speed ?? 1.0,
      loudness: 1.5,
      enable_preprocessing: true,
    });

    if (!response.audios?.[0]) {
      throw new Error('Sarvam TTS returned no audio data');
    }

    // Sarvam returns base64-encoded WAV
    const audioBuffer = Buffer.from(response.audios[0], 'base64');

    // Convert to Argo WAV format (mono Float32 24kHz)
    const { convertToWav } = await import('../engine.js');
    return convertToWav(audioBuffer);
  }
}
