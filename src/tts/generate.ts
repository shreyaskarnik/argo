/**
 * TTS clip generation with manifest parsing and cache integration.
 */

import fs from 'node:fs';
import type { TTSEngine } from './engine.js';
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
}

export async function generateClips(options: GenerateClipsOptions): Promise<ClipResult[]> {
  const { manifestPath, demoName, engine, projectRoot, defaults } = options;

  // 1. Check manifest exists
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Manifest file not found');
  }

  // 2. Read and parse JSON
  let rawEntries: unknown[];
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    rawEntries = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error('Failed to parse manifest');
    }
    throw err;
  }

  if (!Array.isArray(rawEntries)) {
    throw new Error('Failed to parse manifest');
  }

  // 3. Validate entries
  for (const entry of rawEntries) {
    const e = entry as Record<string, unknown>;
    if (typeof e.scene !== 'string' || typeof e.text !== 'string') {
      throw new Error('Manifest entry missing required field: scene and text are required');
    }
  }

  const cache = new ClipCache(projectRoot);
  const results: ClipResult[] = [];

  for (const raw of rawEntries) {
    const r = raw as Record<string, unknown>;

    // 4. Build ManifestEntry with defaults
    const manifestEntry: ManifestEntry = {
      scene: r.scene as string,
      text: r.text as string,
      voice: (r.voice as string | undefined) ?? defaults?.voice,
      speed: (r.speed as number | undefined) ?? defaults?.speed,
    };

    const clipPath = cache.getClipPath(demoName, manifestEntry);

    // 5/6. Check cache or generate
    if (!cache.isCached(demoName, manifestEntry)) {
      const wavBuffer = await engine.generate(manifestEntry.text, {
        voice: manifestEntry.voice,
        speed: manifestEntry.speed,
      });
      cache.cacheClip(demoName, manifestEntry, wavBuffer);
    }

    results.push({ scene: manifestEntry.scene, clipPath });
  }

  return results;
}
