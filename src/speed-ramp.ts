import { spawn } from 'node:child_process';
import type { Placement } from './tts/align.js';
import type { SpeedRampConfig } from './config.js';

export interface Segment {
  startMs: number;
  endMs: number;
  speed: number;
}

/**
 * Per-scene playback speed overrides, keyed by scene name.
 */
export type SceneSpeedMap = Record<string, number>;

/**
 * Identify gap segments between scene placements and mark them for speed-up.
 * Also applies per-scene playback speed overrides when provided.
 */
export function computeSegments(
  placements: Placement[],
  totalDurationMs: number,
  config: SpeedRampConfig,
  sceneSpeeds?: SceneSpeedMap,
): Segment[] {
  const minGapMs = config.minGapMs ?? 500;
  const gapSpeed = config.gapSpeed;
  const hasSceneSpeeds = sceneSpeeds && Object.values(sceneSpeeds).some((s) => s !== 1.0);

  if (gapSpeed <= 1.0 && !hasSceneSpeeds) return []; // No speed changes needed

  const sorted = [...placements].sort((a, b) => a.startMs - b.startMs);
  const segments: Segment[] = [];
  let cursor = 0;
  // Track per-scene speed so gaps after a sped-up scene inherit its speed.
  // This makes playbackSpeed cover the full recording span (mark to next mark),
  // not just the TTS placement window.
  let prevSceneSpeed = 1.0;

  for (const p of sorted) {
    if (p.startMs > cursor) {
      // Gap before this scene:
      // 1. If gapSpeed is configured and gap is large enough, use gapSpeed
      // 2. Otherwise inherit previous scene's playbackSpeed (covers the full
      //    recording span from mark to next mark, not just the TTS window)
      // 3. Fall back to 1.0
      let useSpeed = 1.0;
      if (p.startMs - cursor >= minGapMs && gapSpeed > 1.0) {
        useSpeed = gapSpeed;
      } else if (prevSceneSpeed !== 1.0) {
        useSpeed = prevSceneSpeed;
      }
      segments.push({
        startMs: cursor,
        endMs: p.startMs,
        speed: useSpeed,
      });
    }
    // Scene segment with optional per-scene speed override
    const sceneSpeed = sceneSpeeds?.[p.scene] ?? 1.0;
    segments.push({
      startMs: p.startMs,
      endMs: p.endMs,
      speed: sceneSpeed,
    });
    prevSceneSpeed = sceneSpeed;
    cursor = p.endMs;
  }

  // Trailing gap — gapSpeed wins if configured, else inherit previous scene speed
  if (totalDurationMs > cursor) {
    let trailingSpeed = 1.0;
    if (totalDurationMs - cursor >= minGapMs && gapSpeed > 1.0) {
      trailingSpeed = gapSpeed;
    } else if (prevSceneSpeed !== 1.0) {
      trailingSpeed = prevSceneSpeed;
    }
    segments.push({
      startMs: cursor,
      endMs: totalDurationMs,
      speed: trailingSpeed,
    });
  }

  return segments;
}

export function remapTimeMs(timeMs: number, segments: Segment[]): number {
  if (segments.length === 0) return timeMs;

  let outputMs = 0;
  for (const segment of segments) {
    const segDurationMs = segment.endMs - segment.startMs;
    if (timeMs >= segment.endMs) {
      outputMs += segDurationMs / segment.speed;
      continue;
    }
    if (timeMs > segment.startMs) {
      outputMs += (timeMs - segment.startMs) / segment.speed;
    }
    return Math.round(outputMs);
  }
  // Past the last segment, keep going at its speed rather than saturating. No
  // placement lands here, but remapCameraMoves divides by the distance between
  // two remapped times, and a move's zoom-out tail can overhang the recording.
  const last = segments[segments.length - 1];
  return Math.round(outputMs + (timeMs - last.endMs) / last.speed);
}

export function applySpeedRampToTimeline(
  placements: Placement[],
  totalDurationMs: number,
  config?: SpeedRampConfig,
  sceneSpeeds?: SceneSpeedMap,
): { placements: Placement[]; totalDurationMs: number; segments: Segment[] } {
  const hasSceneSpeeds = sceneSpeeds && Object.values(sceneSpeeds).some((s) => s !== 1.0);
  if (!hasSceneSpeeds && (!config || config.gapSpeed <= 1.0) || placements.length === 0) {
    return { placements, totalDurationMs, segments: [] };
  }

  const effectiveConfig: SpeedRampConfig = config ?? { gapSpeed: 1.0 };
  const segments = computeSegments(placements, totalDurationMs, effectiveConfig, sceneSpeeds);
  if (segments.length === 0 || segments.every((segment) => segment.speed === 1.0)) {
    return { placements, totalDurationMs, segments: [] };
  }

  return {
    placements: placements.map((placement) => ({
      scene: placement.scene,
      startMs: remapTimeMs(placement.startMs, segments),
      endMs: remapTimeMs(placement.endMs, segments),
    })),
    totalDurationMs: remapTimeMs(totalDurationMs, segments),
    segments,
  };
}

/**
 * Build ffmpeg filter_complex for speed ramping.
 *
 * Splits the input into segments, applies setpts (video) and atempo (audio)
 * to gap segments, then concatenates everything back together.
 */
export function buildSpeedRampFilter(
  segments: Segment[],
  inputs: { video: string; audio?: string },
): { filterComplex: string; outputLabels: { video: string; audio?: string } } | null {
  if (segments.length === 0) return null;

  // If all segments are speed 1.0, no filter needed
  if (segments.every((s) => s.speed === 1.0)) return null;

  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const vLabel = `sr_v${i}`;
    const aLabel = `sr_a${i}`;
    const vOut = `sr_vout${i}`;
    const aOut = `sr_aout${i}`;

    // Trim
    parts.push(
      `[${inputs.video}]trim=start=${(seg.startMs / 1000).toFixed(3)}:end=${(seg.endMs / 1000).toFixed(3)},setpts=PTS-STARTPTS[${vLabel}]`,
    );
    if (inputs.audio) {
      parts.push(
        `[${inputs.audio}]atrim=start=${(seg.startMs / 1000).toFixed(3)}:end=${(seg.endMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS[${aLabel}]`,
      );
    }

    // Apply speed change
    if (seg.speed !== 1.0) {
      const ptsFactor = (1 / seg.speed).toFixed(4);
      parts.push(`[${vLabel}]setpts=${ptsFactor}*PTS[${vOut}]`);
      videoLabels.push(`[${vOut}]`);

      if (inputs.audio) {
        // atempo only supports 0.5–100.0; chain multiple for extreme values
        const tempoFilters = buildAtempoChain(seg.speed);
        parts.push(`[${aLabel}]${tempoFilters}[${aOut}]`);
        audioLabels.push(`[${aOut}]`);
      }
    } else {
      videoLabels.push(`[${vLabel}]`);
      if (inputs.audio) audioLabels.push(`[${aLabel}]`);
    }
  }

  // Concatenate — ffmpeg concat requires interleaved order: [v0][a0][v1][a1]...
  const n = videoLabels.length;
  const concatStreams = inputs.audio ? 'v=1:a=1' : 'v=1:a=0';
  let concatInputs: string;
  if (inputs.audio) {
    concatInputs = videoLabels.map((v, i) => `${v}${audioLabels[i]}`).join('');
  } else {
    concatInputs = videoLabels.join('');
  }
  parts.push(
    `${concatInputs}concat=n=${n}:${concatStreams}[outv]${inputs.audio ? '[outa]' : ''}`,
  );

  return {
    filterComplex: parts.join(';\n'),
    outputLabels: { video: 'outv', audio: inputs.audio ? 'outa' : undefined },
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
  const filter = buildSpeedRampFilter(segments, { video: '0:v', audio: hasAudio ? '0:a' : undefined });
  if (!filter) return;

  const tmpPath = inputPath.replace(/\.mp4$/, '.ramped.mp4');

  const args = [
    '-i', inputPath,
    '-filter_complex', filter.filterComplex,
    '-map', `[${filter.outputLabels.video}]`,
  ];
  if (filter.outputLabels.audio) {
    args.push('-map', `[${filter.outputLabels.audio}]`);
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
  const { renameSync } = await import('node:fs');
  renameSync(tmpPath, inputPath);
}
