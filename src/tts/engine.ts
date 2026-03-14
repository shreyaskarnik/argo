/**
 * TTS Engine interface and WAV utilities for Argo.
 */

export interface TTSEngineOptions {
  voice?: string;
  speed?: number;
  lang?: string;
}

export interface TTSEngine {
  generate(text: string, options: TTSEngineOptions): Promise<Buffer>;
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

/**
 * Convert arbitrary audio (MP3, OGG, PCM, etc.) to Argo's WAV format
 * (mono, Float32, 24kHz) using ffmpeg.
 */
export function convertToWav(audioBuffer: Buffer): Buffer {
  const { execFileSync } = require('node:child_process');
  const result = execFileSync('ffmpeg', [
    '-i', 'pipe:0',
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
