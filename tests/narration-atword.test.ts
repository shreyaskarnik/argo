import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NarrationTimeline } from '../src/narration.js';

const WORDS = (...pairs: Array<[string, number]>) =>
  pairs.map(([text, start]) => ({ text, start, end: start + 0.4 }));

/**
 * The transcript is cached per process on first read, so every case here shares
 * one file with a scene per language.
 */
const TRANSCRIPT = {
  version: 1,
  model: 'test',
  scenes: {
    ru: WORDS(['Две', 1], ['заявки,', 2], ['одобрены.', 3]),
    zh: WORDS(['两', 1], ['个', 2], ['申请', 3]),
    hi: WORDS(['दो', 1], ['अनुरोध,', 2], ['स्वीकृत।', 3]),
    de: WORDS(['Zwei', 1], ['Anträge,', 2], ['genehmigt.', 3]),
    en: WORDS(['Two', 1], ['requests,', 2], ['approved.', 3]),

    // Pairs differing only by a combining mark: without \p{M} each collapses
    // onto one spelling and the anchor lands on whichever came first.
    hiMarks: WORDS(['कल', 1], ['है', 2], ['काल', 3]),
    thMarks: WORDS(['ไม้', 1], ['คือ', 2], ['ไม่', 3]),

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
  it.each([
    ['ru', 'одобрены'],
    ['zh', '申请'],
    ['hi', 'स्वीकृत'],
    ['de', 'genehmigt'],
    ['en', 'approved'],
  ])('finds the third word in %s and not the first', (scene, anchor) => {
    const ms = atStartOf(scene).atWord(scene, anchor);
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it('keeps a diacritic significant instead of stripping it', () => {
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
    // A null here is indistinguishable from "the word is already spoken".
    expect(atStartOf('de').atWord('de', 'Anträge'.normalize('NFD'))).toBeGreaterThan(1500);
  });

  it('refuses an anchor that strips to nothing', () => {
    // Anchor and first token both normalise to '', so unguarded they match.
    expect(atStartOf('punct').atWord('punct', '...')).toBeNull();
    expect(atStartOf('punct').atWord('punct', '?!')).toBeNull();
    expect(atStartOf('punct').atWord('punct', 'world')).toBeGreaterThan(2500);
  });
});
