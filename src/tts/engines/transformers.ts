import type { TTSEngine, TTSEngineOptions, TTSEngineMetadata } from '../engine.js';
import { splitTextForTTS, concatSamples } from '../engine.js';

export interface TransformersEngineOptions {
  /** Model ID from Hugging Face Hub. Default: 'onnx-community/Supertonic-TTS-ONNX' */
  model?: string;
  /** Quantization dtype. Default: 'q8' */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
  /** Device for inference. Default: null (auto-detect) */
  device?: 'wasm' | 'webgpu' | 'cpu' | null;
  /** URL or path to speaker embedding .bin file for multi-speaker models. */
  speakerEmbeddings?: string;
  /** Number of inference steps (higher = better quality). Default: 10 */
  numInferenceSteps?: number;
}

export class TransformersEngine implements TTSEngine {
  private pipeline: any = null;
  private initPromise: Promise<any> | null = null;
  private model: string;
  private dtype: string;
  private device: string | null;
  private speakerEmbeddings?: string;
  private numInferenceSteps: number;

  constructor(options?: TransformersEngineOptions) {
    this.model = options?.model ?? 'onnx-community/Supertonic-TTS-ONNX';
    this.dtype = options?.dtype ?? 'q8';
    this.device = options?.device ?? null;
    this.speakerEmbeddings = options?.speakerEmbeddings;
    this.numInferenceSteps = options?.numInferenceSteps ?? 10;
  }

  describe(): TTSEngineMetadata {
    return { engine: 'transformers', model: this.model, dtype: this.dtype };
  }

  private async getPipeline(): Promise<any> {
    if (this.pipeline) return this.pipeline;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        let pipeline: any;
        try {
          ({ pipeline } = await import('@huggingface/transformers'));
        } catch {
          throw new Error(
            "Transformers TTS engine requires the '@huggingface/transformers' package. " +
            'Install it with: npm i @huggingface/transformers',
          );
        }
        try {
          this.pipeline = await pipeline('text-to-speech', this.model, {
            dtype: this.dtype,
            device: this.device,
          });
        } catch (err) {
          this.initPromise = null;
          throw new Error(
            `Failed to initialize Transformers TTS pipeline (model: ${this.model}, dtype: ${this.dtype}). ` +
            `This may require an internet connection for first-time model download. ` +
            `Original error: ${(err as Error).message}`,
          );
        }
        return this.pipeline;
      })();
    }
    return this.initPromise;
  }

  async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
    if (!text?.trim()) throw new Error('TTS text must not be empty');
    const tts = await this.getPipeline();

    const { createWavBuffer } = await import('../engine.js');
    const TARGET_RATE = 24000;

    // Build base generation options
    const speaker = options.voice ?? this.speakerEmbeddings;
    const baseOpts: Record<string, unknown> = {
      speed: options.speed ?? 1.0,
      num_inference_steps: this.numInferenceSteps,
    };
    if (speaker) baseOpts.speaker_embeddings = speaker;

    const chunks = splitTextForTTS(text);
    const audioChunks: Float32Array[] = [];
    let sampleRate = TARGET_RATE;

    for (const chunk of chunks) {
      let audio: any;
      try {
        audio = await tts(chunk, baseOpts);
      } catch (err) {
        throw new Error(
          `Transformers TTS failed to generate audio for text "${chunk.substring(0, 80)}..." ` +
          `(model: ${this.model}). Original error: ${(err as Error).message}`,
        );
      }

      const samples: Float32Array = audio.audio ?? audio.data;
      if (!samples || !(samples instanceof Float32Array)) {
        throw new Error(
          `Transformers TTS returned unexpected audio format from model ${this.model}. ` +
          'Expected Float32Array in audio.audio or audio.data.',
        );
      }
      sampleRate = audio.sampling_rate ?? TARGET_RATE;
      audioChunks.push(samples);
    }

    // Concatenate chunks with silence gaps
    let combined = concatSamples(audioChunks, sampleRate);

    // Resample to 24kHz if needed (pipeline alignment assumes 24kHz)
    if (sampleRate !== TARGET_RATE) {
      const ratio = sampleRate / TARGET_RATE;
      const outLen = Math.round(combined.length / ratio);
      const resampled = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio;
        const lo = Math.floor(srcIdx);
        const hi = Math.min(lo + 1, combined.length - 1);
        const frac = srcIdx - lo;
        resampled[i] = combined[lo] * (1 - frac) + combined[hi] * frac;
      }
      combined = resampled;
      sampleRate = TARGET_RATE;
    }

    return createWavBuffer(combined, sampleRate);
  }
}
