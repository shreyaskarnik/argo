import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- Types ----

export interface TTSEngine {
  generate(
    text: string,
    options: { voice?: string; speed?: number; lang?: string },
  ): Promise<Buffer>;
}

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

export interface ArgoConfig {
  baseURL?: string;
  demosDir: string;
  outputDir: string;
  tts: TTSConfig;
  video: VideoConfig;
  export: ExportConfig;
}

export type UserConfig = Partial<
  Omit<ArgoConfig, 'tts' | 'video' | 'export'> & {
    tts: Partial<TTSConfig>;
    video: Partial<VideoConfig>;
    export: Partial<ExportConfig>;
  }
>;

// ---- Defaults ----

const DEFAULTS: ArgoConfig = {
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 2560, height: 1440, fps: 30 },
  export: { preset: 'slow', crf: 16 },
};

// ---- Functions ----

export function defineConfig(userConfig: UserConfig): ArgoConfig {
  return {
    ...DEFAULTS,
    ...userConfig,
    tts: { ...DEFAULTS.tts, ...userConfig.tts },
    video: { ...DEFAULTS.video, ...userConfig.video },
    export: { ...DEFAULTS.export, ...userConfig.export },
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

  const fileUrl = pathToFileURL(configPath).href;
  const mod = await import(fileUrl);
  const userConfig: UserConfig = mod.default ?? mod;
  return defineConfig(userConfig);
}
