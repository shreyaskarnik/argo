import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { OverlayManifestEntry, SceneEntry } from './types.js';

export async function loadOverlayManifest(
  manifestPath: string,
): Promise<OverlayManifestEntry[] | null> {
  if (!existsSync(manifestPath)) return null;

  const raw = await readFile(manifestPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse overlay manifest ${manifestPath}: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Overlay manifest ${manifestPath} must contain a JSON array`);
  }

  // Extract overlay entries from unified .scenes.json format (overlay nested under entry.overlay)
  const entries: OverlayManifestEntry[] = [];
  for (const entry of parsed as SceneEntry[]) {
    if (entry.overlay && entry.scene) {
      entries.push({ ...entry.overlay, scene: entry.scene } as OverlayManifestEntry);
    }
  }

  return entries;
}

export function hasImageAssets(entries: OverlayManifestEntry[]): boolean {
  return entries.some((e) => e.type === 'image-card');
}

export function resolveAssetURLs(
  entries: OverlayManifestEntry[],
  assetBaseURL: string,
): OverlayManifestEntry[] {
  return entries.map((e) => {
    if (e.type === 'image-card' && e.src && !e.src.startsWith('http')) {
      return { ...e, src: `${assetBaseURL}/${e.src.replace(/^assets\//, '')}` };
    }
    return e;
  });
}
