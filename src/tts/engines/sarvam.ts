import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface SarvamEngineOptions {
  apiKey?: string;
  model?: string;
}

export class SarvamEngine implements TTSEngine {
  private apiKey: string;
  private model: string;

  constructor(options?: SarvamEngineOptions) {
    this.apiKey = options?.apiKey ?? process.env.SARVAM_API_KEY ?? '';
    this.model = options?.model ?? 'bulbul:v2';
    if (!this.apiKey) {
      throw new Error(
        'Sarvam TTS engine requires an API key. ' +
        'Set SARVAM_API_KEY environment variable or pass apiKey option.'
      );
    }
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    const response = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-Subscription-Key': this.apiKey,
      },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: options.lang ?? 'hi-IN',
        speaker: options.voice ?? 'meera',
        model: this.model,
        pitch: 0,
        pace: options.speed ?? 1.0,
        loudness: 1.5,
        enable_preprocessing: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sarvam TTS API error ${response.status}: ${body}`);
    }

    const json = await response.json() as { audios?: string[] };
    if (!json.audios?.[0]) {
      throw new Error('Sarvam TTS returned no audio data');
    }

    // Sarvam returns base64-encoded WAV
    const audioBuffer = Buffer.from(json.audios[0], 'base64');

    // Convert to Argo WAV format (mono Float32 24kHz)
    const { convertToWav } = await import('../engine.js');
    return convertToWav(audioBuffer);
  }
}
