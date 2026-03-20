import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TTSEngine } from './tts/engine.js';
export type { TTSEngine };

// ---- Types ----

export interface TTSConfig {
  defaultVoice: string;
  defaultSpeed: number;
  engine?: TTSEngine;
}

export type BrowserEngine = 'chromium' | 'webkit' | 'firefox';

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
}

export type TransitionType = 'fade-through-black' | 'dissolve' | 'wipe-left' | 'wipe-right';

export interface TransitionConfig {
  /** Transition type applied between scenes. */
  type: TransitionType;
  /** Duration of the transition in milliseconds (default 500). */
  durationMs?: number;
}

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
}

export interface OverlayConfig {
  autoBackground: boolean;
  defaultPlacement?: 'bottom-center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    throw new Error(`Cannot access ${filePath}: ${err.message}`);
  }
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
