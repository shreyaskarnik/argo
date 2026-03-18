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
 * Build a filter_complex string for fade transitions using split+trim+fade+concat.
 *
 * This is the only reliable way to apply multiple fade transitions in ffmpeg —
 * the fade filter only supports one fade-out per stream instance, so we split
 * the video at each scene boundary, apply fades independently, then concatenate.
 *
 * Both fade-through-black and dissolve use dip-to-black. The difference is
 * duration: dissolve uses a quicker dip (60% of half-duration) for a subtler
 * effect. A true crossfade/dissolve with overlapping blend would require
 * ffmpeg's xfade filter which needs re-encoded segment pairs — not practical
 * for continuous recordings.
 */
function buildFadeFilterComplex(
  placements: Placement[],
  halfDur: number,
  isDissolveDip: boolean,
  videoInputLabel: string,
  audioInputLabel: string | null,
  fps: number,
): { filterComplex: string; videoOutput: string; audioOutput: string | null } {
  // Build boundary times from placements (scene starts after the first)
  const boundaries: number[] = [];
  for (let i = 1; i < placements.length; i++) {
    boundaries.push(placements[i].startMs / 1000);
  }

  // For dissolve, use shorter fade duration for a dip effect
  const fadeDur = isDissolveDip ? halfDur * 0.6 : halfDur;

  const numSegments = boundaries.length + 1;
  const parts: string[] = [];
  const frameSec = 1 / fps;

  // Split video into N segments
  parts.push(`${videoInputLabel}split=${numSegments}${Array.from({ length: numSegments }, (_, i) => `[vs${i}]`).join('')}`);

  // Split audio if present
  if (audioInputLabel) {
    parts.push(`${audioInputLabel}asplit=${numSegments}${Array.from({ length: numSegments }, (_, i) => `[as${i}]`).join('')}`);
  }

  // Trim and fade each segment
  const segLabels: string[] = [];
  const aSegLabels: string[] = [];

  for (let i = 0; i < numSegments; i++) {
    const start = i === 0 ? 0 : boundaries[i - 1];
    const end = i < boundaries.length ? boundaries[i] : '';
    const trimEnd = end !== '' ? `:${(end as number).toFixed(4)}` : '';
    const label = `v${i}`;

    let chain = `[vs${i}]trim=${start.toFixed(4)}${trimEnd},setpts=PTS-STARTPTS`;

    // Fade out at end of segment (except last).
    // End the fade one frame before the cut so the final visible frame of the
    // outgoing segment is already black and cannot "peek" through at the join.
    if (i < boundaries.length) {
      const segDuration = (end as number) - start;
      const fadeEnd = Math.max(0, segDuration - frameSec);
      const effectiveFadeDur = Math.min(fadeDur, fadeEnd);
      if (effectiveFadeDur > 0) {
        const fadeStart = Math.max(0, fadeEnd - effectiveFadeDur);
        chain += `,fade=t=out:st=${fadeStart.toFixed(4)}:d=${effectiveFadeDur.toFixed(4)}`;
      }
    }

    // Fade in at start of segment (except first). The first visible frame of
    // the incoming segment starts black, matching the outgoing black frame.
    if (i > 0) {
      chain += `,fade=t=in:st=0:d=${fadeDur.toFixed(4)}`;
    }

    chain += `[${label}]`;
    parts.push(chain);
    segLabels.push(`[${label}]`);

    // Audio: trim to match video segment, no fading
    if (audioInputLabel) {
      const aLabel = `a${i}`;
      parts.push(`[as${i}]atrim=${start.toFixed(4)}${trimEnd},asetpts=PTS-STARTPTS[${aLabel}]`);
      aSegLabels.push(`[${aLabel}]`);
    }
  }

  // Concat all segments
  const totalConcatSegments = segLabels.length;
  const videoOutput = 'vfaded';
  if (audioInputLabel) {
    const audioOutput = 'afaded';
    const interleaved = segLabels.map((v, i) => `${v}${aSegLabels[i]}`).join('');
    parts.push(`${interleaved}concat=n=${totalConcatSegments}:v=1:a=1[${videoOutput}][${audioOutput}]`);
    return { filterComplex: parts.join(';\n'), videoOutput: `[${videoOutput}]`, audioOutput: `[${audioOutput}]` };
  } else {
    parts.push(`${segLabels.join('')}concat=n=${totalConcatSegments}:v=1:a=0[${videoOutput}]`);
    return { filterComplex: parts.join(';\n'), videoOutput: `[${videoOutput}]`, audioOutput: null };
  }
}

/**
 * Generate ffmpeg transition filters for scene boundaries.
 *
 * Returns either:
 * - Simple string[] for -vf (wipe transitions only)
 * - A filterComplex object for filter_complex (fade/dissolve — uses split+trim+fade+concat)
 */
export function buildTransitionFilters(
  placements: Placement[],
  transition: TransitionConfig,
  hasAudio?: boolean,
  fps: number = 30,
): string[] | { filterComplex: string; videoOutput: string; audioOutput: string | null } {
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

  // Fade-through-black and dissolve use filter_complex with split+trim+fade+concat.
  // This is the only approach that reliably applies multiple fade transitions —
  // ffmpeg's fade filter only supports one fade-out per stream instance.
  const isDissolveDip = transition.type === 'dissolve';
  return buildFadeFilterComplex(
    placements,
    halfDur,
    isDissolveDip,
    '[0:v]',
    hasAudio ? '[1:a]' : null,
    fps,
  );
}
