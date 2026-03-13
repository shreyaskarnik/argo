import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { OverlayManifestEntry } from './types.js';
import { isValidTemplateType, isValidZone, isValidMotion } from './types.js';

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

  const entries: OverlayManifestEntry[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const prefix = `Overlay manifest entry ${i}`;

    if (!entry.scene || typeof entry.scene !== 'string') {
      throw new Error(`${prefix}: missing required field "scene"`);
    }
    if (!entry.type || typeof entry.type !== 'string') {
      throw new Error(`${prefix}: missing required field "type"`);
    }
    if (!isValidTemplateType(entry.type)) {
      throw new Error(`${prefix}: unknown overlay type "${entry.type}"`);
    }
    if (entry.placement && !isValidZone(entry.placement)) {
      throw new Error(`${prefix}: unknown placement "${entry.placement}"`);
    }
    if (entry.motion && !isValidMotion(entry.motion)) {
      throw new Error(`${prefix}: unknown motion "${entry.motion}"`);
    }

    entries.push(entry as OverlayManifestEntry);
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
