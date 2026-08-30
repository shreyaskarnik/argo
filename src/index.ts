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
  type VariantConfig,
  type AudioConfig,
  type WatermarkConfig,
  type FrameConfig,
  type BackgroundConfig,
  type BackgroundType,
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

// Overlay PNG rendering (for imported videos)
export {
  renderOverlaysToPng,
  buildOverlayPngFilters,
  buildOverlayPngsForImport,
  isImportedVideo,
  type RenderedOverlayPng,
  type OverlayPngInput,
} from './overlays/render-to-png.js';

// Effects
export { showConfetti, type ConfettiOptions } from './effects.js';

// Hyperframes component injection
export {
  applyComponent,
  removeComponent,
  type ApplyComponentOptions,
} from './hf/apply-component.js';

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
  trackCursor,
} from './camera.js';

// Narration (cursor telemetry types)
export type { CursorSample } from './narration.js';

// Cursor
export {
  cursorHighlight,
  resetCursor,
  type CursorHighlightOptions,
} from './cursor.js';

// Composition — embed a self-contained HTML composition as an Argo scene.
// Follows hyperframes' contract (data-composition-id + paused master timeline
// + ready signal) so a composition that runs in hyperframes runs unchanged
// in Argo. Argo adds `window.__argoVideoSrc` so compositions can wrap an
// Argo recording (e.g. 3D device frame textured via html-in-canvas).
export {
  renderComposition,
  readCompositionDuration,
  type RenderCompositionOptions,
} from './composition.js';

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
export { computeSegments, applySpeedRamp, type SceneSpeedMap } from './speed-ramp.js';

// Freeze
export {
  buildFreezeFilter,
  resolveFreezes,
  adjustPlacementsForFreezes,
  totalFreezeDurationMs,
  type FreezeSpec,
  type ResolvedFreeze,
} from './freeze.js';

// Camera Moves
export { buildCameraMoveFilter, buildMotionBlurFilter, detectChainedPairs, shiftCameraMoves, scaleCameraMoves, type CameraMove } from './camera-move.js';

// Frame
export { buildFrameFilter, generateFramePng, type FrameFilterResult } from './frame.js';

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

// Media utilities
export { getVideoDurationMs, getVideoFrameRate, getVideoDimensions, detectVideoTheme } from './media.js';

// Import
export { importVideo, type ImportOptions, type ImportResult } from './import.js';

// Music Generation
export { generateMusic, generateMusicCached, type MusicGenOptions } from './music/musicgen.js';
