/**
 * TTS Engine interface and WAV utilities for Argo.
 */

import * as childProcess from 'node:child_process';

export interface TTSEngineOptions {
  voice?: string;
  speed?: number;
  lang?: string;
}

export interface TTSEngineMetadata {
  engine: string;
  model?: string;
  instructions?: string;
  [key: string]: unknown;
}

export interface TTSEngine {
  generate(text: string, options: TTSEngineOptions): Promise<Buffer>;
  /** Return metadata about this engine for pipeline provenance tracking. */
  describe?(): TTSEngineMetadata;
}

/**
 * Split long text into chunks at sentence boundaries for better TTS quality.
 * Each chunk is between minChars and maxChars, split at sentence-ending punctuation.
 */
export function splitTextForTTS(
  text: string,
  { minChars = 80, maxChars = 500 }: { minChars?: number; maxChars?: number } = {},
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  // Split on sentence-ending punctuation followed by space
  const sentences = trimmed.match(/[^.!?]+[.!?]+[\s]*/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;

    if (current && (current.length + s.length + 1) > maxChars) {
      chunks.push(current.trim());
      current = s;
    } else {
      current = current ? current + ' ' + s : s;
    }

    // Flush if we've reached a good size
    if (current.length >= minChars && current.match(/[.!?]\s*$/)) {
      chunks.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [trimmed];
}

/**
 * Concatenate Float32Array audio chunks with optional silence gap between them.
 */
export function concatSamples(chunks: Float32Array[], sampleRate: number, gapMs = 300): Float32Array {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  const gapSamples = Math.round((gapMs / 1000) * sampleRate);
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0) + gapSamples * (chunks.length - 1);
  const result = new Float32Array(totalLen);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    result.set(chunks[i], offset);
    offset += chunks[i].length;
    if (i < chunks.length - 1) offset += gapSamples; // silence gap
  }
  return result;
}

/**
 * Creates a valid WAV file buffer from Float32Array samples.
 * Format: mono, 32-bit IEEE float, given sample rate.
 */
export function createWavBuffer(samples: Float32Array, sampleRate = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 32;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const headerSize = 44;

  const buf = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(headerSize + dataSize - 8, 4);
  buf.write('WAVE', 8, 'ascii');

  // fmt chunk
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);          // fmt chunk size
  buf.writeUInt16LE(3, 20);           // audioFormat = 3 (IEEE float)
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  // sample data
  for (let i = 0; i < samples.length; i++) {
    buf.writeFloatLE(samples[i], headerSize + i * bytesPerSample);
  }

  return buf;
}

export interface WavHeader {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  audioFormat: number;
  dataSize: number;
  dataOffset: number;
  durationMs: number;
}

/**
 * Parses a WAV file header. Searches for the 'data' chunk rather than
 * assuming a fixed offset.
 */
export function parseWavHeader(wav: Buffer): WavHeader {
  if (wav.length < 44) {
    throw new Error('Buffer too small to be a valid WAV file');
  }
  if (wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a valid WAV file: missing RIFF header');
  }
  if (wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file: missing WAVE marker');
  }

  // Validate and parse fmt chunk (expected at byte 12)
  if (wav.toString('ascii', 12, 16) !== 'fmt ') {
    throw new Error('Not a valid WAV file: fmt chunk not found at expected offset');
  }
  const audioFormat = wav.readUInt16LE(20);
  const numChannels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);

  // Search for 'data' chunk
  let offset = 12; // after 'WAVE'
  let dataSize = 0;
  let dataOffset = 0;

  while (offset < wav.length - 8) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      dataSize = chunkSize;
      dataOffset = offset + 8;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (dataOffset === 0) {
    throw new Error('No data chunk found in WAV file');
  }

  // When ffmpeg pipes WAV to stdout, it can't seek back to write the final
  // data size, so it writes 0xFFFFFFFF. Use actual buffer length instead.
  if (dataSize === 0xFFFFFFFF || dataSize > wav.length - dataOffset) {
    dataSize = wav.length - dataOffset;
  }

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = dataSize / (bytesPerSample * numChannels);
  const durationMs = (totalSamples / sampleRate) * 1000;

  return {
    sampleRate,
    numChannels,
    bitsPerSample,
    audioFormat,
    dataSize,
    dataOffset,
    durationMs,
  };
}

/** ffmpeg's `atempo` filter accepts a factor in [0.5, 2.0] per instance and
 *  errors outside it, so a larger change has to be split across several
 *  instances whose product is the requested speed. */
const ATEMPO_MIN = 0.5;
const ATEMPO_MAX = 2;

/** Widest range the chain will honour, i.e. two `atempo` stages either way.
 *  Past this the voice stops being intelligible, so a request that far out is
 *  far more likely a typo than an intent. */
const SPEED_MIN = ATEMPO_MIN * ATEMPO_MIN;
const SPEED_MAX = ATEMPO_MAX * ATEMPO_MAX;

/**
 * Normalise a requested `speed` before it reaches the atempo chain.
 *
 * Throws on values the chain cannot converge on: it divides by the stage
 * factor each pass, so `0`, a negative, or `Infinity` would loop forever —
 * a hang mid-TTS with no output and no error. `NaN` escapes both loops and
 * emits a literal `atempo=NaN`, which makes ffmpeg exit non-zero inside
 * `execFileSync`. Both are misconfiguration, so they fail loudly.
 *
 * Merely extreme values are clamped rather than rejected — the intent is
 * legible even when the number is silly.
 */
function guardSpeed(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error(`TTS speed must be a positive finite number, got ${speed}`);
  }
  const capped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed));
  if (capped !== speed) {
    console.warn(`Warning: TTS speed ${speed} clamped to ${capped}`);
  }
  return capped;
}

/** Trim floating-point noise so the filter string stays readable and ffmpeg
 *  never sees something like `atempo=1.7999999999999998`. */
function fmt(n: number): string {
  return String(Number(n.toFixed(6)));
}

/**
 * Build the ffmpeg args that change playback rate to `speed`.
 *
 * `atempo` rather than `asetrate`: it resamples in the time domain, so the
 * voice speeds up without shifting pitch. Returns an empty array at 1x so the
 * default path spawns ffmpeg with no filter at all.
 */
export function buildAtempoChain(speed: number): string[] {
  if (speed === 1) return [];
  speed = guardSpeed(speed);

  const stages: number[] = [];
  let remaining = speed;
  while (remaining > ATEMPO_MAX) {
    stages.push(ATEMPO_MAX);
    remaining /= ATEMPO_MAX;
  }
  while (remaining < ATEMPO_MIN) {
    stages.push(ATEMPO_MIN);
    remaining /= ATEMPO_MIN;
  }
  stages.push(remaining);

  return ['-filter:a', stages.map(s => `atempo=${fmt(s)}`).join(',')];
}

/** A headerless audio stream. ffmpeg cannot sniff one, so it has to be told. */
export interface RawAudioFormat {
  /** ffmpeg demuxer name, passed to `-f`. `s16le` for signed 16-bit
   *  little-endian. Not a codec: `-c:a` would reject it. */
  format: string;
  sampleRate: number;
  channels: number;
}

/** One parameter's value, tolerating the spacing and quoting RFC 2045 allows. */
function mimeParam(params: string[], name: string): string | undefined {
  const pattern = new RegExp(`^${name}\\s*=\\s*(.*)$`, 'i');
  for (const param of params) {
    const match = pattern.exec(param);
    if (match) return match[1].trim().replace(/^"(.*)"$/s, '$1');
  }
  return undefined;
}

/**
 * Read a raw-PCM media type into the arguments ffmpeg needs to open it.
 *
 * Raw PCM carries no header, so ffmpeg cannot open it without being told the
 * format. Gemini's TTS models send `audio/L16;codec=pcm;rate=24000`.
 *
 * Little-endian contradicts RFC 2586 section 3, which defines L16 as network
 * byte order, but it is what Google sends. A conforming provider needs `s16be`.
 *
 * Returns null for self-describing formats, which ffmpeg can probe itself.
 * Throws for an L16 type carrying no readable rate, which nothing can recover.
 */
export function parseRawAudioMime(mimeType: string | undefined): RawAudioFormat | null {
  if (!mimeType) return null;
  const [type, ...params] = mimeType.split(';').map(part => part.trim());
  // L16 is the only raw encoding the engines here emit. `audio/L8` (RFC 3551)
  // and `audio/L24` (RFC 3190) exist but nothing returns them, so they are
  // left unhandled rather than guessed at.
  if (type.toLowerCase() !== 'audio/l16') return null;

  const rawRate = mimeParam(params, 'rate');
  const rate = Number(rawRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    // Refusing beats guessing. Declaring 24000 for a stream that is really
    // 16000 does not fail: it returns a clip a third shorter at 1.5x pitch,
    // exit code 0, and argo derives scene durations from clip length, so every
    // wait in the recording shortens and nothing reports a problem. RFC 2586
    // lists `rate` as required, so a missing one is malformed input.
    throw new Error(
      `cannot read a sample rate from "${mimeType}". Raw PCM carries no header, ` +
        'so the rate has to come from the media type.',
    );
  }
  // Unlike `rate`, the channel default is the RFC's own: "channels ... defaults
  // to 1" in the L16 registration.
  const channels = Number(mimeParam(params, 'channels'));
  return {
    format: 's16le',
    sampleRate: rate,
    channels: Number.isFinite(channels) && channels > 0 ? channels : 1,
  };
}

/**
 * Convert arbitrary audio (MP3, OGG, PCM, etc.) to Argo's WAV format
 * (mono, Float32, 24kHz) using ffmpeg.
 *
 * `speed` is applied here because engines that render server-side (ElevenLabs,
 * Gemini) have no native rate control — this conversion is the only place the
 * rate can change. Engines with their own speed parameter must not use it.
 *
 * `inputFormat` describes a headerless stream. Pass it whenever the source is
 * raw PCM; omit it and ffmpeg probes the container itself.
 */
export function convertToWav(
  audioBuffer: Buffer,
  speed = 1,
  inputFormat?: RawAudioFormat | null,
): Buffer {
  const { execFileSync } = childProcess;
  const inputArgs = inputFormat
    ? ['-f', inputFormat.format, '-ar', String(inputFormat.sampleRate), '-ac', String(inputFormat.channels)]
    : [];
  const result = execFileSync('ffmpeg', [
    ...inputArgs,
    '-i', 'pipe:0',
    ...buildAtempoChain(speed),
    '-f', 'wav',
    '-acodec', 'pcm_f32le',
    '-ac', '1',
    '-ar', '24000',
    'pipe:1',
  ], { input: audioBuffer, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
  return result;
}

/**
 * Creates a mock TTS engine that produces silent WAV buffers of the given
 * duration and records all calls for test assertions.
 */
export function createMockTTSEngine(
  durationMs = 500,
): TTSEngine & { calls: Array<{ text: string; options: TTSEngineOptions }> } {
  const calls: Array<{ text: string; options: TTSEngineOptions }> = [];

  return {
    calls,
    async generate(text: string, options: TTSEngineOptions): Promise<Buffer> {
      calls.push({ text, options });
      const sampleRate = 24000;
      const numSamples = Math.round((durationMs / 1000) * sampleRate);
      const samples = new Float32Array(numSamples); // zeros = silence
      return createWavBuffer(samples, sampleRate);
    },
  };
}
