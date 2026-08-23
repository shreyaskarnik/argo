import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrationTimeline } from '../src/narration.js';

/**
 * `atWord` matched on a token stripped by `[^\w']`, which is ASCII-only. Every
 * Cyrillic, Han and Devanagari word stripped to the empty string, so they all
 * compared equal: asking for any anchor returned the first word in the scene,
 * at a time that looked reasonable and was wrong. Accented Latin was mangled
 * rather than erased, so "Anträge" only matched a caller who also wrote it
 * without the umlaut.
 *
 * The transcript is cached per process on first read, so every case here shares
 * one file with a scene per language.
 */
const WORDS = (...pairs: Array<[string, number]>) =>
  pairs.map(([text, start]) => ({ text, start, end: start + 0.4 }));

const TRANSCRIPT = {
  version: 1,
  model: 'test',
  scenes: {
    ru: WORDS(['Две', 1], ['заявки,', 2], ['одобрены.', 3]),
    zh: WORDS(['两', 1], ['个', 2], ['申请', 3]),
    hi: WORDS(['दो', 1], ['अनुरोध,', 2], ['स्वीकृत।', 3]),
    de: WORDS(['Zwei', 1], ['Anträge,', 2], ['genehmigt.', 3]),
    en: WORDS(['Two', 1], ['requests,', 2], ['approved.', 3]),

    // Pairs that differ only by a combining mark. These are the cases that
    // survived the first fix: dropping \p{M} collapses each pair onto one
    // spelling, so the anchor lands on whichever came first.
    hiMarks: WORDS(['कल', 1], ['है', 2], ['काल', 3]),
    thMarks: WORDS(['ไม้', 1], ['คือ', 2], ['ไม่', 3]),

    // A leading token with no letters or digits at all.
    punct: WORDS(['...', 1], ['hello', 2], ['world', 3]),
  },
};

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'argo-atword-'));
  const path = join(dir, 'transcript.json');
  writeFileSync(path, JSON.stringify(TRANSCRIPT), 'utf-8');
  process.env.ARGO_TRANSCRIPT_PATH = path;
});

afterAll(() => {
  delete process.env.ARGO_TRANSCRIPT_PATH;
  rmSync(dir, { recursive: true, force: true });
});

/** A timeline sitting at the very start of `scene`. */
function atStartOf(scene: string): NarrationTimeline {
  const timeline = new NarrationTimeline();
  timeline.start();
  timeline.mark(scene);
  return timeline;
}

describe('atWord across scripts', () => {
  // Each case asks for the *third* word. Under the old normalisation every
  // non-Latin token was equal, so the first word matched and the answer came
  // back near 1000ms instead of near 3000ms.
  it.each([
    ['ru', 'одобрены'],
    ['zh', '申请'],
    ['hi', 'स्वीकृत'],
    ['de', 'genehmigt'],
    ['en', 'approved'],
  ])('finds the third word in %s and not the first', (scene, anchor) => {
    const ms = atStartOf(scene).atWord(scene, anchor);
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it('keeps a diacritic significant instead of stripping it', () => {
    // "Anträge" must be reachable as written. It also must not be reachable by
    // an ASCII-folded spelling, which the old behaviour accidentally allowed.
    expect(atStartOf('de').atWord('de', 'Anträge')).toBeGreaterThan(1500);
    expect(atStartOf('de').atWord('de', 'antrge')).toBeNull();
  });

  it('still ignores case and trailing punctuation', () => {
    expect(atStartOf('en').atWord('en', 'REQUESTS')).toBeGreaterThan(1500);
    expect(atStartOf('ru').atWord('ru', 'заявки')).toBeGreaterThan(1500);
  });

  it('returns null for a word the scene does not contain', () => {
    expect(atStartOf('ru').atWord('ru', 'отклонены')).toBeNull();
    expect(atStartOf('zh').atWord('zh', '批准')).toBeNull();
  });
});

describe('atWord and combining marks', () => {
  it.each([
    ['hiMarks', 'काल', 'कल'],
    ['thMarks', 'ไม่', 'ไม้'],
  ])('%s: anchors on %s rather than the mark-stripped %s', (scene, anchor) => {
    const ms = atStartOf(scene).atWord(scene, anchor);
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it('matches a decomposed anchor against a precomposed transcript', () => {
    // Visually identical, and a script pulled through a filesystem path or a
    // copy-paste can carry either. Without an NFC pass this returns null
    // forever, which is indistinguishable from "the word is already spoken".
    expect(atStartOf('de').atWord('de', 'Anträge'.normalize('NFD'))).toBeGreaterThan(1500);
  });

  it('refuses an anchor that strips to nothing', () => {
    // Both the anchor and the scene's first token normalise to '', so without
    // a guard they compare equal and the caller gets 1000ms for punctuation.
    expect(atStartOf('punct').atWord('punct', '...')).toBeNull();
    expect(atStartOf('punct').atWord('punct', '?!')).toBeNull();
    // The real words in that scene stay reachable.
    expect(atStartOf('punct').atWord('punct', 'world')).toBeGreaterThan(2500);
  });
});
