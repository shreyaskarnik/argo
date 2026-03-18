import type { Placement } from './tts/align.js';
import type { TransitionConfig } from './config.js';

/**
 * Build an ffmpeg `eq` brightness expression for a fade at a scene boundary.
 *
 * The `eq` filter's `brightness` parameter accepts ffmpeg expressions with
 * `between()`, `if()`, etc. natively — no comma escaping needed, unlike `geq`.
 *
 * - Fade out: brightness ramps from 0 to -1 over [fadeOutStart, boundary]
 * - Fade in:  brightness ramps from -1 to 0 over [boundary, fadeInEnd]
 * - Outside:  brightness stays at 0 (no change)
 *
 * `minBrightness` controls the dip depth: -1 = full black, -0.65 = gentle dim (dissolve).
 */
function buildBrightnessExpr(
  boundarySec: number,
  halfDur: number,
  minBrightness: number,
): string {
  const fos = (boundarySec - halfDur).toFixed(4);
  const bs = boundarySec.toFixed(4);
  const fie = (boundarySec + halfDur).toFixed(4);
  const hd = halfDur.toFixed(4);
  const min = minBrightness.toFixed(4);

  // Fade out: ramp from 0 → min over [fos, bs]
  // Fade in:  ramp from min → 0 over [bs, fie]
  return (
    `if(between(t,${fos},${bs}),` +
    `${min}*(t-${fos})/${hd},` +
    `if(between(t,${bs},${fie}),` +
    `${min}*(1-(t-${bs})/${hd}),` +
    `0))`
  );
}

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
      `drawbox=x='iw-if(between(t\\,${coverStart.toFixed(3)}\\,${boundarySec.toFixed(3)})\\,(t-${coverStart.toFixed(3)})/${coverDur}*iw\\,0)':y=0:w='if(between(t\\,${coverStart.toFixed(3)}\\,${boundarySec.toFixed(3)})\\,(t-${coverStart.toFixed(3)})/${coverDur}*iw\\,0)':h=ih:color=black:t=fill`,
      `drawbox=x=0:y=0:w='if(between(t\\,${boundarySec.toFixed(3)}\\,${revealEnd.toFixed(3)})\\,(1-(t-${boundarySec.toFixed(3)})/${revealDur})*iw\\,0)':h=ih:color=black:t=fill`,
    ];
  }

  return [
    `drawbox=x=0:y=0:w='if(between(t\\,${coverStart.toFixed(3)}\\,${boundarySec.toFixed(3)})\\,(t-${coverStart.toFixed(3)})/${coverDur}*iw\\,0)':h=ih:color=black:t=fill`,
    `drawbox=x='iw-if(between(t\\,${boundarySec.toFixed(3)}\\,${revealEnd.toFixed(3)})\\,(1-(t-${boundarySec.toFixed(3)})/${revealDur})*iw\\,0)':y=0:w='if(between(t\\,${boundarySec.toFixed(3)}\\,${revealEnd.toFixed(3)})\\,(1-(t-${boundarySec.toFixed(3)})/${revealDur})*iw\\,0)':h=ih:color=black:t=fill`,
  ];
}

/**
 * Generate ffmpeg filter expressions for scene transitions.
 *
 * Uses the `eq` (equalization) filter for brightness-based transitions.
 * The eq filter's expression parser handles between(), if(), etc. natively
 * without comma escaping issues (unlike geq). Each boundary gets one eq
 * filter with an enable window.
 *
 * Transition types:
 * - `fade-through-black`: brightness dips to -1 (full black) at boundary
 * - `dissolve`: brightness dips to -0.65 (gentle dim) at boundary
 * - `wipe-left`/`wipe-right`: directional drawbox mask
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

  // Dissolve: gentle brightness dip (not full black)
  const minBrightness = transition.type === 'dissolve' ? -0.65 : -1.0;

  const filters: string[] = [];
  for (let i = 1; i < placements.length; i++) {
    const boundarySec = placements[i].startMs / 1000;
    const fos = (boundarySec - halfDur).toFixed(4);
    const fie = (boundarySec + halfDur).toFixed(4);
    const brightnessExpr = buildBrightnessExpr(boundarySec, halfDur, minBrightness);

    filters.push(
      `eq=brightness='${brightnessExpr}':enable='between(t,${fos},${fie})'`,
    );
  }

  return filters;
}
