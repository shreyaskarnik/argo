/**
 * Whisper STT for word-level narration timestamps.
 *
 * Argo's TTS engines render audio; downstream consumers (subtitles,
 * compositions, preview UI) want to know which word is spoken at video
 * time T. Phoneme-level estimates from the upstream engine drift, so
 * the source of truth is the rendered audio itself — transcribe it
 * back with Whisper and read the per-word timestamps.
 *
 * Uses `@huggingface/transformers` (already in tree for Kokoro). Whisper
 * runs locally via ONNX, no cloud round-trip. The pipeline instance is
 * cached per process so repeated calls reuse the loaded model.
 */
import { pipeline } from '@huggingface/transformers';
import { spawnSync } from 'node:child_process';

export interface WordTiming {
  /** The word as Whisper transcribed it. Whisper emits leading spaces on
   *  most tokens; we strip those so consumers can join with their own
   *  separator. Trailing punctuation is preserved. */
  text: string;
  /** Start time relative to the input audio, in seconds. */
  start: number;
  /** End time relative to the input audio, in seconds. */
  end: number;
}

export interface TranscribeOptions {
  /** HuggingFace Hub model id. Default `Xenova/whisper-base.en` —
   *  ~140MB, ~5× realtime on Apple Silicon CPU, strong word-level accuracy
   *  on clean TTS audio. Use `whisper-tiny.en` for faster cold start at
   *  some accuracy cost, or `whisper-small.en` for tighter timestamps on
   *  difficult audio at half the throughput. */
  model?: string;
  /** Source language hint. Whisper auto-detects if omitted. Pass for
   *  multi-lingual TTS (e.g., Sarvam Indic clips). */
  language?: string;
}

export const DEFAULT_WHISPER_MODEL = 'Xenova/whisper-base.en';

/** Whisper's required audio sample rate. */
const WHISPER_SR = 16_000;

type Transcriber = (
  audio: Float32Array | string | URL,
  opts: { return_timestamps: 'word'; language?: string },
) => Promise<{ text: string; chunks?: Array<{ text: string; timestamp: [number, number] }> }>;

let cached: { model: string; transcriber: Transcriber } | null = null;

/** Lazy-load and cache one Whisper pipeline per process per model id.
 *  Switching model busts the cache (rare). */
async function getTranscriber(model: string): Promise<Transcriber> {
  if (cached?.model === model) return cached.transcriber;
  const transcriber = (await pipeline('automatic-speech-recognition', model)) as unknown as Transcriber;
  cached = { model, transcriber };
  return transcriber;
}

/** Transcribe a WAV file into word-level timestamps.
 *
 *  Whisper expects 16kHz mono Float32. Argo's TTS writes 24kHz mono Float32,
 *  and `transformers.js` in Node lacks `AudioContext` — so we shell out to
 *  ffmpeg (already a hard dep for export) to resample to 16kHz Float32 LE
 *  on stdout, then hand the raw samples to the pipeline. ~50ms overhead
 *  per clip; the model load (cold start) is the dominant cost.
 */
export async function transcribeWav(
  wavPath: string,
  opts: TranscribeOptions = {},
): Promise<WordTiming[]> {
  const model = opts.model ?? DEFAULT_WHISPER_MODEL;
  const transcriber = await getTranscriber(model);

  const audio = decodeTo16kFloat32(wavPath);

  const result = await transcriber(audio, {
    return_timestamps: 'word',
    ...(opts.language ? { language: opts.language } : {}),
  });

  return (result.chunks ?? [])
    .map((c): WordTiming => ({
      text: c.text.trimStart(),
      start: c.timestamp[0],
      end: c.timestamp[1] ?? c.timestamp[0],
    }))
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
}

/** Pipe a WAV through ffmpeg to produce 16kHz mono Float32 LE raw samples,
 *  then return as a Float32Array sized to the byte length. ffmpeg's `f32le`
 *  format is already what Whisper consumes internally — no further work. */
function decodeTo16kFloat32(wavPath: string): Float32Array {
  const result = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel', 'error',
      '-i', wavPath,
      '-ac', '1',
      '-ar', String(WHISPER_SR),
      '-f', 'f32le',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `ffmpeg failed to decode ${wavPath} (exit ${result.status}): ${result.stderr.toString().slice(0, 300)}`,
    );
  }
  const buf = result.stdout;
  // Float32 = 4 bytes per sample. ffmpeg always writes LE on this path.
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** Pre-warm the Whisper pipeline so the first `transcribeWav()` call
 *  pays the model-load cost up-front (the pipeline can then reuse the
 *  loaded model for all subsequent clips). Safe to call multiple times. */
export async function warmTranscriber(model = DEFAULT_WHISPER_MODEL): Promise<void> {
  await getTranscriber(model);
}
