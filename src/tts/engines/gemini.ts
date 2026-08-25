import type { TTSEngine, TTSEngineOptions, TTSEngineMetadata } from '../engine.js';
import { importOptional, GEMINI_DEP } from '../../optional-deps.js';

export interface GeminiEngineOptions {
  apiKey?: string;
  model?: string;
}

export class GeminiEngine implements TTSEngine {
  private apiKey: string;
  private model: string;

  constructor(options?: GeminiEngineOptions) {
    this.apiKey = options?.apiKey ?? '';
    // Must be a TTS model. `gemini-2.5-flash` and the other general models
    // answer `responseModalities: ['AUDIO']` with a 400, "This model only
    // supports text output", so a general default leaves the engine unusable
    // for anyone who does not pass one. The `native-audio` models are not
    // candidates either: they expose only `bidiGenerateContent`, the Live API
    // socket, and this engine calls `generateContent`.
    this.model = options?.model ?? 'gemini-3.1-flash-tts-preview';
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

    const { GoogleGenAI } = await importOptional(
      () => import('@google/genai'),
      GEMINI_DEP,
    );

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

    // Convert to Argo WAV format. Gemini has no speed parameter, so the rate
    // change rides along with the conversion.
    //
    // The TTS models answer with raw PCM (`audio/L16;codec=pcm;rate=24000`),
    // which carries no header for ffmpeg to recognise, so the format is read
    // off the media type and passed through. Reading the rate rather than
    // assuming 24kHz keeps this correct if a model ever returns another one:
    // guessing wrong does not fail, it pitches and stretches the voice.
    const { convertToWav, parseRawAudioMime } = await import('../engine.js');
    const inputFormat = parseRawAudioMime(audioPart.inlineData.mimeType);
    return convertToWav(audioBuffer, options.speed ?? 1, inputFormat);
  }
}
