import { existsSync, readFileSync } from 'node:fs';
import { schedulePlacements, type Placement, type SceneTiming } from './tts/align.js';
import { ClipCache, type ManifestEntry } from './tts/cache.js';
import { parseWavHeader } from './tts/engine.js';

export interface SceneManifestEntry {
  scene: string;
  text?: string;
  voice?: string;
  speed?: number;
  lang?: string;
  [key: string]: unknown;
}

export function readScenesManifest(manifestPath: string): SceneManifestEntry[] {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Manifest ${manifestPath} must contain a JSON array`);
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as { scene?: unknown }).scene !== 'string') {
      throw new Error(`Manifest ${manifestPath} contains an entry without a valid scene name`);
    }
    return entry as SceneManifestEntry;
  });
}

export function buildSceneTexts(entries: SceneManifestEntry[]): Record<string, string> {
  const sceneTexts: Record<string, string> = {};
  for (const entry of entries) {
    if (typeof entry.text === 'string' && entry.text.trim().length > 0) {
      sceneTexts[entry.scene] = entry.text;
    }
  }
  return sceneTexts;
}

export function buildSceneDurationsFromCache(
  demoName: string,
  entries: SceneManifestEntry[],
  defaults: { voice?: string; speed?: number },
  projectRoot = '.',
): Record<string, number> {
  const cache = new ClipCache(projectRoot);
  const sceneDurations: Record<string, number> = {};

  for (const entry of entries) {
    if (typeof entry.text !== 'string' || entry.text.trim().length === 0) continue;

    const cacheEntry: ManifestEntry = {
      scene: entry.scene,
      text: entry.text,
      voice: entry.voice ?? defaults.voice,
      speed: entry.speed ?? defaults.speed,
      lang: entry.lang,
    };
    const clipPath = cache.getClipPath(demoName, cacheEntry);
    if (!existsSync(clipPath)) continue;

    const wavBuf = readFileSync(clipPath);
    sceneDurations[entry.scene] = parseWavHeader(wavBuf).durationMs;
  }

  return sceneDurations;
}

export function computeHeadTrimMs(
  timing: SceneTiming,
  leadInMs = 200,
  minTrimMs = 500,
): number {
  const markTimes = Object.values(timing);
  if (markTimes.length === 0) return 0;

  const firstMarkMs = Math.min(...markTimes);
  const headTrimMs = Math.max(0, firstMarkMs - leadInMs);
  return headTrimMs <= minTrimMs ? 0 : headTrimMs;
}

export function buildPlacementsFromTimingAndDurations(
  timing: SceneTiming,
  sceneDurations: Record<string, number>,
  totalDurationMs: number,
): Placement[] {
  const voicedPlacements = schedulePlacements(
    Object.entries(timing)
      .filter(([scene]) => (sceneDurations[scene] ?? 0) > 0)
      .map(([scene, startMs]) => ({
        scene,
        startMs,
        durationMs: sceneDurations[scene],
      })),
  );

  const voicedScenes = new Set(voicedPlacements.map((p) => p.scene));
  const sortedMarks = Object.entries(timing).sort((a, b) => a[1] - b[1]);
  const silentPlacements = sortedMarks.flatMap(([scene, startMs], index) => {
    if (voicedScenes.has(scene)) return [];
    const endMs = index + 1 < sortedMarks.length ? sortedMarks[index + 1][1] : totalDurationMs;
    return [{ scene, startMs, endMs }];
  });

  return [...voicedPlacements, ...silentPlacements].sort((a, b) => a.startMs - b.startMs);
}

export function shiftPlacements(placements: Placement[], offsetMs: number): Placement[] {
  if (offsetMs <= 0) return placements;
  return placements.map((placement) => ({
    ...placement,
    startMs: Math.max(0, placement.startMs - offsetMs),
    endMs: Math.max(0, placement.endMs - offsetMs),
  }));
}
