import { describe, it, expect } from 'vitest';
import {
  createWavBuffer,
  parseWavHeader,
  createMockTTSEngine,
  type TTSEngine,
  type TTSEngineOptions,
} from '../../src/tts/engine.js';

describe('createWavBuffer', () => {
  it('produces a buffer starting with RIFF....WAVE', () => {
    const samples = new Float32Array(100);
    const buf = createWavBuffer(samples);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  });

  it('writes correct fmt chunk for 32-bit float', () => {
    const samples = new Float32Array(10);
    const buf = createWavBuffer(samples, 24000);

    // fmt chunk starts at byte 12
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    const fmtSize = buf.readUInt32LE(16);
    expect(fmtSize).toBe(16);

    const audioFormat = buf.readUInt16LE(20);
    expect(audioFormat).toBe(3); // IEEE float

    const numChannels = buf.readUInt16LE(22);
    expect(numChannels).toBe(1); // mono

    const sampleRate = buf.readUInt32LE(24);
    expect(sampleRate).toBe(24000);

    const bitsPerSample = buf.readUInt16LE(34);
    expect(bitsPerSample).toBe(32);
  });

  it('has correct RIFF chunk size', () => {
    const samples = new Float32Array(50);
    const buf = createWavBuffer(samples);
    const riffSize = buf.readUInt32LE(4);
    expect(riffSize).toBe(buf.length - 8);
  });

  it('has correct data chunk size', () => {
    const samples = new Float32Array(50);
    const buf = createWavBuffer(samples);
    // data chunk id at byte 36
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    const dataSize = buf.readUInt32LE(40);
    expect(dataSize).toBe(50 * 4); // 50 samples * 4 bytes each
  });

  it('total buffer length = 44 + sample data', () => {
    const samples = new Float32Array(100);
    const buf = createWavBuffer(samples);
    expect(buf.length).toBe(44 + 100 * 4);
  });

  it('preserves sample values', () => {
    const samples = new Float32Array([0.5, -0.5, 1.0, -1.0, 0.0]);
    const buf = createWavBuffer(samples);
    for (let i = 0; i < samples.length; i++) {
      const val = buf.readFloatLE(44 + i * 4);
      expect(val).toBeCloseTo(samples[i], 5);
    }
  });

  it('respects custom sample rate', () => {
    const samples = new Float32Array(10);
    const buf = createWavBuffer(samples, 44100);
    const sampleRate = buf.readUInt32LE(24);
    expect(sampleRate).toBe(44100);
  });

  it('uses default sample rate of 24000', () => {
    const samples = new Float32Array(10);
    const buf = createWavBuffer(samples);
    expect(buf.readUInt32LE(24)).toBe(24000);
  });
});

describe('parseWavHeader', () => {
  it('round-trips with createWavBuffer', () => {
    const samples = new Float32Array(200);
    const buf = createWavBuffer(samples, 16000);
    const header = parseWavHeader(buf);

    expect(header.sampleRate).toBe(16000);
    expect(header.numChannels).toBe(1);
    expect(header.bitsPerSample).toBe(32);
    expect(header.audioFormat).toBe(3);
    expect(header.dataSize).toBe(200 * 4);
    expect(header.dataOffset).toBe(44);
  });

  it('computes durationMs correctly', () => {
    const sampleRate = 24000;
    const numSamples = sampleRate; // 1 second worth
    const samples = new Float32Array(numSamples);
    const buf = createWavBuffer(samples, sampleRate);
    const header = parseWavHeader(buf);
    expect(header.durationMs).toBeCloseTo(1000, 0);
  });

  it('throws on buffer smaller than 44 bytes', () => {
    const small = Buffer.alloc(20);
    expect(() => parseWavHeader(small)).toThrow();
  });

  it('throws on non-WAV buffer', () => {
    const notWav = Buffer.alloc(100, 0);
    notWav.write('NOTRIFF', 0, 'ascii');
    expect(() => parseWavHeader(notWav)).toThrow();
  });

  it('throws when WAVE marker is missing', () => {
    const buf = Buffer.alloc(100, 0);
    buf.write('RIFF', 0, 'ascii');
    buf.write('NOOO', 8, 'ascii');
    expect(() => parseWavHeader(buf)).toThrow();
  });

  it('finds data chunk even with extra chunks', () => {
    // Build a WAV with an extra chunk between fmt and data
    const samples = new Float32Array(10);
    const normal = createWavBuffer(samples);

    // Insert a dummy chunk after fmt (at byte 36)
    const dummyChunkId = Buffer.from('LIST', 'ascii');
    const dummyChunkSize = Buffer.alloc(4);
    dummyChunkSize.writeUInt32LE(8, 0);
    const dummyChunkData = Buffer.alloc(8, 0xAB);

    const before = normal.subarray(0, 36); // RIFF header + fmt chunk
    const dataChunk = normal.subarray(36); // data chunk

    // Fix RIFF size
    const extended = Buffer.concat([before, dummyChunkId, dummyChunkSize, dummyChunkData, dataChunk]);
    extended.writeUInt32LE(extended.length - 8, 4);

    const header = parseWavHeader(extended);
    expect(header.dataSize).toBe(10 * 4);
    expect(header.dataOffset).toBe(44 + 16); // shifted by dummy chunk
  });
});

describe('createMockTTSEngine', () => {
  it('implements TTSEngine interface', async () => {
    const engine = createMockTTSEngine();
    // Should have generate method
    expect(typeof engine.generate).toBe('function');
    const result = await engine.generate('hello', {});
    expect(Buffer.isBuffer(result)).toBe(true);
  });

  it('returns a valid WAV buffer', async () => {
    const engine = createMockTTSEngine(500);
    const buf = await engine.generate('test', {});
    const header = parseWavHeader(buf);
    expect(header.sampleRate).toBe(24000);
    expect(header.numChannels).toBe(1);
    expect(header.audioFormat).toBe(3);
  });

  it('records calls for assertions', async () => {
    const engine = createMockTTSEngine();
    expect(engine.calls).toEqual([]);

    await engine.generate('first', { voice: 'alloy' });
    await engine.generate('second', { speed: 1.5 });

    expect(engine.calls).toHaveLength(2);
    expect(engine.calls[0]).toEqual({ text: 'first', options: { voice: 'alloy' } });
    expect(engine.calls[1]).toEqual({ text: 'second', options: { speed: 1.5 } });
  });

  it('respects durationMs parameter', async () => {
    const engine = createMockTTSEngine(1000);
    const buf = await engine.generate('test', {});
    const header = parseWavHeader(buf);
    // 1000ms at 24000 Hz = 24000 samples
    expect(header.durationMs).toBeCloseTo(1000, -1);
  });

  it('defaults to 500ms duration', async () => {
    const engine = createMockTTSEngine();
    const buf = await engine.generate('test', {});
    const header = parseWavHeader(buf);
    expect(header.durationMs).toBeCloseTo(500, -1);
  });

  it('produces silent audio (all zeros)', async () => {
    const engine = createMockTTSEngine(100);
    const buf = await engine.generate('test', {});
    const header = parseWavHeader(buf);
    for (let i = 0; i < header.dataSize; i += 4) {
      const sample = buf.readFloatLE(header.dataOffset + i);
      expect(sample).toBe(0);
    }
  });
});
