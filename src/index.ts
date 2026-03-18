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
  type TransitionType,
  type TransitionConfig,
  type SpeedRampConfig,
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

// Camera
export {
  spotlight,
  focusRing,
  dimAround,
  zoomTo,
  resetCamera,
  type SpotlightOptions,
  type FocusRingOptions,
  type DimAroundOptions,
  type ZoomToOptions,
} from './camera.js';

// Cursor
export {
  cursorHighlight,
  resetCursor,
  type CursorHighlightOptions,
} from './cursor.js';

// TTS
export { type TTSEngineOptions } from './tts/engine.js';
export { engines } from './tts/engines/index.js';

// Subtitles
export { generateSrt, generateVtt } from './subtitles.js';

// Chapters
export { generateChapterMetadata } from './chapters.js';

// Report
export { buildSceneReport, formatSceneReport, type SceneReport } from './report.js';

// Validate
export { validateDemo, type ValidateOptions, type ValidateResult } from './validate.js';

// Doctor
export { runDoctor, formatDoctorResults } from './doctor.js';

// Pipeline
export { runPipeline, runBatchPipeline, discoverDemos, type PipelineOptions } from './pipeline.js';

// Transitions
export { buildTransitionFilters } from './transitions.js';

// Speed Ramp
export { computeSegments, applySpeedRamp } from './speed-ramp.js';

// Progress
export { runFfmpegWithProgress } from './progress.js';

// Dashboard
export { startDashboardServer } from './dashboard.js';

// Clip
export { extractClip, type ClipOptions } from './clip.js';

// Release Prep
export { releasePrep, type ReleasePrepOptions } from './release-prep.js';

// Init
export { init } from './init.js';
