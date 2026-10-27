import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PhononEngine } from '../../src/tts/engines/phonon.js';
import { engines } from '../../src/tts/engines/index.js';
import { convertToWav, parseWavHeader } from '../../src/tts/engine.js';

// Only convertToWav (the ffmpeg path) is stubbed; everything else is real.
vi.mock('../../src/tts/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tts/engine.js')>()),
  convertToWav: vi.fn(() => Buffer.from('ffmpeg-output')),
}));

/** Headerless s16le PCM, as ptts-openai-server returns for response_format=pcm. */
function pcm16(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

function pcmResponse(values: number[], status = 200): Response {
  return new Response(pcm16(values), {
    status,
    headers: { 'Content-Type': 'audio/pcm' },
  });
}

describe('PhononEngine', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const savedUrl = process.env.PHONON_TTS_URL;

  beforeEach(() => {
    delete process.env.PHONON_TTS_URL;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => pcmResponse([0, 16384, -32768, 32767]));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
    if (savedUrl === undefined) delete process.env.PHONON_TTS_URL;
    else process.env.PHONON_TTS_URL = savedUrl;
  });

  it('is registered as engines.phonon', () => {
    expect(engines.phonon()).toBeInstanceOf(PhononEngine);
  });

  it('constructs without any server or key (validation is lazy)', () => {
    expect(() => new PhononEngine()).not.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on empty text without calling the server', async () => {
    const engine = new PhononEngine();
    await expect(engine.generate('', {})).rejects.toThrow('TTS text must not be empty');
    await expect(engine.generate('   ', {})).rejects.toThrow('TTS text must not be empty');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('describe() reports engine, server and voice', () => {
    expect(new PhononEngine({ baseUrl: 'http://box:9000/', voice: 'Zoey' }).describe()).toEqual({
      engine: 'phonon',
      baseUrl: 'http://box:9000',
      voice: 'Zoey',
    });
  });

  it('defaults to localhost:8880 and honours PHONON_TTS_URL', () => {
    expect(new PhononEngine().describe().baseUrl).toBe('http://localhost:8880');
    process.env.PHONON_TTS_URL = 'http://gpu-box:8880';
    expect(new PhononEngine().describe().baseUrl).toBe('http://gpu-box:8880');
    expect(new PhononEngine({ baseUrl: 'http://explicit:1' }).describe().baseUrl).toBe('http://explicit:1');
  });

  it('posts input/voice/response_format=pcm and never sends speed', async () => {
    const engine = new PhononEngine({ baseUrl: 'http://test:8880' });
    await engine.generate('Hello world', { voice: 'Zoey', speed: 1 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://test:8880/v1/audio/speech');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({
      input: 'Hello world',
      voice: 'Zoey',
      response_format: 'pcm',
    });
  });

  it('converts 16-bit PCM to mono Float32 24 kHz WAV', async () => {
    const engine = new PhononEngine();
    const wav = await engine.generate('Hello', { voice: 'Zoey' });

    const header = parseWavHeader(wav);
    expect(header.sampleRate).toBe(24000);
    expect(header.numChannels).toBe(1);
    expect(header.bitsPerSample).toBe(32);

    const samples = new Float32Array(
      wav.buffer.slice(wav.byteOffset + header.dataOffset, wav.byteOffset + header.dataOffset + header.dataSize),
    );
    expect(Array.from(samples)).toEqual([0, 0.5, -1, 32767 / 32768]);
  });

  it('uses the configured default voice when the scene names none', async () => {
    const engine = new PhononEngine({ voice: 'Easton' });
    await engine.generate('Hi', {});
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string).voice).toBe('Easton');

    await new PhononEngine().generate('Hi', {});
    expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string).voice).toBe('default');
  });

  it('maps Kokoro voice names (Argo global default) to the Phonon voice, warning once', async () => {
    const engine = new PhononEngine();
    await engine.generate('One', { voice: 'af_heart' });
    await engine.generate('Two', { voice: 'af_heart' });

    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string).voice).toBe('default');
    expect(JSON.parse(fetchSpy.mock.calls[1][1]!.body as string).voice).toBe('default');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toContain('af_heart');
  });

  it('splits input longer than the server limit of 4096 chars', async () => {
    const sentence = 'This is a fairly ordinary sentence for a product demo voiceover. ';
    const text = sentence.repeat(100); // ~6500 chars
    const engine = new PhononEngine();
    await engine.generate(text, { voice: 'Zoey' });

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchSpy.mock.calls) {
      expect(JSON.parse(call[1]!.body as string).input.length).toBeLessThanOrEqual(4096);
    }
  });

  it('applies non-1x speed with ffmpeg atempo on the raw s16le stream', async () => {
    const engine = new PhononEngine();
    const out = await engine.generate('Hello', { voice: 'Zoey', speed: 1.25 });

    expect(out.toString()).toBe('ffmpeg-output');
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string).speed).toBeUndefined();
    expect(convertToWav).toHaveBeenCalledWith(pcm16([0, 16384, -32768, 32767]), 1.25, {
      format: 's16le',
      sampleRate: 24000,
      channels: 1,
    });
  });

  it('does not touch ffmpeg at 1x', async () => {
    vi.mocked(convertToWav).mockClear();
    await new PhononEngine().generate('Hello', { voice: 'Zoey' });
    expect(convertToWav).not.toHaveBeenCalled();
  });

  it('surfaces server errors with status and body', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":{"message":"unknown voice: Nope"}}', { status: 400 }),
    );
    const engine = new PhononEngine({ baseUrl: 'http://test:8880' });
    await expect(engine.generate('Hello', { voice: 'Nope' })).rejects.toThrow(
      /Phonon server error 400.*unknown voice.*\/v1\/audio\/voices/,
    );
  });

  it('explains how to start the server when it is unreachable', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));
    const engine = new PhononEngine();
    await expect(engine.generate('Hello', {})).rejects.toThrow(
      /Could not reach Phonon server.*ptts-openai-server/,
    );
  });

  it('rejects an empty audio body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(Buffer.alloc(0), { status: 200 }));
    await expect(new PhononEngine().generate('Hello', {})).rejects.toThrow('returned no audio');
  });
});
