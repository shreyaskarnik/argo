import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createMockTTSEngine } from '../../src/tts/engine.js';
import { generateClips } from '../../src/tts/generate.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'argo-generate-test-'));
}

describe('generateClips', () => {
  let tmpDir: string;
  let manifestPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    manifestPath = path.join(tmpDir, 'manifest.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const demoName = 'test-demo';

  function writeManifest(entries: unknown[]) {
    fs.writeFileSync(manifestPath, JSON.stringify(entries));
  }

  it('generates clips for all entries', async () => {
    const entries = [
      { scene: 'intro', text: 'Hello world' },
      { scene: 'outro', text: 'Goodbye world' },
    ];
    writeManifest(entries);
    const engine = createMockTTSEngine();

    const results = await generateClips({
      manifestPath,
      demoName,
      engine,
      projectRoot: tmpDir,
    });

    expect(results).toHaveLength(2);
    expect(engine.calls).toHaveLength(2);
    expect(results[0].scene).toBe('intro');
    expect(results[1].scene).toBe('outro');
    // Files should exist on disk
    for (const r of results) {
      expect(fs.existsSync(r.clipPath)).toBe(true);
    }
  });

  it('uses cached clips on second run', async () => {
    const entries = [
      { scene: 'intro', text: 'Hello world' },
    ];
    writeManifest(entries);
    const engine = createMockTTSEngine();

    // First run — generates
    await generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir });
    expect(engine.calls).toHaveLength(1);

    // Reset calls
    engine.calls.length = 0;

    // Second run — should use cache
    const results = await generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir });
    expect(engine.calls).toHaveLength(0);
    expect(results).toHaveLength(1);
    expect(fs.existsSync(results[0].clipPath)).toBe(true);
  });

  it('regenerates only changed entries', async () => {
    const entries = [
      { scene: 'intro', text: 'Hello world' },
      { scene: 'outro', text: 'Goodbye world' },
    ];
    writeManifest(entries);
    const engine = createMockTTSEngine();

    // First run
    await generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir });
    expect(engine.calls).toHaveLength(2);

    // Change one entry's text
    engine.calls.length = 0;
    const updatedEntries = [
      { scene: 'intro', text: 'Hello world' },       // unchanged
      { scene: 'outro', text: 'See you later' },      // changed
    ];
    writeManifest(updatedEntries);

    const results = await generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir });
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].text).toBe('See you later');
    expect(results).toHaveLength(2);
  });

  it('throws on missing manifest file', async () => {
    const engine = createMockTTSEngine();
    await expect(
      generateClips({
        manifestPath: path.join(tmpDir, 'nonexistent.json'),
        demoName,
        engine,
        projectRoot: tmpDir,
      }),
    ).rejects.toThrow('Manifest file not found');
  });

  it('throws on invalid JSON', async () => {
    fs.writeFileSync(manifestPath, '{ not valid json }}}');
    const engine = createMockTTSEngine();
    await expect(
      generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir }),
    ).rejects.toThrow('Failed to parse manifest');
  });

  it('throws on missing required field scene', async () => {
    writeManifest([{ text: 'Hello world' }]);
    const engine = createMockTTSEngine();
    await expect(
      generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir }),
    ).rejects.toThrow('missing required field');
  });

  it('returns empty results for scenes without text (silent mode)', async () => {
    writeManifest([{ scene: 'intro' }]);
    const engine = createMockTTSEngine();
    const results = await generateClips({ manifestPath, demoName, engine, projectRoot: tmpDir });
    expect(results).toHaveLength(0);
  });

  it('applies defaults for voice and speed when entry does not specify them', async () => {
    const entries = [
      { scene: 'intro', text: 'Hello world' },
    ];
    writeManifest(entries);
    const engine = createMockTTSEngine();

    await generateClips({
      manifestPath,
      demoName,
      engine,
      projectRoot: tmpDir,
      defaults: { voice: 'alloy', speed: 1.2 },
    });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].options.voice).toBe('alloy');
    expect(engine.calls[0].options.speed).toBe(1.2);
  });

  it('entry-level voice/speed overrides defaults', async () => {
    const entries = [
      { scene: 'intro', text: 'Hello', voice: 'nova', speed: 0.8 },
    ];
    writeManifest(entries);
    const engine = createMockTTSEngine();

    await generateClips({
      manifestPath,
      demoName,
      engine,
      projectRoot: tmpDir,
      defaults: { voice: 'alloy', speed: 1.2 },
    });

    expect(engine.calls[0].options.voice).toBe('nova');
    expect(engine.calls[0].options.speed).toBe(0.8);
  });

  it('passes lang through to the TTS engine', async () => {
    const entries = [
      { scene: 'intro', text: 'Namaste world', lang: 'hi-IN' },
    ];
    writeManifest(entries);
    const engine = createMockTTSEngine();

    await generateClips({
      manifestPath,
      demoName,
      engine,
      projectRoot: tmpDir,
      defaults: { voice: 'alloy', speed: 1.2 },
    });

    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0].options).toEqual({
      voice: 'alloy',
      speed: 1.2,
      lang: 'hi-IN',
    });
  });
});
