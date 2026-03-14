import type { Placement } from './tts/align.js';

interface SubtitleEntry {
  scene: string;
  text: string;
  startMs: number;
  endMs: number;
}

function buildEntries(
  placements: Placement[],
  sceneTexts: Record<string, string>,
): SubtitleEntry[] {
  return placements
    .filter((p) => p.scene in sceneTexts)
    .map((p) => ({
      scene: p.scene,
      text: sceneTexts[p.scene],
      startMs: p.startMs,
      endMs: p.endMs,
    }));
}

function formatSrtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function formatVttTime(ms: number): string {
  return formatSrtTime(ms).replace(',', '.');
}

export function generateSrt(
  placements: Placement[],
  sceneTexts: Record<string, string>,
): string {
  const entries = buildEntries(placements, sceneTexts);
  return entries
    .map((e, i) =>
      `${i + 1}\n${formatSrtTime(e.startMs)} --> ${formatSrtTime(e.endMs)}\n${e.text}\n`
    )
    .join('\n');
}

export function generateVtt(
  placements: Placement[],
  sceneTexts: Record<string, string>,
): string {
  const entries = buildEntries(placements, sceneTexts);
  const cues = entries
    .map((e) =>
      `${formatVttTime(e.startMs)} --> ${formatVttTime(e.endMs)}\n${e.text}`
    )
    .join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}
