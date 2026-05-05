import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TTSEngine } from './tts/engine.js';
import type { ShaderName } from './transitions/shaders/index.js';
export type { TTSEngine };

// ---- Types ----

export interface TTSConfig {
  defaultVoice: string;
  defaultSpeed: number;
  engine?: TTSEngine;
}

export type BrowserEngine = 'chromium' | 'webkit' | 'firefox';

export interface ShowActionsConfig {
  /** Where to render action labels. Default: 'top-right'. */
  position?: 'top-left' | 'top' | 'top-right' | 'bottom-left' | 'bottom' | 'bottom-right';
  /** Font size in px. Default: 24. */
  fontSize?: number;
  /** How long each annotation persists in ms. Default: 500. */
  duration?: number;
}

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  browser: BrowserEngine;
  deviceScaleFactor: number;
  /** Enable mobile viewport emulation (sets Playwright isMobile). */
  isMobile?: boolean;
  /** Enable touch event emulation (sets Playwright hasTouch). */
  hasTouch?: boolean;
  /** Additional Playwright browser context options (colorScheme, locale, geolocation, permissions, etc.). */
  contextOptions?: Record<string, unknown>;
  /** Auto-annotate Playwright interactions (clicks, fills) with action labels in the recording.
   * Drives `page.screencast.showActions()` from the narration fixture. Off by default. */
  showActions?: boolean | ShowActionsConfig;
  /** Capture a JPEG thumbnail per scene at the moment `narration.mark()` fires.
   * Saved to `.argo/<demo>/thumbs/<scene>.jpg`. Used by the preview scrubber for
   * instant strip rendering. Default: true. */
  sceneThumbnails?: boolean;
  /** Capture every screencast frame as a high-quality JPEG and stitch into the
   * final WebM with ffmpeg, instead of using the engine's VP8 WebM directly.
   * Higher per-frame quality than chromium VP8 and avoids webkit's screencast
   * encoder. Costs ~180 MB/min of intermediate JPEGs during recording.
   * Default: false. */
  captureMode?: 'webm' | 'jpeg-stitch';
  /** JPEG quality (0-100) for the screencast frame stream. Higher = larger
   * intermediates and better stitched video. Default: 95. */
  jpegQuality?: number;
  /** Number of times Playwright will retry the recording test on failure.
   * Default 0 (no retries). Useful for transient browser hiccups (paint stalls,
   * intermittent network, race conditions in showOverlay loops). Each retry
   * re-runs the entire demo from scratch — for long demos consider chunking
   * scenes or using checkpoints (see roadmap v2). CLI override: `--retries N`. */
  retries?: number;
}

export type FilterTransitionType = 'fade-through-black' | 'dissolve' | 'wipe-left' | 'wipe-right';

export interface FilterTransitionConfig {
  type: FilterTransitionType;
  durationMs?: number;
}

export interface ShaderTransitionConfig {
  type: 'shader';
  shader: ShaderName;
  durationMs?: number;
}

export type TransitionConfig = FilterTransitionConfig | ShaderTransitionConfig;

/** @deprecated retained for backward compatibility — prefer FilterTransitionType. */
export type TransitionType = FilterTransitionType;

export interface SpeedRampConfig {
  /** Speed multiplier for gaps between scenes (e.g., 2.0 = 2× faster). Default 1.0 (no change). */
  gapSpeed: number;
  /** Minimum gap duration (ms) before speed ramp is applied. Default 500. */
  minGapMs?: number;
}

export interface AudioConfig {
  /** Apply EBU R128 loudness normalization. Default: false. */
  loudnorm?: boolean;
  /** Path to a background music file (MP3, WAV, etc.) to mix under narration. */
  music?: string;
  /** Music volume level (0.0 to 1.0). Default: 0.15. Mixed at a constant level under narration. */
  musicVolume?: number;
}

export interface WatermarkConfig {
  /** Path to the watermark image (PNG with transparency recommended). */
  src: string;
  /** Corner placement. Default: 'bottom-right'. */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Opacity (0.0 to 1.0). Default: 0.7. */
  opacity?: number;
  /** Margin from edges in pixels. Default: 20. */
  margin?: number;
}

export type BackgroundType = 'solid' | 'gradient' | 'image' | 'auto';

export interface BackgroundConfig {
  /** Type of background.
   * - solid: hex color
   * - gradient: CSS linear-gradient string
   * - image: path to background image
   * - auto: derives a gradient from the video's edge colors */
  type: BackgroundType;
  /** Value depends on type:
   * - solid: hex color string (e.g., '#1a1a2e')
   * - gradient: CSS gradient string (e.g., 'linear-gradient(135deg, #667eea, #764ba2)')
   * - image: path to background image file
   * - auto: ignored (colors are probed from video) */
  value?: string;
}

export interface FrameConfig {
  /** Padding around the recording in pixels. Default: 40. */
  padding?: number;
  /** Border radius for rounded corners in pixels. Default: 12. 0 disables rounding. */
  borderRadius?: number;
  /** Drop shadow intensity (0.0 to 1.0). Default: 0.5. 0 disables shadow. */
  shadow?: number;
  /** Shadow color as hex string. Default: '#000000'. */
  shadowColor?: string;
  /** Background behind the framed recording. Default: solid black (#000000). */
  background?: BackgroundConfig;
}

export interface VariantConfig {
  /** Variant name — used in output filename (e.g., 'vertical' → showcase.vertical.mp4). */
  name: string;
  /** Video dimensions for this variant. The demo script runs identically — only viewport changes. */
  video: { width: number; height: number };
}

export interface ExportConfig {
  preset: string;
  crf: number;
  thumbnailPath?: string;
  formats?: Array<'1:1' | '9:16' | 'gif'>;
  /** Scene transition applied between scenes during export. */
  transition?: TransitionConfig;
  /** Speed up gaps between scenes. */
  speedRamp?: SpeedRampConfig;
  /** Audio post-processing options. */
  audio?: AudioConfig;
  /** Viewport-native variants — re-record at different viewports for each format.
   * TTS runs once, then pipeline records + exports per variant.
   * Much better than blur-fill/crop for responsive content. */
  variants?: VariantConfig[];
  /** Overlay a watermark/brand bug image on the exported video. */
  watermark?: WatermarkConfig;
  /** Apply contrast-adaptive sharpening (CAS) to restore text crispness.
   * `true` uses default strength (0.5). Pass `{ strength: 0.0-1.0 }` to tune. */
  sharpen?: boolean | { strength: number };
  /** Frame the recording with padding, rounded corners, drop shadow, and a background.
   * Creates the polished "Screen Studio" look. */
  frame?: FrameConfig;
  /** Apply motion blur during camera move transitions.
   * `true` uses default intensity (0.5). Pass `{ intensity: 0.0-1.0 }` to tune.
   * Only takes effect when cameraMoves are present. */
  motionBlur?: boolean | { intensity: number };
  /** Final-encode preference. `'cpu'` uses libx264 (slower but cleaner dark
   * regions via `aq-mode=3`); `'gpu'` uses the platform's hardware encoder
   * (faster but videotoolbox in particular can introduce watercolor banding).
   *
   * Defaults: `argo pipeline` and `argo export` default to `'cpu'` for max
   * quality on a one-shot run; `argo preview`'s re-export defaults to `'gpu'`
   * for fast iteration. The `ARGO_USE_GPU` env var still wins as an override. */
  encoder?: 'cpu' | 'gpu';
}

export interface OverlayConfig {
  autoBackground: boolean;
  defaultPlacement?: 'bottom-center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  /** Enable the `motion.raw` escape hatch for GSAP motions. Off by default —
   *  raw is executed via `new Function()` on the page, same blast radius as
   *  config files themselves. Only enable if you trust your manifest sources. */
  allowRawGsap?: boolean;
}

export interface ArgoConfig {
  baseURL?: string;
  demosDir: string;
  outputDir: string;
  tts: TTSConfig;
  video: VideoConfig;
  export: ExportConfig;
  overlays: OverlayConfig;
}

export type UserConfig = Partial<
  Omit<ArgoConfig, 'tts' | 'video' | 'export' | 'overlays'> & {
    tts: Partial<TTSConfig>;
    video: Partial<VideoConfig>;
    export: Partial<ExportConfig>;
    overlays: Partial<OverlayConfig>;
  }
>;

// ---- Defaults ----

const DEFAULTS: ArgoConfig = {
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 1920, height: 1080, fps: 30, browser: 'chromium' as BrowserEngine, deviceScaleFactor: 1 },
  export: { preset: 'slow', crf: 16 },
  overlays: { autoBackground: false },
};

// ---- Functions ----

export function normalizeDeviceScaleFactor(rawScale?: number): number {
  const scale = typeof rawScale === 'number' && Number.isFinite(rawScale) ? rawScale : 1;
  return Math.max(1, Math.round(scale));
}

export function defineConfig(userConfig: UserConfig): ArgoConfig {
  const video = {
    ...DEFAULTS.video,
    ...userConfig.video,
  };
  video.deviceScaleFactor = normalizeDeviceScaleFactor(video.deviceScaleFactor);

  return {
    ...DEFAULTS,
    ...userConfig,
    tts: { ...DEFAULTS.tts, ...userConfig.tts },
    video,
    export: { ...DEFAULTS.export, ...userConfig.export },
    overlays: { ...DEFAULTS.overlays, ...userConfig.overlays },
  };
}

export function demosProject(options: {
  baseURL: string;
  demosDir?: string;
  browser?: BrowserEngine;
  deviceScaleFactor?: number;
  video?: { width: number; height: number };
}) {
  const scale = normalizeDeviceScaleFactor(options.deviceScaleFactor);
  const width = options.video?.width ?? 1920;
  const height = options.video?.height ?? 1080;
  return {
    name: 'demos',
    testDir: options.demosDir ?? 'demos',
    testMatch: '**/*.demo.ts',
    use: {
      browserName: options.browser ?? 'chromium',
      baseURL: options.baseURL,
      viewport: { width, height },
      deviceScaleFactor: scale,
      video: {
        mode: 'on' as const,
        size: { width: width * scale, height: height * scale },
      },
    },
  };
}

const CONFIG_FILENAMES = [
  'argo.config.ts',
  'argo.config.js',
  'argo.config.mjs',
];

const DEMO_CONFIG_EXTENSIONS = ['.config.ts', '.config.js', '.config.mjs'];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw new Error(`Cannot access ${filePath}: ${err.message}`);
  }
}

/**
 * Locate a demo-scoped config file if one exists.
 * Searches `<demosDir>/<demoName>.config.{ts,js,mjs}` in order.
 * Returns the absolute path, or undefined if none found.
 *
 * `demosDir` defaults to `demos/` under cwd; callers that've resolved a
 * different demos directory should pass it explicitly.
 */
export async function resolveDemoConfigPath(
  cwd: string,
  demoName: string,
  demosDir = 'demos',
): Promise<string | undefined> {
  for (const ext of DEMO_CONFIG_EXTENSIONS) {
    const candidate = join(cwd, demosDir, `${demoName}${ext}`);
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<ArgoConfig> {
  let configPath: string | undefined = explicitPath;

  if (!configPath) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(cwd, filename);
      if (await fileExists(candidate)) {
        configPath = candidate;
        break;
      }
    }
  }

  if (!configPath) {
    return defineConfig({});
  }

  let mod: any;
  try {
    const fileUrl = pathToFileURL(configPath).href;
    mod = await import(fileUrl);
  } catch (err) {
    throw new Error(`Failed to load config from ${configPath}: ${(err as Error).message}`);
  }
  const userConfig: UserConfig = mod.default !== undefined ? mod.default : mod;
  if (typeof userConfig !== 'object' || userConfig === null || Array.isArray(userConfig)) {
    throw new Error(
      `Config file ${configPath} must export a plain object. ` +
      `Got ${Array.isArray(userConfig) ? 'array' : typeof userConfig}. ` +
      `Use: export default { baseURL: "...", ... }`
    );
  }
  return defineConfig(userConfig);
}
