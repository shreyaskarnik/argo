import { describe, it, expect, afterEach } from 'vitest';
import { loadOverlayManifest, hasImageAssets, resolveAssetURLs } from '../../src/overlays/manifest.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('loadOverlayManifest', () => {
  let tmpDir: string;

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), 'argo-manifest-'));
  }

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when file does not exist', async () => {
    setup();
    const result = await loadOverlayManifest(join(tmpDir, 'missing.scenes.json'));
    expect(result).toBeNull();
  });

  it('parses a valid scenes.json manifest and extracts overlay entries', async () => {
    setup();
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    writeFileSync(manifestPath, JSON.stringify([
      { scene: 'intro', text: 'Hello', overlay: { type: 'lower-third', text: 'Hello' } },
      { scene: 'mid', text: 'Middle', overlay: { type: 'headline-card', title: 'Title', placement: 'top-left' } },
    ]));
    const result = await loadOverlayManifest(manifestPath);
    expect(result).toHaveLength(2);
    expect(result![0].scene).toBe('intro');
    expect(result![1].type).toBe('headline-card');
  });

  it('skips scenes without an overlay field', async () => {
    setup();
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    writeFileSync(manifestPath, JSON.stringify([
      { scene: 'intro', text: 'Hello' },
      { scene: 'mid', text: 'Middle', overlay: { type: 'lower-third', text: 'Mid' } },
    ]));
    const result = await loadOverlayManifest(manifestPath);
    expect(result).toHaveLength(1);
    expect(result![0].scene).toBe('mid');
  });

  it('returns empty array when no scenes have overlays', async () => {
    setup();
    const manifestPath = join(tmpDir, 'demo.scenes.json');
    writeFileSync(manifestPath, JSON.stringify([
      { scene: 'intro', text: 'Hello' },
      { scene: 'mid', text: 'Middle' },
    ]));
    const result = await loadOverlayManifest(manifestPath);
    expect(result).toEqual([]);
  });

  it('throws on invalid JSON', async () => {
    setup();
    const manifestPath = join(tmpDir, 'bad.scenes.json');
    writeFileSync(manifestPath, '{ nope }}}');
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('Failed to parse overlay manifest');
  });

  it('throws when manifest is not an array', async () => {
    setup();
    const manifestPath = join(tmpDir, 'obj.scenes.json');
    writeFileSync(manifestPath, JSON.stringify({ scene: 'x' }));
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('must contain a JSON array');
  });
});

describe('hasImageAssets', () => {
  it('returns true when entries contain image-card', () => {
    expect(hasImageAssets([
      { scene: 'x', type: 'image-card', src: 'img.png' },
    ] as any)).toBe(true);
  });

  it('returns false when no image-card entries', () => {
    expect(hasImageAssets([
      { scene: 'x', type: 'lower-third', text: 'Hi' },
    ] as any)).toBe(false);
  });
});

describe('resolveAssetURLs', () => {
  it('prefixes relative image-card src with asset server URL', () => {
    const entries = [
      { scene: 'x', type: 'image-card' as const, src: 'assets/diagram.png' },
    ];
    const resolved = resolveAssetURLs(entries as any, 'http://127.0.0.1:9999');
    expect(resolved[0]).toHaveProperty('src', 'http://127.0.0.1:9999/diagram.png');
  });

  it('leaves absolute URLs unchanged', () => {
    const entries = [
      { scene: 'x', type: 'image-card' as const, src: 'http://example.com/img.png' },
    ];
    const resolved = resolveAssetURLs(entries as any, 'http://127.0.0.1:9999');
    expect(resolved[0]).toHaveProperty('src', 'http://example.com/img.png');
  });

  it('leaves non-image-card entries unchanged', () => {
    const entries = [
      { scene: 'x', type: 'lower-third' as const, text: 'Hello' },
    ];
    const resolved = resolveAssetURLs(entries as any, 'http://127.0.0.1:9999');
    expect(resolved[0]).toEqual(entries[0]);
  });
});
