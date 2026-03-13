import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createWavBuffer } from '../../src/tts/engine.js';
import { ClipCache, type ManifestEntry } from '../../src/tts/cache.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argo-cache-test-'));
}

function makeHash(entry: ManifestEntry): string {
  const { scene, text, voice, speed } = entry;
  return crypto.createHash('sha256').update(JSON.stringify({ scene, text, voice, speed })).digest('hex');
}

describe('ClipCache', () => {
  let tmpDir: string;
  let cache: ClipCache;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cache = new ClipCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const entry: ManifestEntry = { scene: 'intro', text: 'Hello world' };
  const demoName = 'demo1';

  function makeWav(): Buffer {
    return createWavBuffer(new Float32Array([0.1, 0.2, 0.3]));
  }

  describe('isCached', () => {
    it('returns false when not cached', () => {
      expect(cache.isCached(demoName, entry)).toBe(false);
    });

    it('returns true after caching', () => {
      cache.cacheClip(demoName, entry, makeWav());
      expect(cache.isCached(demoName, entry)).toBe(true);
    });
  });

  describe('getCachedClip', () => {
    it('returns null when not cached', () => {
      expect(cache.getCachedClip(demoName, entry)).toBeNull();
    });

    it('returns buffer when cached', () => {
      const wav = makeWav();
      cache.cacheClip(demoName, entry, wav);
      const result = cache.getCachedClip(demoName, entry);
      expect(result).not.toBeNull();
      expect(Buffer.compare(result!, wav)).toBe(0);
    });
  });

  describe('cacheClip', () => {
    it('creates directory structure and writes file named by hash', () => {
      const wav = makeWav();
      cache.cacheClip(demoName, entry, wav);

      const hash = makeHash(entry);
      const expectedPath = path.join(tmpDir, '.argo', demoName, 'clips', `${hash}.wav`);
      expect(fs.existsSync(expectedPath)).toBe(true);

      const contents = fs.readFileSync(expectedPath);
      expect(Buffer.compare(contents, wav)).toBe(0);
    });
  });

  describe('getClipPath', () => {
    it('returns correct path', () => {
      const hash = makeHash(entry);
      const expected = path.join(tmpDir, '.argo', demoName, 'clips', `${hash}.wav`);
      expect(cache.getClipPath(demoName, entry)).toBe(expected);
    });
  });

  describe('invalidation', () => {
    it('different text produces different hash', () => {
      const entry2: ManifestEntry = { scene: 'intro', text: 'Goodbye world' };
      expect(cache.getClipPath(demoName, entry)).not.toBe(cache.getClipPath(demoName, entry2));
    });

    it('different voice produces different hash', () => {
      const entry2: ManifestEntry = { scene: 'intro', text: 'Hello world', voice: 'alloy' };
      expect(cache.getClipPath(demoName, entry)).not.toBe(cache.getClipPath(demoName, entry2));
    });

    it('different speed produces different hash', () => {
      const entry2: ManifestEntry = { scene: 'intro', text: 'Hello world', speed: 1.5 };
      expect(cache.getClipPath(demoName, entry)).not.toBe(cache.getClipPath(demoName, entry2));
    });
  });

  describe('independent per demo name', () => {
    it('caching under one demo does not affect another', () => {
      const wav = makeWav();
      cache.cacheClip('demoA', entry, wav);
      expect(cache.isCached('demoA', entry)).toBe(true);
      expect(cache.isCached('demoB', entry)).toBe(false);
    });
  });
});
