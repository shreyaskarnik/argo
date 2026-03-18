import type { Placement } from './tts/align.js';
import type { TransitionConfig } from './config.js';

function buildDirectionalWipe(
  direction: 'left' | 'right',
  boundarySec: number,
  halfDur: number,
): string[] {
  const coverStart = boundarySec - halfDur;
  const revealEnd = boundarySec + halfDur;
  const coverDur = halfDur.toFixed(3);
  const revealDur = halfDur.toFixed(3);

  if (direction === 'left') {
    return [
      `drawbox=x='iw-if(between(t,${coverStart.toFixed(3)},${boundarySec.toFixed(3)}),(t-${coverStart.toFixed(3)})/${coverDur}*iw,0)':y=0:w='if(between(t,${coverStart.toFixed(3)},${boundarySec.toFixed(3)}),(t-${coverStart.toFixed(3)})/${coverDur}*iw,0)':h=ih:color=black:t=fill`,
      `drawbox=x=0:y=0:w='if(between(t,${boundarySec.toFixed(3)},${revealEnd.toFixed(3)}),(1-(t-${boundarySec.toFixed(3)})/${revealDur})*iw,0)':h=ih:color=black:t=fill`,
    ];
  }

  return [
    `drawbox=x=0:y=0:w='if(between(t,${coverStart.toFixed(3)},${boundarySec.toFixed(3)}),(t-${coverStart.toFixed(3)})/${coverDur}*iw,0)':h=ih:color=black:t=fill`,
    `drawbox=x='iw-if(between(t,${boundarySec.toFixed(3)},${revealEnd.toFixed(3)}),(1-(t-${boundarySec.toFixed(3)})/${revealDur})*iw,0)':y=0:w='if(between(t,${boundarySec.toFixed(3)},${revealEnd.toFixed(3)}),(1-(t-${boundarySec.toFixed(3)})/${revealDur})*iw,0)':h=ih:color=black:t=fill`,
  ];
}

/**
 * Generate ffmpeg video filter expressions for scene transitions.
 *
 * Transitions are applied at scene boundaries (the start of each scene after
 * the first). For a continuous recording, supported transitions are:
 *
 * - `fade-through-black`: fade out to black, then fade in
 * - `dissolve`: quick opacity dip (simulates crossfade on continuous footage)
 * - `wipe-left` / `wipe-right`: directional wipe-through-black using a moving mask
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

  if (transition.type === 'wipe-left' || transition.type === 'wipe-right') {
    const parts: string[] = [];
    for (let i = 1; i < placements.length; i++) {
      const boundarySec = placements[i].startMs / 1000;
      parts.push(
        ...buildDirectionalWipe(
          transition.type === 'wipe-left' ? 'left' : 'right',
          boundarySec,
          halfDur,
        ),
      );
    }
    return parts;
  }

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

  // For fade-through-black, use a geq (generic equation) filter per boundary.
  // geq evaluates a per-pixel expression every frame, giving perfectly smooth
  // opacity transitions. Each boundary gets one geq that:
  //   - During fade-out: darkens pixels linearly toward black
  //   - During fade-in: brightens pixels linearly from black
  //   - Outside the transition window: passes pixels unchanged
  const filters: string[] = [];

  for (let i = 1; i < placements.length; i++) {
    const boundarySec = placements[i].startMs / 1000;
    const fadeOutStart = boundarySec - halfDur;
    const fadeInEnd = boundarySec + halfDur;
    const hd = halfDur.toFixed(4);
    const fos = fadeOutStart.toFixed(4);
    const bs = boundarySec.toFixed(4);
    const fie = fadeInEnd.toFixed(4);

    // Compute a brightness multiplier:
    //   before fadeOutStart: 1.0 (full brightness)
    //   fadeOutStart → boundary: ramps 1.0 → 0.0
    //   boundary → fadeInEnd: ramps 0.0 → 1.0
    //   after fadeInEnd: 1.0 (full brightness)
    const brightnessExpr =
      `if(between(t,${fos},${bs}),1-(t-${fos})/${hd},` +
      `if(between(t,${bs},${fie}),(t-${bs})/${hd},1))`;

    // Apply to luma (Y) channel; chroma (U/V) channels center at 128
    // so we lerp them toward 128 (black in YUV) proportionally.
    filters.push(
      `geq=lum='lum(X,Y)*${brightnessExpr}':cb='128+(cb(X,Y)-128)*${brightnessExpr}':cr='128+(cr(X,Y)-128)*${brightnessExpr}':enable='between(t,${fos},${fie})'`,
    );
  }

  return filters;
}
