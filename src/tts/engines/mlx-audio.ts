import type { TTSEngine, TTSEngineOptions } from '../engine.js';

export interface MlxAudioEngineOptions {
  /** mlx-audio server URL. Default: http://localhost:8000 */
  baseUrl?: string;
  /** Model ID passed to the server. Default: mlx-community/Spark-TTS-0.5B-bf16 */
  model?: string;
  /** Path to a reference audio WAV file for voice cloning (requires a cloning-capable model). */
  refAudio?: string;
  /** Transcript of the reference audio (required when refAudio is set). */
  refText?: string;
  /** Instruction text for models that support instruct mode (e.g. emotion/style control). */
  instruct?: string;
  /** Gender hint. Default: "male". */
  gender?: string;
  /** Pitch multiplier. Default: 1.0. */
  pitch?: number;
  /** Language code. Default: "a". */
  langCode?: string;
  /** Sampling temperature. Default: 0.7. */
  temperature?: number;
  /** Top-p sampling. Default: 0.95. */
  topP?: number;
  /** Top-k sampling. Default: 40. */
  topK?: number;
  /** Repetition penalty. Default: 1.0. */
  repetitionPenalty?: number;
  /** Response audio format. Default: "mp3". */
  responseFormat?: string;
  /** Enable streaming response. Default: false. */
  stream?: boolean;
  /** Streaming chunk interval in seconds. Default: 2.0. */
  streamingInterval?: number;
  /** Max generation tokens. Default: 1200. */
  maxTokens?: number;
  /** Enable verbose server logging. Default: false. */
  verbose?: boolean;
}

export class MlxAudioEngine implements TTSEngine {
  private baseUrl: string;
  private model: string;
  private serverOptions: Record<string, unknown>;

  constructor(options?: MlxAudioEngineOptions) {
    this.baseUrl = options?.baseUrl ?? 'http://localhost:8000';
    this.model = options?.model ?? 'mlx-community/Spark-TTS-0.5B-bf16';

    if (options?.refAudio && !options.refText) {
      throw new Error('refText is required when refAudio is set for voice cloning');
    }

    // Build the optional server params, converting camelCase to snake_case keys
    this.serverOptions = {};
    if (options?.refAudio != null) this.serverOptions.ref_audio = options.refAudio;
    if (options?.refText != null) this.serverOptions.ref_text = options.refText;
    if (options?.instruct != null) this.serverOptions.instruct = options.instruct;
    if (options?.gender != null) this.serverOptions.gender = options.gender;
    if (options?.pitch != null) this.serverOptions.pitch = options.pitch;
    if (options?.langCode != null) this.serverOptions.lang_code = options.langCode;
    if (options?.temperature != null) this.serverOptions.temperature = options.temperature;
    if (options?.topP != null) this.serverOptions.top_p = options.topP;
    if (options?.topK != null) this.serverOptions.top_k = options.topK;
    if (options?.repetitionPenalty != null) this.serverOptions.repetition_penalty = options.repetitionPenalty;
    if (options?.responseFormat != null) this.serverOptions.response_format = options.responseFormat;
    if (options?.stream != null) this.serverOptions.stream = options.stream;
    if (options?.streamingInterval != null) this.serverOptions.streaming_interval = options.streamingInterval;
    if (options?.maxTokens != null) this.serverOptions.max_tokens = options.maxTokens;
    if (options?.verbose != null) this.serverOptions.verbose = options.verbose;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);

    const payload: Record<string, unknown> = {
      model: this.model,
      input: text,
      voice: options.voice ?? 'af_heart',
      ...this.serverOptions,
    };

    // TTSEngineOptions.speed maps to the server's speed field
    if (options.speed != null) {
      payload.speed = options.speed;
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
