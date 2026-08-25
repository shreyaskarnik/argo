import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { GeminiEngine } from '../../src/tts/engines/gemini.js';

/**
 * The bug this guards was "GeminiEngine.generate never produced audio", and
 * nothing in the suite called that method: `config.test.ts` only asserts the
 * constructor does not throw, so the whole suite stayed green while the engine
 * was dead. Covering `parseRawAudioMime` and `convertToWav` separately does not
 * help either, because the defect was the wiring between them.
 *
 * Pattern borrowed from `mlx-audio.test.ts`: mock the transport, let the
 * downstream ffmpeg call be a stub, and assert on the argv it was handed.
 */
const generateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => Buffer.from('fake-wav')),
}));

/** A response shaped like the one Gemini's TTS models actually return. */
function audioResponse(mimeType: string) {
  return {
    candidates: [
      { content: { parts: [{ inlineData: { mimeType, data: Buffer.from('pcm').toString('base64') } }] } },
    ],
  };
}

/** The ffmpeg argv from the conversion that followed. */
function ffmpegArgs(): string[] {
  return vi.mocked(execFileSync).mock.calls[0][1] as string[];
}

describe('GeminiEngine.generate', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
    generateContent.mockReset();
  });

  it('tells ffmpeg the format of the raw PCM it was sent', async () => {
    generateContent.mockResolvedValue(audioResponse('audio/L16;codec=pcm;rate=24000'));
    const engine = new GeminiEngine({ apiKey: 'test' });

    await engine.generate('hello', { voice: 'Kore' });

    const argv = ffmpegArgs();
    const i = argv.indexOf('-i');
    expect(argv.slice(0, i)).toEqual(['-f', 's16le', '-ar', '24000', '-ac', '1']);
  });

  it('takes the rate from the response rather than assuming one', async () => {
    // A wrong rate is silently wrong, so the engine has to read what it was sent.
    generateContent.mockResolvedValue(audioResponse('audio/L16;codec=pcm;rate=16000'));
    const engine = new GeminiEngine({ apiKey: 'test' });

    await engine.generate('hello', { voice: 'Kore' });

    expect(ffmpegArgs()[ffmpegArgs().indexOf('-ar') + 1]).toBe('16000');
  });

  it('carries speed through to the conversion', async () => {
    generateContent.mockResolvedValue(audioResponse('audio/L16;codec=pcm;rate=24000'));
    const engine = new GeminiEngine({ apiKey: 'test' });

    await engine.generate('hello', { voice: 'Kore', speed: 1.5 });

    expect(ffmpegArgs()).toContain('atempo=1.5');
  });

  it('refuses a response it cannot read the rate from', async () => {
    generateContent.mockResolvedValue(audioResponse('audio/L16;codec=pcm'));
    const engine = new GeminiEngine({ apiKey: 'test' });

    await expect(engine.generate('hello', { voice: 'Kore' })).rejects.toThrow(/sample rate/);
  });

  it('defaults to a model that can actually return audio', async () => {
    // The previous default was `gemini-2.5-flash`, which answers an AUDIO
    // request with 400 "This model only supports text output". Nothing in the
    // suite caught it because the transport is mocked here, so pin the model
    // name: it is the only part of that failure visible without a live call.
    generateContent.mockResolvedValue(audioResponse('audio/l16; rate=24000; channels=1'));
    const engine = new GeminiEngine({ apiKey: 'test' });

    await engine.generate('hello', { voice: 'Kore' });

    expect(generateContent.mock.calls[0][0].model).toBe('gemini-3.1-flash-tts-preview');
    expect(engine.describe().model).toBe('gemini-3.1-flash-tts-preview');
  });

  it('reads the media type spelling the 3.1 models use', async () => {
    // Same audio, different spelling: lowercase `l16`, spaces after the
    // semicolons, no `codec`, and an explicit `channels`. Both spellings are
    // captured from live responses, 2.5 and 3.1 respectively.
    generateContent.mockResolvedValue(audioResponse('audio/l16; rate=24000; channels=1'));
    const engine = new GeminiEngine({ apiKey: 'test' });

    await engine.generate('hello', { voice: 'Kore' });

    const argv = ffmpegArgs();
    expect(argv.slice(0, argv.indexOf('-i'))).toEqual(['-f', 's16le', '-ar', '24000', '-ac', '1']);
  });

  it('raises a useful error when the response carries no audio', async () => {
    generateContent.mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] });
    const engine = new GeminiEngine({ apiKey: 'test' });

    await expect(engine.generate('hello', { voice: 'Kore' })).rejects.toThrow(/did not return audio/);
  });
});
