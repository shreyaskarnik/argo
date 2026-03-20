/**
 * AI-generated background music via MusicGen (Transformers.js).
 * Uses Xenova/musicgen-small (~1.8GB ONNX model, downloaded on first run).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWavBuffer } from '../tts/engine.js';

export interface MusicGenOptions {
  /** Text prompt describing the desired music (e.g., "lofi chill ambient with soft piano"). */
  prompt: string;
  /** Duration in seconds for generated music. Default: 30. */
  durationSec?: number;
  /** Classifier-free guidance scale. Higher = more prompt-adherent. Default: 3. */
  guidanceScale?: number;
  /** Sampling temperature. Default: 1.0. */
  temperature?: number;
}

/** MusicGen outputs audio at 32kHz sample rate. */
const MUSICGEN_SAMPLE_RATE = 32_000;
/** MusicGen uses ~50 tokens per second of audio. */
const TOKENS_PER_SECOND = 50;
const DEFAULT_DURATION_SEC = 30;
const DEFAULT_GUIDANCE_SCALE = 3;
const DEFAULT_TEMPERATURE = 1.0;
const MODEL_ID = 'Xenova/musicgen-small';

/**
 * Compute a content-addressed cache key from all generation parameters.
 */
export function computeCacheKey(options: MusicGenOptions): string {
  const { prompt, durationSec, guidanceScale, temperature } = options;
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        prompt,
        durationSec: durationSec ?? DEFAULT_DURATION_SEC,
        guidanceScale: guidanceScale ?? DEFAULT_GUIDANCE_SCALE,
        temperature: temperature ?? DEFAULT_TEMPERATURE,
      }),
    )
    .digest('hex');
}

/**
 * Returns the cache file path for a given demo + options.
 */
export function getCachePath(argoDir: string, options: MusicGenOptions): string {
  const hash = computeCacheKey(options);
  return path.join(argoDir, 'music', `${hash}.wav`);
}

/**
 * Check if a cached music file exists for the given options.
 */
export function isCached(argoDir: string, options: MusicGenOptions): boolean {
  return fs.existsSync(getCachePath(argoDir, options));
}

/**
 * Generate background music from a text prompt using MusicGen.
 *
 * The model (~1.8GB) is downloaded on first run. Generation takes ~30-60s
 * depending on duration and hardware.
 *
 * Returns a WAV buffer (Float32, mono, 32kHz — ffmpeg handles resampling during export).
 */
export async function generateMusic(options: MusicGenOptions): Promise<Buffer> {
  const durationSec = options.durationSec ?? DEFAULT_DURATION_SEC;
  const guidanceScale = options.guidanceScale ?? DEFAULT_GUIDANCE_SCALE;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const maxNewTokens = Math.ceil(durationSec * TOKENS_PER_SECOND);

  // Lazy-load transformers (same pattern as TTS Transformers engine)
  let AutoTokenizer: any;
  let MusicgenForConditionalGeneration: any;
  try {
    ({ AutoTokenizer, MusicgenForConditionalGeneration } = await import(
      '@huggingface/transformers'
    ));
  } catch {
    throw new Error(
      "MusicGen requires the '@huggingface/transformers' package. " +
        'Install it with: npm i @huggingface/transformers',
    );
  }

  console.log(`  \u25b8 Loading model: ${MODEL_ID}`);
  console.log(
    '  \u25b8 First run downloads ~1.8GB — subsequent runs use the cache',
  );

  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  const model = await MusicgenForConditionalGeneration.from_pretrained(
    MODEL_ID,
    {
      dtype: {
        text_encoder: 'q8',
        decoder_model_merged: 'q8',
        encodec_decode: 'fp32',
      },
    },
  );

  console.log(`  \u25b8 Generating ${durationSec}s of music...`);

  const inputs = tokenizer(options.prompt);
  const audioValues = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    do_sample: true,
    guidance_scale: guidanceScale,
    temperature,
  });

  // audioValues is a Tensor — extract the Float32Array data
  const rawSamples: Float32Array =
    audioValues.data instanceof Float32Array
      ? audioValues.data
      : new Float32Array(audioValues.data);

  // Save as WAV at the native 32kHz rate — ffmpeg resamples during export
  return createWavBuffer(rawSamples, MUSICGEN_SAMPLE_RATE);
}

/**
 * Generate music with caching. Returns the path to the WAV file.
 *
 * If a cached file exists for the same prompt + parameters, skips generation.
 * On model load or generation failure, warns and returns null (best-effort).
 */
export async function generateMusicCached(
  argoDir: string,
  options: MusicGenOptions,
): Promise<string | null> {
  const cachePath = getCachePath(argoDir, options);
  const hash = computeCacheKey(options);

  if (fs.existsSync(cachePath)) {
    console.log(`  \u25b8 Cached: ${path.relative('.', cachePath)}`);
    return cachePath;
  }

  // Ensure cache directory exists
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  try {
    const wavBuffer = await generateMusic(options);
    fs.writeFileSync(cachePath, wavBuffer);
    console.log(`  \u25b8 Saved: ${path.relative('.', cachePath)}`);
    return cachePath;
  } catch (err) {
    console.warn(
      `\u26a0\ufe0f  Music generation failed (continuing without background music): ${(err as Error).message}`,
    );
    return null;
  }
}
