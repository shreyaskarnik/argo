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
    const result = await loadOverlayManifest(join(tmpDir, 'missing.overlays.json'));
    expect(result).toBeNull();
  });

  it('parses a valid manifest', async () => {
    setup();
    const manifestPath = join(tmpDir, 'demo.overlays.json');
    writeFileSync(manifestPath, JSON.stringify([
      { scene: 'intro', type: 'lower-third', text: 'Hello' },
      { scene: 'mid', type: 'headline-card', title: 'Title', placement: 'top-left' },
    ]));
    const result = await loadOverlayManifest(manifestPath);
    expect(result).toHaveLength(2);
    expect(result![0].scene).toBe('intro');
    expect(result![1].type).toBe('headline-card');
  });

  it('throws on invalid JSON', async () => {
    setup();
    const manifestPath = join(tmpDir, 'bad.overlays.json');
    writeFileSync(manifestPath, '{ nope }}}');
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('Failed to parse overlay manifest');
  });

  it('throws when manifest is not an array', async () => {
    setup();
    const manifestPath = join(tmpDir, 'obj.overlays.json');
    writeFileSync(manifestPath, JSON.stringify({ scene: 'x' }));
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('must contain a JSON array');
  });

  it('throws on entry missing scene', async () => {
    setup();
    const manifestPath = join(tmpDir, 'no-scene.overlays.json');
    writeFileSync(manifestPath, JSON.stringify([{ type: 'lower-third', text: 'Hi' }]));
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('missing required field "scene"');
  });

  it('throws on entry missing type', async () => {
    setup();
    const manifestPath = join(tmpDir, 'no-type.overlays.json');
    writeFileSync(manifestPath, JSON.stringify([{ scene: 'x', text: 'Hi' }]));
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('missing required field "type"');
  });

  it('throws on unknown template type', async () => {
    setup();
    const manifestPath = join(tmpDir, 'bad-type.overlays.json');
    writeFileSync(manifestPath, JSON.stringify([{ scene: 'x', type: 'banner', text: 'Hi' }]));
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('unknown overlay type "banner"');
  });

  it('throws on unknown zone', async () => {
    setup();
    const manifestPath = join(tmpDir, 'bad-zone.overlays.json');
    writeFileSync(manifestPath, JSON.stringify([
      { scene: 'x', type: 'lower-third', text: 'Hi', placement: 'middle' },
    ]));
    await expect(loadOverlayManifest(manifestPath)).rejects.toThrow('unknown placement "middle"');
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
