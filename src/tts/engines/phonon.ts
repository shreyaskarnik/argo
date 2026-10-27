import type { TTSEngine, TTSEngineOptions, TTSEngineMetadata } from '../engine.js';

/**
 * Phonon (Gradium) via its OpenAI-compatible server, `ptts-openai-server`.
 *
 * Phonon is an on-device TTS model family (phonon-31m-en, phonon-40m-*) with a
 * Rust runtime: https://github.com/gradium-ai/xn-ptts. The `phonon-tts` npm
 * package is a WebAssembly build that needs a browser (Web Worker + Cache
 * API) and does not run in Node, so Argo talks to the HTTP server instead:
 *
 *   docker run -p 127.0.0.1:8880:8880 -e PTTS_LANG=en \
 *     ghcr.io/gradium-ai/ptts-openai-server:0.5.0
 *
 * Server contract (ptts-openai-server/README.md):
 * - `POST /v1/audio/speech` with `input` (<= 4096 chars), `voice`,
 *   `response_format`. `model` and `instructions` are accepted and ignored;
 *   the checkpoint and language are server-side (`PTTS_MODEL`, `PTTS_LANG`).
 * - `pcm` is headerless signed 16-bit little-endian, mono, 24 kHz — exactly
 *   Argo's rate, so no resampling or ffmpeg pass is needed at 1x.
 * - `speed` other than 1.0 is rejected with 400 (or silently ignored under
 *   `--ignore-speed`). Argo never sends it and applies speed with ffmpeg
 *   `atempo` instead, like the ElevenLabs and Gemini adapters.
 * - No authentication: the `Authorization` header is ignored.
 */
export interface PhononEngineOptions {
  /** Server URL. Default: `PHONON_TTS_URL` env var, else http://localhost:8880 */
  baseUrl?: string;
  /**
   * Voice used when a scene names none, or names a Kokoro-style voice
   * (`af_heart`, Argo's global default) that Phonon does not have.
   * Default: `default` (the checkpoint's default voice).
   */
  voice?: string;
  /** Request timeout in ms. Default: 180000. */
  timeoutMs?: number;
}

/** Phonon's server rejects input past this many characters. */
const MAX_INPUT_CHARS = 4096;
const SAMPLE_RATE = 24000;

/** Kokoro voice names (`af_heart`, `am_michael`, `bf_emma`...). Phonon voice
 *  names are capitalized (`Zoey`, `Easton`), so this cannot hide a real one. */
const KOKORO_VOICE_RE = /^[a-z]{2}_[a-z]+$/;

export class PhononEngine implements TTSEngine {
  private baseUrl: string;
  private defaultVoice: string;
  private timeoutMs: number;
  private warnedVoices = new Set<string>();

  constructor(options?: PhononEngineOptions) {
    const base = options?.baseUrl ?? process.env.PHONON_TTS_URL ?? 'http://localhost:8880';
    this.baseUrl = base.replace(/\/+$/, '');
    this.defaultVoice = options?.voice ?? 'default';
    this.timeoutMs = options?.timeoutMs ?? 180_000;
  }

  describe(): TTSEngineMetadata {
    return { engine: 'phonon', baseUrl: this.baseUrl, voice: this.defaultVoice };
  }

  private resolveVoice(voice: string | undefined): string {
    if (!voice) return this.defaultVoice;
    if (KOKORO_VOICE_RE.test(voice)) {
      if (!this.warnedVoices.has(voice)) {
        this.warnedVoices.add(voice);
        console.warn(
          `phonon: "${voice}" is a Kokoro voice name; using Phonon voice "${this.defaultVoice}". ` +
          'Set tts.defaultVoice or a per-scene voice to a Phonon voice (GET /v1/audio/voices lists them).',
        );
      }
      return this.defaultVoice;
    }
    return voice;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');

    const voice = this.resolveVoice(options.voice);

    let chunks: string[] = [text];
    if (text.length > MAX_INPUT_CHARS) {
      const { splitTextForTTS } = await import('../engine.js');
      chunks = splitTextForTTS(text, { maxChars: 4000 });
    }

    const pcmParts: Buffer[] = [];
    for (const chunk of chunks) {
      pcmParts.push(await this.requestPcm(chunk, voice));
    }
    const pcm = pcmParts.length === 1 ? pcmParts[0] : Buffer.concat(pcmParts);

    const speed = options.speed ?? 1;
    const engine = await import('../engine.js');
    if (speed !== 1) {
      return engine.convertToWav(pcm, speed, {
        format: 's16le',
        sampleRate: SAMPLE_RATE,
        channels: 1,
      });
    }

    // 16-bit signed LE → Float32, built directly to avoid ffmpeg pipe artifacts.
    const sampleCount = Math.floor(pcm.length / 2);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = pcm.readInt16LE(i * 2) / 32768;
    }
    return engine.createWavBuffer(samples, SAMPLE_RATE);
  }

  private async requestPcm(input: string, voice: string): Promise<Buffer> {
    const url = `${this.baseUrl}/v1/audio/speech`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input, voice, response_format: 'pcm' }),
          signal: controller.signal,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not reach Phonon server at ${url}: ${reason}. ` +
          'Start it with: docker run -p 127.0.0.1:8880:8880 -e PTTS_LANG=en ' +
          'ghcr.io/gradium-ai/ptts-openai-server:0.5.0',
          { cause: err },
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const hint = response.status === 400 && /voice/i.test(body)
          ? ` (voice "${voice}"; GET ${this.baseUrl}/v1/audio/voices lists valid names)`
          : '';
        throw new Error(`Phonon server error ${response.status} at ${url}: ${body}${hint}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 2) {
        throw new Error(`Phonon server at ${url} returned no audio`);
      }
      return buffer;
    } finally {
      clearTimeout(timeout);
    }
  }
}
