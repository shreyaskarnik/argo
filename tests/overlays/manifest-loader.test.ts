import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOverlayFromManifest, resetManifestCache } from '../../src/overlays/manifest-loader.js';
import type { SceneEntry } from '../../src/overlays/types.js';

describe('loadOverlayFromManifest', () => {
  let tmpDir: string;
  const originalEnv = process.env.ARGO_OVERLAYS_PATH;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'argo-manifest-loader-'));
    resetManifestCache();
    delete process.env.ARGO_OVERLAYS_PATH;
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    resetManifestCache();
    if (originalEnv !== undefined) {
      process.env.ARGO_OVERLAYS_PATH = originalEnv;
    } else {
      delete process.env.ARGO_OVERLAYS_PATH;
    }
  });

  it('returns overlay cue from scenes.json for a matching scene', () => {
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    const entries: SceneEntry[] = [
      {
        scene: 'intro',
        text: 'Welcome to the demo.',
        overlay: { type: 'lower-third', text: 'Introduction' },
      },
      {
        scene: 'features',
        text: 'Here are the features.',
        overlay: { type: 'headline-card', title: 'Key Features' },
      },
    ];
    writeFileSync(manifestPath, JSON.stringify(entries));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    const result = loadOverlayFromManifest('intro');
    expect(result).toEqual({ type: 'lower-third', text: 'Introduction' });
  });

  it('returns undefined for a scene without overlay', () => {
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    const entries: SceneEntry[] = [
      { scene: 'intro', text: 'Welcome.' },
      { scene: 'features', text: 'Features here.', overlay: { type: 'callout', text: 'New!' } },
    ];
    writeFileSync(manifestPath, JSON.stringify(entries));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    const result = loadOverlayFromManifest('intro');
    expect(result).toBeUndefined();
  });

  it('returns undefined when env var is not set', () => {
    // ARGO_OVERLAYS_PATH is not set (deleted in beforeEach)
    const result = loadOverlayFromManifest('intro');
    expect(result).toBeUndefined();
  });

  it('returns undefined for a scene not in the manifest', () => {
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    const entries: SceneEntry[] = [
      { scene: 'intro', text: 'Welcome.', overlay: { type: 'lower-third', text: 'Intro' } },
    ];
    writeFileSync(manifestPath, JSON.stringify(entries));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    const result = loadOverlayFromManifest('nonexistent');
    expect(result).toBeUndefined();
  });

  it('caches the manifest after first load', () => {
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    const entries: SceneEntry[] = [
      { scene: 'intro', text: 'Welcome.', overlay: { type: 'lower-third', text: 'Intro' } },
    ];
    writeFileSync(manifestPath, JSON.stringify(entries));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    // First load
    const result1 = loadOverlayFromManifest('intro');
    expect(result1).toEqual({ type: 'lower-third', text: 'Intro' });

    // Overwrite the file with different content
    const updatedEntries: SceneEntry[] = [
      { scene: 'intro', text: 'Updated.', overlay: { type: 'callout', text: 'Updated overlay' } },
    ];
    writeFileSync(manifestPath, JSON.stringify(updatedEntries));

    // Second load should return cached result, not updated file
    const result2 = loadOverlayFromManifest('intro');
    expect(result2).toEqual({ type: 'lower-third', text: 'Intro' });
  });
});
