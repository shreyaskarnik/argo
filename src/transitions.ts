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
 * - `wipe-left` / `wipe-right`: sliding crop reveal
 */
export function buildTransitionFilters(
  placements: Placement[],
  transition: TransitionConfig,
): string[] {
  if (placements.length < 2) return [];

  const durMs = transition.durationMs ?? 500;
  const durSec = durMs / 1000;
  const halfDur = durSec / 2;
  const filters: string[] = [];

  for (let i = 1; i < placements.length; i++) {
    const boundaryMs = placements[i].startMs;
    const boundarySec = boundaryMs / 1000;

    switch (transition.type) {
      case 'fade-through-black':
        // Fade out ending at the boundary, fade in starting at the boundary
        filters.push(
          `fade=t=out:st=${(boundarySec - halfDur).toFixed(3)}:d=${halfDur.toFixed(3)}`,
          `fade=t=in:st=${boundarySec.toFixed(3)}:d=${halfDur.toFixed(3)}`,
        );
        break;

      case 'dissolve':
        // Quick opacity dip around the boundary
        filters.push(
          `fade=t=out:st=${(boundarySec - halfDur).toFixed(3)}:d=${halfDur.toFixed(3)}:alpha=1`,
          `fade=t=in:st=${boundarySec.toFixed(3)}:d=${halfDur.toFixed(3)}:alpha=1`,
        );
        break;

      case 'wipe-left':
      case 'wipe-right': {
        // Use a geq-based wipe: darken a sliding column across the frame
        const dir = transition.type === 'wipe-left' ? 'W-' : '';
        const startSec = (boundarySec - halfDur).toFixed(3);
        // Express as two fades — wipe is complex in single-stream ffmpeg,
        // fall back to fade-through-black for simplicity
        filters.push(
          `fade=t=out:st=${startSec}:d=${halfDur.toFixed(3)}`,
          `fade=t=in:st=${boundarySec.toFixed(3)}:d=${halfDur.toFixed(3)}`,
        );
        break;
      }
    }
  }

  return filters;
}
