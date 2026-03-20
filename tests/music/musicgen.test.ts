import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeCacheKey,
  getCachePath,
  isCached,
  generateMusicCached,
  type MusicGenOptions,
} from '../../src/music/musicgen.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argo-musicgen-test-'));
}

describe('MusicGen', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('computeCacheKey', () => {
    it('returns a hex string', () => {
      const key = computeCacheKey({ prompt: 'lofi chill' });
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same options', () => {
      const opts: MusicGenOptions = { prompt: 'ambient piano', durationSec: 20 };
      expect(computeCacheKey(opts)).toBe(computeCacheKey(opts));
    });

    it('differs when prompt changes', () => {
      const a = computeCacheKey({ prompt: 'lofi chill' });
      const b = computeCacheKey({ prompt: 'epic orchestral' });
      expect(a).not.toBe(b);
    });

    it('differs when duration changes', () => {
      const a = computeCacheKey({ prompt: 'lofi', durationSec: 30 });
      const b = computeCacheKey({ prompt: 'lofi', durationSec: 60 });
      expect(a).not.toBe(b);
    });

    it('differs when guidanceScale changes', () => {
      const a = computeCacheKey({ prompt: 'lofi', guidanceScale: 3 });
      const b = computeCacheKey({ prompt: 'lofi', guidanceScale: 5 });
      expect(a).not.toBe(b);
    });

    it('differs when temperature changes', () => {
      const a = computeCacheKey({ prompt: 'lofi', temperature: 1.0 });
      const b = computeCacheKey({ prompt: 'lofi', temperature: 0.8 });
      expect(a).not.toBe(b);
    });

    it('uses defaults for unspecified parameters', () => {
      // With defaults explicitly set should match without them
      const a = computeCacheKey({ prompt: 'lofi' });
      const b = computeCacheKey({
        prompt: 'lofi',
        durationSec: 30,
        guidanceScale: 3,
        temperature: 1.0,
      });
      expect(a).toBe(b);
    });
  });

  describe('getCachePath', () => {
    it('returns a path under argoDir/music/', () => {
      const p = getCachePath(tmpDir, { prompt: 'test' });
      expect(p).toContain(path.join(tmpDir, 'music'));
      expect(p).toMatch(/\.wav$/);
    });

    it('uses the hash in the filename', () => {
      const hash = computeCacheKey({ prompt: 'test' });
      const p = getCachePath(tmpDir, { prompt: 'test' });
      expect(path.basename(p)).toBe(`${hash}.wav`);
    });
  });

  describe('isCached', () => {
    it('returns false when no file exists', () => {
      expect(isCached(tmpDir, { prompt: 'test' })).toBe(false);
    });

    it('returns true when cached file exists', () => {
      const opts: MusicGenOptions = { prompt: 'cached track' };
      const cachePath = getCachePath(tmpDir, opts);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, Buffer.from('fake wav'));
      expect(isCached(tmpDir, opts)).toBe(true);
    });
  });

  describe('generateMusicCached', () => {
    it('returns cached path without calling generateMusic when file exists', async () => {
      const opts: MusicGenOptions = { prompt: 'already cached' };
      const cachePath = getCachePath(tmpDir, opts);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, Buffer.from('cached wav data'));

      // Suppress console output during test
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await generateMusicCached(tmpDir, opts);
        expect(result).toBe(cachePath);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('returns null on generation failure (best-effort)', async () => {
      // Mock the dynamic import to fail quickly instead of loading the real model
      vi.doMock('@huggingface/transformers', () => {
        throw new Error('mock: model not available');
      });

      // Re-import to pick up the mock
      const { generateMusicCached: mockedGenerate } = await import(
        '../../src/music/musicgen.js'
      );

      const opts: MusicGenOptions = { prompt: 'will fail' };
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await mockedGenerate(tmpDir, opts);
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
        warnSpy.mockRestore();
        vi.doUnmock('@huggingface/transformers');
      }
    });
  });
});
