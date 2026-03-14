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
export { NarrationTimeline, type SceneDurationOptions } from './narration.js';

// Captions
export { showCaption, hideCaption, withCaption } from './captions.js';

// Overlays
export {
  showOverlay,
  hideOverlay,
  withOverlay,
  type OverlayCue,
  type OverlayManifestEntry,
  type Zone,
  type TemplateType,
  type MotionPreset,
} from './overlays/index.js';

// Effects
export { showConfetti, type ConfettiOptions } from './effects.js';

// TTS
export { type TTSEngineOptions } from './tts/engine.js';

// Subtitles
export { generateSrt, generateVtt } from './subtitles.js';

// Chapters
export { generateChapterMetadata } from './chapters.js';

// Report
export { buildSceneReport, formatSceneReport, type SceneReport } from './report.js';

// Validate
export { validateDemo, type ValidateOptions, type ValidateResult } from './validate.js';

// Init
export { init } from './init.js';
