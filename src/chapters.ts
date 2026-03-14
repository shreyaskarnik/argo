import type { Placement } from './tts/align.js';

/**
 * Generate ffmpeg metadata format for chapter markers.
 * Each scene placement becomes a chapter in the MP4.
 */
export function generateChapterMetadata(
  placements: Placement[],
  totalDurationMs: number,
): string {
  const lines: string[] = [';FFMETADATA1'];

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const endMs = i < placements.length - 1
      ? placements[i + 1].startMs
      : totalDurationMs;

    // ffmpeg chapter times are in milliseconds
    lines.push('');
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${Math.round(p.startMs)}`);
    lines.push(`END=${Math.round(endMs)}`);
    lines.push(`title=${p.scene}`);
  }

  return lines.join('\n') + '\n';
}
