import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MlxAudioEngine } from '../../src/tts/engines/mlx-audio.js';

describe('MlxAudioEngine', () => {
  it('throws on empty text', async () => {
    const engine = new MlxAudioEngine();
    await expect(engine.generate('', {})).rejects.toThrow('TTS text must not be empty');
    await expect(engine.generate('   ', {})).rejects.toThrow('TTS text must not be empty');
  });

  it('throws when refAudio is set without refText', () => {
    expect(() => new MlxAudioEngine({ refAudio: '/path/to/voice.wav' })).toThrow(
      'refText is required when refAudio is set for voice cloning',
    );
  });

  it('allows refAudio with refText', () => {
    expect(
      () =>
        new MlxAudioEngine({
          refAudio: '/path/to/voice.wav',
          refText: 'Hello this is my voice.',
        }),
    ).not.toThrow();
  });

  describe('request payload', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      const fakeResponse = new Response(Buffer.from('fake-audio'), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse);
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('sends basic payload without optional fields by default', async () => {
      const engine = new MlxAudioEngine({ baseUrl: 'http://test:9000' });

      try {
        await engine.generate('Hello world', { voice: 'am_michael' });
      } catch {
        // convertToWav will fail on fake audio — that's fine
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://test:9000/v1/audio/speech');
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        model: 'mlx-community/Spark-TTS-0.5B-bf16',
        input: 'Hello world',
        voice: 'am_michael',
      });
      expect(body.ref_audio).toBeUndefined();
      expect(body.ref_text).toBeUndefined();
    });

    it('includes ref_audio and ref_text for voice cloning', async () => {
      const engine = new MlxAudioEngine({
        baseUrl: 'http://test:9000',
        model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
        refAudio: '/path/to/my_voice.wav',
        refText: 'This is what my voice sounds like.',
      });

      try {
        await engine.generate('Clone my voice', { voice: 'custom' });
      } catch {
        // convertToWav will fail on fake audio
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.model).toBe('mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16');
      expect(body.input).toBe('Clone my voice');
      expect(body.ref_audio).toBe('/path/to/my_voice.wav');
      expect(body.ref_text).toBe('This is what my voice sounds like.');
    });

    it('passes through all SpeechRequest options', async () => {
      const engine = new MlxAudioEngine({
        baseUrl: 'http://test:9000',
        model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
        refAudio: '/path/to/voice.wav',
        refText: 'Reference transcript.',
        instruct: 'Speak cheerfully with high energy.',
        gender: 'female',
        pitch: 1.2,
        langCode: 'en',
        temperature: 0.8,
        topP: 0.9,
        topK: 50,
        repetitionPenalty: 1.1,
        responseFormat: 'wav',
        stream: false,
        streamingInterval: 3.0,
        maxTokens: 2000,
        verbose: true,
      });

      try {
        await engine.generate('Full options test', { voice: 'narrator', speed: 1.5 });
      } catch {
        // convertToWav will fail on fake audio
      }

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body).toEqual({
        model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
        input: 'Full options test',
        voice: 'narrator',
        speed: 1.5,
        ref_audio: '/path/to/voice.wav',
        ref_text: 'Reference transcript.',
        instruct: 'Speak cheerfully with high energy.',
        gender: 'female',
        pitch: 1.2,
        lang_code: 'en',
        temperature: 0.8,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.1,
        response_format: 'wav',
        stream: false,
        streaming_interval: 3.0,
        max_tokens: 2000,
        verbose: true,
      });
    });

    it('passes TTSEngineOptions.speed to payload', async () => {
      const engine = new MlxAudioEngine({ baseUrl: 'http://test:9000' });

      try {
        await engine.generate('Speed test', { speed: 0.8 });
      } catch {
        // convertToWav will fail
      }

      const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      expect(body.speed).toBe(0.8);
    });
  });
});
