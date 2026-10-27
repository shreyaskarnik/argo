import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIEngine } from '../../src/tts/engines/openai.js';

/**
 * The SDK is mocked at its constructor, so these assert what the engine hands the client (where it connects,
 * with which key and timeout) and the request it sends; the PCM-to-WAV path is covered by its own tests.
 */
const clientOptions = vi.fn();
const create = vi.fn();

vi.mock('openai', () => ({
  OpenAI: class {
    audio = { speech: { create } };
    constructor(options: unknown) {
      clientOptions(options);
    }
  },
}));

describe('OpenAIEngine', () => {
  const savedKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    clientOptions.mockReset();
    create.mockReset().mockResolvedValue(new Response(Buffer.alloc(480)));
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it('talks to OpenAI with OPENAI_API_KEY by default', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    await new OpenAIEngine().generate('Hello', {});
    expect(clientOptions).toHaveBeenCalledWith({ apiKey: 'sk-env' });
  });

  it('still requires a key for OpenAI itself', async () => {
    await expect(new OpenAIEngine().generate('Hello', {})).rejects.toThrow('requires an API key');
  });

  it('connects to baseUrl with the given timeout', async () => {
    await new OpenAIEngine({ baseUrl: 'http://localhost:8881/v1', timeoutMs: 1_800_000 }).generate('Hello', {});
    expect(clientOptions).toHaveBeenCalledWith({
      apiKey: 'unused',
      baseURL: 'http://localhost:8881/v1',
      timeout: 1_800_000,
    });
  });

  it('passes fetchOptions through to the client', async () => {
    const dispatcher = { tag: 'agent' };
    await new OpenAIEngine({ baseUrl: 'http://localhost:8881/v1', fetchOptions: { dispatcher } }).generate('Hello', {});
    expect(clientOptions.mock.calls[0][0].fetchOptions).toEqual({ dispatcher });
  });

  it('never sends OPENAI_API_KEY to another server', async () => {
    process.env.OPENAI_API_KEY = 'sk-env';
    await new OpenAIEngine({ baseUrl: 'http://localhost:8881/v1' }).generate('Hello', {});
    expect(clientOptions.mock.calls[0][0].apiKey).toBe('unused');
  });

  it('sends an explicit apiKey to the custom server', async () => {
    await new OpenAIEngine({ baseUrl: 'https://tts.example/v1', apiKey: 'tok' }).generate('Hello', {});
    expect(clientOptions.mock.calls[0][0].apiKey).toBe('tok');
  });

  it('passes the voice and asks for PCM', async () => {
    await new OpenAIEngine({ baseUrl: 'http://localhost:8881/v1', model: 'cosyvoice3' }).generate('Hola', {
      voice: 'narrator/es',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'cosyvoice3', voice: 'narrator/es', input: 'Hola', response_format: 'pcm' }),
    );
  });

  it("names a custom server in the video's metadata", () => {
    expect(new OpenAIEngine({ baseUrl: 'http://localhost:8881/v1' }).describe()).toEqual({
      engine: 'openai',
      model: 'tts-1',
      baseUrl: 'http://localhost:8881/v1',
    });
    expect(new OpenAIEngine().describe()).toEqual({ engine: 'openai', model: 'tts-1' });
  });
});
