/**
 * TTS clip generation with manifest parsing and cache integration.
 */

import fs from 'node:fs';
import type { TTSEngine } from './engine.js';
import { parseWavHeader } from './engine.js';
import { ClipCache, type ManifestEntry } from './cache.js';

export interface GenerateClipsOptions {
  manifestPath: string;
  demoName: string;
  engine: TTSEngine;
  projectRoot: string;
  defaults?: { voice?: string; speed?: number };
}

export interface ClipResult {
  scene: string;
  clipPath: string;
  durationMs: number;
}

export async function generateClips(options: GenerateClipsOptions): Promise<ClipResult[]> {
  const { manifestPath, demoName, engine, projectRoot, defaults } = options;

  // 1. Check manifest exists
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  // 2. Read and parse JSON
  let rawEntries: unknown[];
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    rawEntries = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse manifest ${manifestPath}: ${err.message}`);
    }
    throw err;
  }

  if (!Array.isArray(rawEntries)) {
    throw new Error(`Manifest ${manifestPath} must contain a JSON array`);
  }

  // 3. Validate entries
  for (const entry of rawEntries) {
    const e = entry as Record<string, unknown>;
    if (typeof e.scene !== 'string' || typeof e.text !== 'string') {
      throw new Error('Manifest entry missing required field: scene and text are required');
    }
  }

  const cache = new ClipCache(projectRoot);

  // Build manifest entries with defaults
  const entries: { entry: ManifestEntry; clipPath: string }[] = rawEntries.map((raw) => {
    const r = raw as Record<string, unknown>;
    const entry: ManifestEntry = {
      scene: r.scene as string,
      text: r.text as string,
      voice: (r.voice as string | undefined) ?? defaults?.voice,
      speed: (r.speed as number | undefined) ?? defaults?.speed,
      lang: r.lang as string | undefined,
    };
    return { entry, clipPath: cache.getClipPath(demoName, entry) };
  });

  // Generate uncached clips sequentially — Kokoro's ONNX runtime is not
  // safe for concurrent generate() calls (mutex errors). The shared init
  // promise prevents duplicate model downloads, but generation must serialize.
  const uncached = entries.filter(({ entry }) => !cache.isCached(demoName, entry));
  for (const { entry } of uncached) {
    const wavBuffer = await engine.generate(entry.text, {
      voice: entry.voice,
      speed: entry.speed,
      lang: entry.lang,
    });
    cache.cacheClip(demoName, entry, wavBuffer);
  }

  // Read results (all clips now cached)
  return entries.map(({ entry, clipPath }) => {
    const wavBuf = fs.readFileSync(clipPath);
    const { durationMs } = parseWavHeader(wavBuf);
    return { scene: entry.scene, clipPath, durationMs };
  });
}
