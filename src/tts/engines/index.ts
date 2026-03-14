import type { TTSEngine } from '../engine.js';
import { KokoroEngine, type KokoroEngineOptions } from './kokoro.js';
import { OpenAIEngine, type OpenAIEngineOptions } from './openai.js';
import { ElevenLabsEngine, type ElevenLabsEngineOptions } from './elevenlabs.js';
import { GeminiEngine, type GeminiEngineOptions } from './gemini.js';
import { SarvamEngine, type SarvamEngineOptions } from './sarvam.js';
import { MlxAudioEngine, type MlxAudioEngineOptions } from './mlx-audio.js';

export const engines = {
  kokoro: (opts?: KokoroEngineOptions): TTSEngine => new KokoroEngine(opts),
  openai: (opts?: OpenAIEngineOptions): TTSEngine => new OpenAIEngine(opts),
  elevenlabs: (opts?: ElevenLabsEngineOptions): TTSEngine => new ElevenLabsEngine(opts),
  gemini: (opts?: GeminiEngineOptions): TTSEngine => new GeminiEngine(opts),
  sarvam: (opts?: SarvamEngineOptions): TTSEngine => new SarvamEngine(opts),
  mlxAudio: (opts?: MlxAudioEngineOptions): TTSEngine => new MlxAudioEngine(opts),
};

export type { KokoroEngineOptions } from './kokoro.js';
export type { OpenAIEngineOptions } from './openai.js';
export type { ElevenLabsEngineOptions } from './elevenlabs.js';
export type { GeminiEngineOptions } from './gemini.js';
export type { SarvamEngineOptions } from './sarvam.js';
export type { MlxAudioEngineOptions } from './mlx-audio.js';

export { KokoroEngine } from './kokoro.js';
export { OpenAIEngine } from './openai.js';
export { ElevenLabsEngine } from './elevenlabs.js';
export { GeminiEngine } from './gemini.js';
export { SarvamEngine } from './sarvam.js';
export { MlxAudioEngine } from './mlx-audio.js';
