import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Placement } from './tts/align.js';
import type { SpeedRampConfig } from './config.js';

interface Segment {
  startSec: number;
  endSec: number;
  speed: number;
}

/**
 * Identify gap segments between scene placements and mark them for speed-up.
 */
export function computeSegments(
  placements: Placement[],
  totalDurationMs: number,
  config: SpeedRampConfig,
): Segment[] {
  const minGapMs = config.minGapMs ?? 500;
  const gapSpeed = config.gapSpeed;
  if (gapSpeed <= 1.0) return []; // No speed-up needed

  const sorted = [...placements].sort((a, b) => a.startMs - b.startMs);
  const segments: Segment[] = [];
  let cursor = 0;

  for (const p of sorted) {
    if (p.startMs - cursor >= minGapMs) {
      // Gap before this scene
      segments.push({
        startSec: cursor / 1000,
        endSec: p.startMs / 1000,
        speed: gapSpeed,
      });
    }
    // Scene itself at normal speed
    segments.push({
      startSec: p.startMs / 1000,
      endSec: p.endMs / 1000,
      speed: 1.0,
    });
    cursor = p.endMs;
  }

  // Trailing gap
  if (totalDurationMs - cursor >= minGapMs) {
    segments.push({
      startSec: cursor / 1000,
      endSec: totalDurationMs / 1000,
      speed: gapSpeed,
    });
  }

  return segments;
}

/**
 * Build ffmpeg filter_complex for speed ramping.
 *
 * Splits the input into segments, applies setpts (video) and atempo (audio)
 * to gap segments, then concatenates everything back together.
 */
export function buildSpeedRampFilter(
  segments: Segment[],
  hasAudio: boolean,
): { filterComplex: string; outputLabels: { video: string; audio?: string } } | null {
  if (segments.length === 0) return null;

  // If all segments are speed 1.0, no filter needed
  if (segments.every((s) => s.speed === 1.0)) return null;

  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const vLabel = `v${i}`;
    const aLabel = `a${i}`;
    const vOut = `vout${i}`;
    const aOut = `aout${i}`;

    // Trim
    parts.push(
      `[0:v]trim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},setpts=PTS-STARTPTS[${vLabel}]`,
    );
    if (hasAudio) {
      parts.push(
        `[0:a]atrim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},asetpts=PTS-STARTPTS[${aLabel}]`,
      );
    }

    // Apply speed change
    if (seg.speed !== 1.0) {
      const ptsFactor = (1 / seg.speed).toFixed(4);
      parts.push(`[${vLabel}]setpts=${ptsFactor}*PTS[${vOut}]`);
      videoLabels.push(`[${vOut}]`);

      if (hasAudio) {
        // atempo only supports 0.5–100.0; chain multiple for extreme values
        const tempoFilters = buildAtempoChain(seg.speed);
        parts.push(`[${aLabel}]${tempoFilters}[${aOut}]`);
        audioLabels.push(`[${aOut}]`);
      }
    } else {
      videoLabels.push(`[${vLabel}]`);
      if (hasAudio) audioLabels.push(`[${aLabel}]`);
    }
  }

  // Concatenate
  const n = videoLabels.length;
  const concatStreams = hasAudio ? 'v=1:a=1' : 'v=1:a=0';
  parts.push(
    `${videoLabels.join('')}${hasAudio ? audioLabels.join('') : ''}concat=n=${n}:${concatStreams}[outv]${hasAudio ? '[outa]' : ''}`,
  );

  return {
    filterComplex: parts.join(';\n'),
    outputLabels: { video: '[outv]', audio: hasAudio ? '[outa]' : undefined },
  };
}

/**
 * Chain atempo filters for speeds outside the 0.5–100.0 range.
 * Each atempo instance handles 0.5–100.0.
 */
function buildAtempoChain(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 100.0) {
    filters.push('atempo=100.0');
    remaining /= 100.0;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(',');
}

/**
 * Apply speed ramp to an already-exported MP4.
 * Replaces the file in-place (writes to temp, then renames).
 */
export async function applySpeedRamp(
  inputPath: string,
  segments: Segment[],
  hasAudio: boolean,
  preset: string,
  crf: number,
): Promise<void> {
  const filter = buildSpeedRampFilter(segments, hasAudio);
  if (!filter) return;

  const tmpPath = inputPath.replace(/\.mp4$/, '.ramped.mp4');

  const args = [
    '-i', inputPath,
    '-filter_complex', filter.filterComplex,
    '-map', filter.outputLabels.video,
  ];
  if (filter.outputLabels.audio) {
    args.push('-map', filter.outputLabels.audio);
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
  );
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-y', tmpPath);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('error', (err) => reject(new Error(`Failed to launch ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg speed ramp failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });

  // Replace original with ramped version
  const { renameSync, unlinkSync } = await import('node:fs');
  renameSync(tmpPath, inputPath);
}
