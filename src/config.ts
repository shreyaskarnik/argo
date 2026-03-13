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

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
}

export interface ExportConfig {
  preset: string;
  crf: number;
}

export interface OverlayConfig {
  autoBackground: boolean;
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
  video: { width: 1920, height: 1080, fps: 30 },
  export: { preset: 'slow', crf: 16 },
  overlays: { autoBackground: false },
};

// ---- Functions ----

export function defineConfig(userConfig: UserConfig): ArgoConfig {
  return {
    ...DEFAULTS,
    ...userConfig,
    tts: { ...DEFAULTS.tts, ...userConfig.tts },
    video: { ...DEFAULTS.video, ...userConfig.video },
    export: { ...DEFAULTS.export, ...userConfig.export },
    overlays: { ...DEFAULTS.overlays, ...userConfig.overlays },
  };
}

export function demosProject(options: {
  baseURL: string;
  demosDir?: string;
}) {
  return {
    name: 'demos',
    testDir: options.demosDir ?? 'demos',
    testMatch: '**/*.demo.ts',
    use: {
      baseURL: options.baseURL,
      video: 'on' as const,
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
  const userConfig: UserConfig = mod.default ?? mod;
  return defineConfig(userConfig);
}
