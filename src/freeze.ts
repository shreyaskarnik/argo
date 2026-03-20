import type { Placement } from './tts/align.js';

/**
 * Specification for a freeze-frame hold at a particular point in the timeline.
 */
export interface FreezeSpec {
  /** Scene name this freeze belongs to. */
  scene: string;
  /** Offset in ms from the scene start where the frame should be frozen. */
  atMs: number;
  /** Duration in ms to hold the frozen frame. */
  durationMs: number;
}

/**
 * A freeze resolved to an absolute position on the (post-trim, pre-export) timeline.
 */
export interface ResolvedFreeze {
  /** Absolute time in ms where the freeze occurs. */
  absoluteMs: number;
  /** Duration in ms to hold the frozen frame. */
  durationMs: number;
}

/**
 * Resolve scene-relative freeze specs to absolute timeline positions using placements.
 *
 * Freezes whose scene is not found in placements are silently dropped.
 * The returned array is sorted chronologically.
 */
export function resolveFreezes(
  freezes: FreezeSpec[],
  placements: Placement[],
): ResolvedFreeze[] {
  const placementMap = new Map<string, Placement>();
  for (const p of placements) {
    placementMap.set(p.scene, p);
  }

  const resolved: ResolvedFreeze[] = [];
  for (const f of freezes) {
    const placement = placementMap.get(f.scene);
    if (!placement) continue;
    resolved.push({
      absoluteMs: placement.startMs + f.atMs,
      durationMs: f.durationMs,
    });
  }

  resolved.sort((a, b) => a.absoluteMs - b.absoluteMs);
  return resolved;
}

/**
 * Build an ffmpeg filter_complex expression that freezes specific frames.
 *
 * Strategy: split the video at each freeze point using trim, apply tpad to clone
 * the last frame for the freeze duration, then concatenate all segments.
 *
 * Freezes are processed in chronological order. Each freeze adds `durationMs`
 * to the total video length.
 *
 * @param freezes - Resolved freezes sorted chronologically.
 * @param totalDurationMs - Total video duration before freezes (used for the final trim).
 * @param inputLabel - The ffmpeg stream label for the video input (e.g. '0:v').
 * @returns The filter expression, output label, and total added duration — or null if no freezes.
 */
export function buildFreezeFilter(
  freezes: ResolvedFreeze[],
  totalDurationMs: number,
  inputLabel: string,
): { filter: string; outputLabel: string; addedDurationMs: number } | null {
  if (freezes.length === 0) return null;

  const parts: string[] = [];
  const concatLabels: string[] = [];
  let segIndex = 0;
  let cursor = 0; // current position in the source timeline (ms)
  let addedDurationMs = 0;

  for (const freeze of freezes) {
    const freezeTimeSec = (freeze.absoluteMs / 1000).toFixed(3);
    const freezeDurSec = (freeze.durationMs / 1000).toFixed(3);

    // Segment before the freeze point (may be zero-length if two freezes are at the same point)
    if (freeze.absoluteMs > cursor) {
      const startSec = (cursor / 1000).toFixed(3);
      const label = `frzseg${segIndex}`;
      parts.push(
        `[${inputLabel}]trim=start=${startSec}:end=${freezeTimeSec},setpts=PTS-STARTPTS[${label}]`,
      );
      concatLabels.push(`[${label}]`);
      segIndex++;
    }

    // The frozen frame: trim a tiny slice at the freeze point, then tpad to clone it
    const frozenLabel = `frzhold${segIndex}`;
    // Trim a 1-frame slice (use a very short duration; tpad clones the last frame)
    const sliceEndSec = ((freeze.absoluteMs + 1) / 1000).toFixed(3);
    parts.push(
      `[${inputLabel}]trim=start=${freezeTimeSec}:end=${sliceEndSec},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${freezeDurSec}[${frozenLabel}]`,
    );
    concatLabels.push(`[${frozenLabel}]`);
    segIndex++;
    addedDurationMs += freeze.durationMs;
    cursor = freeze.absoluteMs;
  }

  // Remaining segment after the last freeze
  if (cursor < totalDurationMs) {
    const startSec = (cursor / 1000).toFixed(3);
    const endSec = (totalDurationMs / 1000).toFixed(3);
    const label = `frzseg${segIndex}`;
    parts.push(
      `[${inputLabel}]trim=start=${startSec}:end=${endSec},setpts=PTS-STARTPTS[${label}]`,
    );
    concatLabels.push(`[${label}]`);
  }

  const outputLabel = 'frzout';
  parts.push(
    `${concatLabels.join('')}concat=n=${concatLabels.length}:v=1:a=0[${outputLabel}]`,
  );

  return { filter: parts.join(';\n'), outputLabel, addedDurationMs };
}

/**
 * Shift placements, chapters, and subtitles forward to account for freeze-inserted duration.
 *
 * Each freeze at `absoluteMs` pushes everything after that point by `durationMs`.
 * Freezes must be sorted chronologically.
 */
export function adjustPlacementsForFreezes(
  placements: Placement[],
  freezes: ResolvedFreeze[],
): Placement[] {
  if (freezes.length === 0) return placements;

  return placements.map((p) => {
    let startShift = 0;
    let endShift = 0;
    for (const f of freezes) {
      if (f.absoluteMs <= p.startMs) {
        startShift += f.durationMs;
      }
      if (f.absoluteMs <= p.endMs) {
        endShift += f.durationMs;
      }
    }
    return {
      scene: p.scene,
      startMs: p.startMs + startShift,
      endMs: p.endMs + endShift,
    };
  });
}

/**
 * Compute the total duration added by all freezes.
 */
export function totalFreezeDurationMs(freezes: ResolvedFreeze[]): number {
  return freezes.reduce((sum, f) => sum + f.durationMs, 0);
}
