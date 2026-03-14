import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface ElevenLabsEngineOptions {
  apiKey?: string;
  model?: string;
  stability?: number;
  similarityBoost?: number;
}

export class ElevenLabsEngine implements TTSEngine {
  private apiKey: string;
  private model: string;
  private stability: number;
  private similarityBoost: number;

  constructor(options?: ElevenLabsEngineOptions) {
    this.apiKey = options?.apiKey ?? '';
    this.model = options?.model ?? 'eleven_monolingual_v1';
    this.stability = options?.stability ?? 0.5;
    this.similarityBoost = options?.similarityBoost ?? 0.75;
  }

  private resolveApiKey(): string {
    const key = this.apiKey || process.env.ELEVENLABS_API_KEY || '';
    if (!key) {
      throw new Error(
        'ElevenLabs TTS engine requires an API key. ' +
        'Set ELEVENLABS_API_KEY environment variable or pass apiKey option.'
      );
    }
    return key;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    let ElevenLabsClient: any;
    try {
      // @ts-ignore — elevenlabs is an optional dependency
      ({ ElevenLabsClient } = await import('elevenlabs'));
    } catch {
      throw new Error(
        "ElevenLabs TTS engine requires the 'elevenlabs' package. Install it with: npm i elevenlabs"
      );
    }

    const client = new ElevenLabsClient({ apiKey: this.resolveApiKey() });
    const audioStream = await client.textToSpeech.convert(
      options.voice ?? '21m00Tcm4TlvDq8ikWAM', // Rachel default
      {
        text,
        model_id: this.model,
        voice_settings: {
          stability: this.stability,
          similarity_boost: this.similarityBoost,
        },
      },
    );

    // Collect stream into buffer
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.from(chunk));
    }
    const mp3Buffer = Buffer.concat(chunks);

    // Convert MP3 to Argo WAV format
    const { convertToWav } = await import('../engine.js');
    return convertToWav(mp3Buffer);
  }
}
