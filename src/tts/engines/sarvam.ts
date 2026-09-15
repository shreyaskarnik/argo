import type { TTSEngine, TTSEngineOptions, TTSEngineMetadata } from '../engine.js';
import { importOptional, SARVAM_DEP } from '../../optional-deps.js';

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


  describe(): TTSEngineMetadata {
    return { engine: 'sarvam', model: this.model };
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    // `SarvamAIClient` is the client class. The package has no default export
    // and its `SarvamAI` export is a namespace object, so destructuring either
    // yields undefined and fails at `new` with an unrelated-looking TypeError.
    // Loosely typed on purpose: the SDK's own typings don't describe this shape.
    const { SarvamAIClient }: any = await importOptional(
      () => import('sarvamai'),
      SARVAM_DEP,
    );

    // The package resolved but does not expose the client — a version skew or
    // a rename in a future major. Say so, rather than letting `new undefined()`
    // surface as a TypeError that looks unrelated to the SDK.
    if (typeof SarvamAIClient !== 'function') {
      throw new Error(
        "The installed 'sarvamai' package does not export SarvamAIClient. " +
        'Argo expects sarvamai >= 1.1. Upgrade with: npm i sarvamai@latest'
      );
    }

    const client = new SarvamAIClient({ apiSubscriptionKey: this.resolveApiKey() });
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
