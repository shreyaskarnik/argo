// Argo — Playwright demo recording with AI voiceover

// Config
export {
  defineConfig,
  loadConfig,
  demosProject,
  type ArgoConfig,
  type UserConfig,
  type TTSConfig,
  type TTSEngine,
  type VideoConfig,
  type ExportConfig,
} from './config.js';

// Fixtures
export { test, expect, demoType } from './fixtures.js';

// Narration
export { NarrationTimeline } from './narration.js';

// Captions
export { showCaption, hideCaption, withCaption } from './captions.js';

// TTS
export { type TTSEngineOptions } from './tts/engine.js';

// Init
export { init } from './init.js';
