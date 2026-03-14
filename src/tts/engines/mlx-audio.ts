import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface MlxAudioEngineOptions {
  /** mlx-audio server URL. Default: http://localhost:8000 */
  baseUrl?: string;
  /** Model ID passed to the server. Default: mlx-community/Spark-TTS-0.5B-bf16 */
  model?: string;
}

export class MlxAudioEngine implements TTSEngine {
  private baseUrl: string;
  private model: string;

  constructor(options?: MlxAudioEngineOptions) {
    this.baseUrl = options?.baseUrl ?? 'http://localhost:8000';
    this.model = options?.model ?? 'mlx-community/Spark-TTS-0.5B-bf16';
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);

    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: text,
          voice: options.voice ?? 'af_heart',
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `mlx-audio server error ${response.status}: ${body}. ` +
        `Ensure the server is running: python3 -m mlx_audio.server --model ${this.model}`
      );
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    // Convert to Argo WAV format (mono Float32 24kHz)
    const { convertToWav } = await import('../engine.js');
    return convertToWav(audioBuffer);
  }
}
