import type { TTSEngine, TTSEngineOptions, TTSEngineMetadata } from '../engine.js';

export interface GeminiEngineOptions {
  apiKey?: string;
  model?: string;
}

export class GeminiEngine implements TTSEngine {
  private apiKey: string;
  private model: string;

  constructor(options?: GeminiEngineOptions) {
    this.apiKey = options?.apiKey ?? '';
    this.model = options?.model ?? 'gemini-2.5-flash';
  }

  private resolveApiKey(): string {
    const key = this.apiKey || process.env.GEMINI_API_KEY || '';
    if (!key) {
      throw new Error(
        'Gemini TTS engine requires an API key. ' +
        'Set GEMINI_API_KEY environment variable or pass apiKey option.'
      );
    }
    return key;
  }


  describe(): TTSEngineMetadata {
    return { engine: 'gemini', model: this.model };
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    let GoogleGenAI: any;
    try {
      // @ts-ignore — @google/genai is an optional dependency
      ({ GoogleGenAI } = await import('@google/genai'));
    } catch {
      throw new Error(
        "Gemini TTS engine requires the '@google/genai' package. Install it with: npm i @google/genai"
      );
    }

    const ai = new GoogleGenAI({ apiKey: this.resolveApiKey() });
    const response = await ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: `Please read the following text aloud: ${text}` }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: options.voice ?? 'Kore',
            },
          },
        },
      },
    });

    // Gemini returns inline audio data as base64
    const audioPart = response.candidates?.[0]?.content?.parts?.find(
      (p: any) => p.inlineData?.mimeType?.startsWith('audio/'),
    );

    if (!audioPart?.inlineData?.data) {
      throw new Error('Gemini did not return audio data. Check model and voice configuration.');
    }

    const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');

    // Convert to Argo WAV format
    const { convertToWav } = await import('../engine.js');
    return convertToWav(audioBuffer);
  }
}
