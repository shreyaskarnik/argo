import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SarvamEngine } from '../../src/tts/engines/sarvam.js';

/**
 * Regression coverage for #40: the engine destructured the `default` export of
 * `sarvamai`, which does not exist. `SarvamAI` is a namespace object and the
 * client class is `SarvamAIClient`, so `new SarvamAI(...)` threw
 * `SarvamAI is not a constructor` for every user who had the package installed
 * correctly — the engine had never worked.
 *
 * The mock mirrors the real module shape exactly, `default: undefined` and all,
 * so a regression back to the default import fails here rather than only in
 * production.
 */
// `vi.hoisted` because `vi.mock` is lifted above every const in the file; a
// plain const here is still in its TDZ when the factory runs, and sarvam.ts's
// catch would report the resulting ReferenceError as "package not installed".
const { convertMock, clientCtor, sdk } = vi.hoisted(() => ({
  convertMock: vi.fn(async () => ({ audios: [Buffer.from('pcm').toString('base64')] })),
  clientCtor: vi.fn(),
  // Mutable so one test can simulate an SDK that no longer exports the client.
  sdk: { client: undefined as unknown },
}));

vi.mock('sarvamai', () => ({
  get SarvamAIClient() {
    return sdk.client;
  },
  // The real package exports a namespace under `SarvamAI` and no default.
  SarvamAI: {},
}));

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => Buffer.from('fake-wav')),
}));

describe('SarvamEngine', () => {
  beforeEach(() => {
    convertMock.mockClear();
    clientCtor.mockClear();
    sdk.client = class SarvamAIClient {
      textToSpeech = { convert: convertMock };
      constructor(opts: unknown) {
        clientCtor(opts);
      }
    };
  });

  // A bare `new undefined()` already mentions SarvamAIClient, so this asserts
  // the actionable half: which package is wrong and what to do about it.
  it('explains the SDK is incompatible when the client export is missing', async () => {
    sdk.client = undefined;
    const engine = new SarvamEngine({ apiKey: 'test-key' });
    await expect(engine.generate('hello', {})).rejects.toThrow(
      /installed 'sarvamai' package does not export SarvamAIClient/,
    );
  });

  it('constructs SarvamAIClient rather than a non-existent default export', async () => {
    const engine = new SarvamEngine({ apiKey: 'test-key' });
    await engine.generate('नमस्ते', {});
    expect(clientCtor).toHaveBeenCalledWith({ apiSubscriptionKey: 'test-key' });
  });

  it('sends the scene text and voice options to the API', async () => {
    const engine = new SarvamEngine({ apiKey: 'test-key' });
    await engine.generate('hello', { lang: 'en-IN', voice: 'anushka', speed: 1.2 });

    expect(convertMock).toHaveBeenCalledOnce();
    const payload = convertMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.inputs).toEqual(['hello']);
    expect(payload.target_language_code).toBe('en-IN');
    expect(payload.speaker).toBe('anushka');
    // Sarvam has native rate control, so speed rides on `pace` and must NOT be
    // re-applied by convertToWav — that would compound the two.
    expect(payload.pace).toBe(1.2);
  });

  it('throws a clear error when the API returns no audio', async () => {
    convertMock.mockResolvedValueOnce({ audios: [] } as never);
    const engine = new SarvamEngine({ apiKey: 'test-key' });
    await expect(engine.generate('hello', {})).rejects.toThrow('returned no audio data');
  });

  it('still rejects empty text before touching the SDK', async () => {
    const engine = new SarvamEngine({ apiKey: 'test-key' });
    await expect(engine.generate('   ', {})).rejects.toThrow('TTS text must not be empty');
    expect(clientCtor).not.toHaveBeenCalled();
  });
});
