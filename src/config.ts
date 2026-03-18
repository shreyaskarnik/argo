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

export interface ExportConfig {
  preset: string;
  crf: number;
  thumbnailPath?: string;
  formats?: Array<'1:1' | '9:16'>;
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
