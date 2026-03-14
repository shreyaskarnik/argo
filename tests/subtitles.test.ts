import { describe, it, expect } from 'vitest';
import { generateSrt, generateVtt } from '../src/subtitles.js';
import type { Placement } from '../src/tts/align.js';

const placements: Placement[] = [
  { scene: 'intro', startMs: 1000, endMs: 4500 },
  { scene: 'feature', startMs: 5000, endMs: 9200 },
  { scene: 'closing', startMs: 10000, endMs: 13000 },
];

const sceneTexts: Record<string, string> = {
  intro: 'Welcome to the app.',
  feature: 'Here is the main feature.',
  closing: 'Thanks for watching.',
};

describe('generateSrt', () => {
  it('produces valid SRT with correct numbering and timestamps', () => {
    const srt = generateSrt(placements, sceneTexts);
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:04,500\nWelcome to the app.');
    expect(srt).toContain('2\n00:00:05,000 --> 00:00:09,200\nHere is the main feature.');
    expect(srt).toContain('3\n00:00:10,000 --> 00:00:13,000\nThanks for watching.');
  });

  it('skips scenes with no text in sceneTexts', () => {
    const srt = generateSrt(placements, { intro: 'Hello' });
    expect(srt).toContain('1\n');
    expect(srt).not.toContain('2\n');
  });

  it('returns empty string when no placements match', () => {
    const srt = generateSrt(placements, {});
    expect(srt).toBe('');
  });
});

describe('generateVtt', () => {
  it('starts with WEBVTT header and uses dot for milliseconds', () => {
    const vtt = generateVtt(placements, sceneTexts);
    expect(vtt).toMatch(/^WEBVTT\n/);
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.500');
    expect(vtt).not.toContain(','); // VTT uses dots, not commas
  });
});
