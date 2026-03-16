import { readFileSync, existsSync } from 'node:fs';
import type { OverlayCue, SceneEntry } from './types.js';

let cachedManifest: SceneEntry[] | null = null;

export function resetManifestCache(): void {
  cachedManifest = null;
}

function getManifest(): SceneEntry[] | null {
  if (cachedManifest !== null) return cachedManifest;
  const manifestPath = process.env.ARGO_OVERLAYS_PATH;
  if (!manifestPath || !existsSync(manifestPath)) return null;
  cachedManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SceneEntry[];
  return cachedManifest;
}

export function loadOverlayFromManifest(scene: string): OverlayCue | undefined {
  const manifest = getManifest();
  if (!manifest) return undefined;
  const entry = manifest.find((e) => e.scene === scene);
  return entry?.overlay;
}
