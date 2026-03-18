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
 * Generate ffmpeg complex filter graph for scene transitions.
 *
 * For fade-through-black with multiple boundaries, we use a filter_complex
 * approach: add alpha channel → apply multiple alpha fades → overlay on black.
 * This avoids the limitation of ffmpeg's fade filter (only one fade-out and
 * fade-in per stream instance).
 *
 * Returns either:
 * - Simple string[] filters for -vf (dissolve, wipe)
 * - Or a { filterComplex, outputLabel } for -filter_complex (fade-through-black)
 */
export function buildTransitionFilters(
  placements: Placement[],
  transition: TransitionConfig,
): string[] | { filterComplex: string; outputLabel: string } {
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

  // For dissolve, use alpha fades — these work independently per boundary
  if (transition.type === 'dissolve') {
    const parts: string[] = [];
    for (let i = 1; i < placements.length; i++) {
      const boundarySec = placements[i].startMs / 1000;
      const startSec = boundarySec - halfDur;
      parts.push(
        `fade=t=out:st=${startSec.toFixed(3)}:d=${halfDur.toFixed(3)}:alpha=1`,
        `fade=t=in:st=${boundarySec.toFixed(3)}:d=${halfDur.toFixed(3)}:alpha=1`,
      );
    }
    return parts;
  }

  // For fade-through-black: use filter_complex to add alpha, apply fades,
  // then composite over black. This supports unlimited boundaries because
  // each fade operates on the alpha channel independently.
  //
  // Graph: [0:v] → format=yuva420p → fade(alpha) × N → [fg]
  //        color=black → [bg]
  //        [bg][fg] overlay → [out]
  const fadeChain: string[] = [];
  for (let i = 1; i < placements.length; i++) {
    const boundarySec = placements[i].startMs / 1000;
    const startSec = (boundarySec - halfDur).toFixed(3);
    const bs = boundarySec.toFixed(3);
    const hd = halfDur.toFixed(3);
    fadeChain.push(`fade=t=out:st=${startSec}:d=${hd}:alpha=1`);
    fadeChain.push(`fade=t=in:st=${bs}:d=${hd}:alpha=1`);
  }

  // Use scale2ref to match the black background to the video dimensions,
  // then overlay the alpha-faded foreground on top.
  const filterComplex =
    `color=black:s=2x2:r=30[bgraw];` +
    `[0:v]format=yuva420p,${fadeChain.join(',')}[fg];` +
    `[bgraw][fg]scale2ref[bg][fg2];` +
    `[bg][fg2]overlay=shortest=1:format=auto[out]`;

  return { filterComplex, outputLabel: '[out]' };
}
