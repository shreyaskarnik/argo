import type { Placement } from './tts/align.js';
import type { TransitionConfig } from './config.js';

/**
 * Generate ffmpeg video filter expressions for scene transitions.
 *
 * Transitions are applied at scene boundaries (the start of each scene after
 * the first). For a continuous recording, supported transitions are:
 *
 * - `fade-through-black`: fade out to black, then fade in
 * - `dissolve`: quick opacity dip (simulates crossfade on continuous footage)
 * - `wipe-left` / `wipe-right`: falls back to fade-through-black (not yet implemented)
 *
 * Implementation note: ffmpeg's `fade` filter only supports a single fade-out
 * and fade-in per filter instance. For multiple scene boundaries, we build a
 * complex filter graph that overlays black frames at each boundary using the
 * `enable` timeline expression.
 */
export function buildTransitionFilters(
  placements: Placement[],
  transition: TransitionConfig,
): string[] {
  if (placements.length < 2) return [];

  const durMs = transition.durationMs ?? 500;
  const durSec = durMs / 1000;
  const halfDur = durSec / 2;

  // For dissolve, use alpha fades (one per boundary is fine since alpha
  // fades are independent). Each boundary gets its own enable window.
  if (transition.type === 'dissolve') {
    const parts: string[] = [];
    for (let i = 1; i < placements.length; i++) {
      const boundarySec = placements[i].startMs / 1000;
      const startSec = boundarySec - halfDur;
      // Use geq to dim brightness in a time window — simpler than chained fades
      parts.push(
        `fade=t=out:st=${startSec.toFixed(3)}:d=${halfDur.toFixed(3)}:alpha=1`,
        `fade=t=in:st=${boundarySec.toFixed(3)}:d=${halfDur.toFixed(3)}:alpha=1`,
      );
    }
    return parts;
  }

  // For fade-through-black (and wipe fallback), we need to handle multiple
  // boundaries. Build a single drawbox filter with enable expressions that
  // activates a full-frame black box at each boundary.
  //
  // The approach: for each boundary, fade to black over halfDur, hold black
  // briefly, then fade back in. We use multiple drawbox filters with
  // graduated opacity, each enabled for a narrow time window.
  const filters: string[] = [];

  for (let i = 1; i < placements.length; i++) {
    const boundarySec = placements[i].startMs / 1000;
    const fadeOutStart = boundarySec - halfDur;
    const fadeInEnd = boundarySec + halfDur;

    // Create a smooth fade using multiple opacity steps
    // 10 steps per half-transition = smooth enough at 30fps
    const steps = 10;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // Fade out: opacity goes 0 → 1 over [fadeOutStart, boundarySec]
      const outTime = fadeOutStart + t * halfDur;
      const outOpacity = t;
      // Fade in: opacity goes 1 → 0 over [boundarySec, fadeInEnd]
      const inTime = boundarySec + t * halfDur;
      const inOpacity = 1 - t;

      const stepDur = halfDur / steps;

      if (s < steps) {
        filters.push(
          `drawbox=x=0:y=0:w=iw:h=ih:color=black@${outOpacity.toFixed(2)}:t=fill:enable='between(t,${outTime.toFixed(3)},${(outTime + stepDur).toFixed(3)})'`,
        );
      }
      if (s > 0) {
        filters.push(
          `drawbox=x=0:y=0:w=iw:h=ih:color=black@${inOpacity.toFixed(2)}:t=fill:enable='between(t,${inTime.toFixed(3)},${(inTime + stepDur).toFixed(3)})'`,
        );
      }
    }
  }

  return filters;
}
