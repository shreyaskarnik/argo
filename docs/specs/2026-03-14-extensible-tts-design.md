# Extensible TTS Engine Design

**Date**: 2026-03-14
**Status**: Approved

## Summary

Make Argo's TTS system pluggable with built-in support for 6 engines (Kokoro, OpenAI, ElevenLabs, Gemini, Sarvam, mlx-audio) and a documented interface for community engines. Engines are selected via typed factory functions and their SDK dependencies are lazy-loaded.

## Engine Selection

```javascript
import { defineConfig, engines } from '@argo-video/cli';

export default defineConfig({
  tts: {
    engine: engines.openai({ model: 'tts-1-hd' }),
    defaultVoice: 'alloy',
    defaultSpeed: 1.0,
  },
});
```

Factory functions per engine:
```typescript
engines.kokoro(opts?)       // default, local, free
engines.openai(opts?)       // OpenAI TTS API
engines.elevenlabs(opts?)   // ElevenLabs API
engines.gemini(opts?)       // Google Gemini TTS
engines.sarvam(opts?)       // Sarvam AI (Indian languages)
engines.mlxAudio(opts?)     // Local, Apple Silicon via mlx-audio
```

## Engine Interface

```typescript
export interface TTSEngine {
  generate(text: string, options: TTSEngineOptions): Promise<Buffer>;
}

export interface TTSEngineOptions {
  voice?: string;
  speed?: number;
  lang?: string;
}
```

The `generate()` method must return a WAV buffer: mono, 32-bit IEEE float, any sample rate (the align step normalizes to 24kHz). Engines that receive non-WAV audio from their API (MP3, PCM) must convert internally before returning.

## Built-in Engine Options

### Kokoro (default)
```typescript
engines.kokoro({
  modelId?: string;       // default: 'onnx-community/Kokoro-82M-v1.0-ONNX'
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';  // default: 'q8'
  device?: 'wasm' | 'webgpu' | 'cpu' | null;
})
```
- Voices: `af_heart` (female), `am_michael` (male)
- Dependency: `kokoro-js` (already installed)
- API key: none (local)

### OpenAI
```typescript
engines.openai({
  apiKey?: string;        // default: process.env.OPENAI_API_KEY
  model?: 'tts-1' | 'tts-1-hd';  // default: 'tts-1'
})
```
- Voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`
- Dependency: `openai` (optional, lazy-loaded)
- API key: `OPENAI_API_KEY` env var or `apiKey` option

### ElevenLabs
```typescript
engines.elevenlabs({
  apiKey?: string;        // default: process.env.ELEVENLABS_API_KEY
  model?: string;         // default: 'eleven_monolingual_v1'
  stability?: number;     // 0-1, default: 0.5
  similarityBoost?: number; // 0-1, default: 0.75
})
```
- Voices: ElevenLabs voice IDs
- Dependency: `elevenlabs` (optional, lazy-loaded)
- API key: `ELEVENLABS_API_KEY` env var or `apiKey` option

### Gemini
```typescript
engines.gemini({
  apiKey?: string;        // default: process.env.GEMINI_API_KEY
  model?: string;         // default: 'gemini-2.5-flash'
})
```
- Voices: Gemini voice names
- Dependency: `@google/genai` (optional, lazy-loaded)
- API key: `GEMINI_API_KEY` env var or `apiKey` option

### Sarvam
```typescript
engines.sarvam({
  apiKey?: string;        // default: process.env.SARVAM_API_KEY
  model?: string;         // default: 'bulbul:v2'
})
```
- Voices: Sarvam voice IDs
- Dependency: HTTP fetch (no SDK needed)
- API key: `SARVAM_API_KEY` env var or `apiKey` option
- Focus: Indian languages (Hindi, Tamil, Telugu, etc.)

### mlx-audio
```typescript
engines.mlxAudio({
  modelPath?: string;     // path to local mlx model
})
```
- Voices: model-dependent
- Dependency: `mlx-audio` Python package (called via subprocess)
- API key: none (local, Apple Silicon)

## File Structure

```
src/tts/
├── engine.ts              # TTSEngine interface + WAV utilities (existing)
├── engines/
│   ├── index.ts           # engines.* factory functions
│   ├── kokoro.ts          # moved from src/tts/kokoro.ts
│   ├── openai.ts          # OpenAI TTS adapter
│   ├── elevenlabs.ts      # ElevenLabs adapter
│   ├── gemini.ts          # Gemini TTS adapter
│   ├── sarvam.ts          # Sarvam AI adapter
│   └── mlx-audio.ts       # mlx-audio subprocess adapter
├── generate.ts            # clip generation (existing)
├── align.ts               # alignment (existing)
└── cache.ts               # clip cache (existing)
```

## WAV Normalization

Cloud APIs return various formats (MP3, OGG, raw PCM). Each engine adapter is responsible for converting to the required WAV format (mono, Float32) before returning from `generate()`. Utilities in `engine.ts` help:

- `createWavBuffer(samples: Float32Array, sampleRate: number)` — existing
- New: `pcmToFloat32(buffer: Buffer, bitDepth: 16 | 24 | 32)` — convert PCM to Float32Array
- For MP3/OGG: use ffmpeg or a lightweight decoder to get raw PCM first

## API Key Discovery

All cloud engines follow the same pattern:
1. Check `apiKey` constructor option
2. Fall back to environment variable (`OPENAI_API_KEY`, etc.)
3. Throw with clear message if neither is set

## Lazy Loading

Each engine dynamically imports its SDK dependency:
```typescript
async generate(text, options) {
  const { OpenAI } = await import('openai');
  // ...
}
```

If the SDK is not installed, the `import()` throws and the engine wraps it:
```
Error: OpenAI TTS engine requires the 'openai' package.
Install it with: npm i openai
```

## Community Engines

Users implement `TTSEngine` directly:
```typescript
import { defineConfig, type TTSEngine } from '@argo-video/cli';

class MyCustomEngine implements TTSEngine {
  async generate(text, options) {
    // Call your API, return WAV Buffer
  }
}

export default defineConfig({
  tts: { engine: new MyCustomEngine() },
});
```

## Backward Compatibility

- `KokoroEngine` stays as the default when no engine is specified
- Existing `new KokoroEngine()` in config still works
- `engines.kokoro()` is a convenience alias for the same class
- The `TTSEngine` interface is unchanged
