export interface ShaderBoundary {
  boundarySec: number;
  durationMs: number;
  /** ffmpeg input index for this boundary's PNG sequence (image2 demuxer). */
  extraInputIndex: number;
}

export interface ShaderSpliceOptions {
  totalDurationSec: number;
  boundaries: ShaderBoundary[];
  videoInputLabel: string;
  audioInputLabel: string | null;
  fps: number;
}

export interface ShaderSpliceResult {
  filterComplex: string;
  videoOutput: string;
  audioOutput: string | null;
}

/**
 * Splice shader PNG sequences into the scene concat at each boundary.
 *
 * Produces (2K+1) segments for K boundaries: scene_a_0 + trans_0 + scene_a_1 + trans_1 + ... + scene_a_K
 * Audio passes through at boundaries, trimmed to match.
 */
export function buildShaderSpliceFilter(opts: ShaderSpliceOptions): ShaderSpliceResult {
  const { totalDurationSec, boundaries, videoInputLabel, audioInputLabel } = opts;
  if (boundaries.length === 0) throw new Error('buildShaderSpliceFilter called with no boundaries');

  const parts: string[] = [];
  const videoLabels: string[] = [];
  const audioLabels: string[] = [];

  // Pre-flight: count active (non-skipped) boundaries. A boundary is dropped when
  // dHalf clamps to ≤0 (overlapping transitions or boundary at video edge).
  // Required to size the upcoming split correctly — ffmpeg errors on unused split
  // output pads.
  let activeCount = 0;
  {
    let cursor = 0;
    for (const b of boundaries) {
      const rawDHalf = b.durationMs / 2000;
      const dHalf = Math.min(rawDHalf, Math.max(0, b.boundarySec - cursor), Math.max(0, totalDurationSec - b.boundarySec));
      if (dHalf > 0) { activeCount++; cursor = b.boundarySec + dHalf; }
    }
  }

  // Explicit split of the source video (and audio) — required when videoInputLabel
  // is a named filter-graph output like `[svpre]` rather than an input ref like
  // `[0:v]`. Input refs fan out implicitly; filter outputs do not, and reusing one
  // multiple times silently falls back to the raw source (causing dimension
  // mismatches when a pre-scale filter was applied).
  //
  // Video consumers: activeCount+1 scene segments (between/after active boundaries —
  // PNG segments come from their own `[N:v]` input, not videoInputLabel).
  // Audio consumers: 2*activeCount+1 — scene segments + transition windows.
  const numVideoSegments = activeCount + 1;
  const numAudioSegments = activeCount * 2 + 1;
  const vSplitLabels = Array.from({ length: numVideoSegments }, (_, i) => `vsrc${i}`);
  parts.push(`${videoInputLabel}split=${numVideoSegments}${vSplitLabels.map(l => `[${l}]`).join('')}`);
  const aSplitLabels: string[] = [];
  if (audioInputLabel) {
    for (let i = 0; i < numAudioSegments; i++) aSplitLabels.push(`asrc${i}`);
    parts.push(`${audioInputLabel}asplit=${numAudioSegments}${aSplitLabels.map(l => `[${l}]`).join('')}`);
  }

  let cursorSec = 0;
  let activeBoundaries = 0;
  let videoSegmentIdx = 0;
  let audioSegmentIdx = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    const rawDHalf = b.durationMs / 2000;

    // Clamp dHalf so the transition window can't overlap the previous one
    // (cursorSec) or exceed the total video duration.
    const maxDHalfFromCursor = Math.max(0, b.boundarySec - cursorSec);
    const maxDHalfFromTotal = Math.max(0, opts.totalDurationSec - b.boundarySec);
    const dHalf = Math.min(rawDHalf, maxDHalfFromCursor, maxDHalfFromTotal);

    // If there's no room for the transition, skip this boundary entirely.
    // Downstream concat count and input indices adjust accordingly.
    if (dHalf <= 0) {
      // Warn once so users notice they configured overlapping transitions
      console.warn(
        `[shader-splice] skipping boundary at ${b.boundarySec.toFixed(2)}s — ` +
        `no room for ${b.durationMs}ms transition (too close to previous boundary or end of video)`,
      );
      continue;
    }

    // TODO: when dHalf is clamped smaller than rawDHalf, the PNG sequence was
    // rendered for the original duration but the splice slot is now shorter —
    // the PNG plays fewer frames before cutting to the next segment. A full fix
    // would regenerate PNG frames at the clamped duration.

    const sceneEnd = b.boundarySec - dHalf;
    const transitionEnd = b.boundarySec + dHalf;

    // setsar=1 normalizes SAR so concat doesn't fail when source and PNG
    // sequence disagree (webkit screencast emits SAR 108:109; PNG is 0:1).
    const vSceneLabel = `ssv${activeBoundaries}`;
    parts.push(
      `[${vSplitLabels[videoSegmentIdx++]}]trim=${cursorSec.toFixed(3)}:${sceneEnd.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[${vSceneLabel}]`,
    );
    videoLabels.push(`[${vSceneLabel}]`);

    if (audioInputLabel) {
      const aSceneLabel = `ssa${activeBoundaries}`;
      parts.push(
        `[${aSplitLabels[audioSegmentIdx++]}]atrim=${cursorSec.toFixed(3)}:${sceneEnd.toFixed(3)},asetpts=PTS-STARTPTS[${aSceneLabel}]`,
      );
      audioLabels.push(`[${aSceneLabel}]`);
    }

    const vTransLabel = `stv${activeBoundaries}`;
    parts.push(`[${b.extraInputIndex}:v]setpts=PTS-STARTPTS,setsar=1[${vTransLabel}]`);
    videoLabels.push(`[${vTransLabel}]`);

    if (audioInputLabel) {
      const aTransLabel = `sta${activeBoundaries}`;
      parts.push(
        `[${aSplitLabels[audioSegmentIdx++]}]atrim=${sceneEnd.toFixed(3)}:${transitionEnd.toFixed(3)},asetpts=PTS-STARTPTS[${aTransLabel}]`,
      );
      audioLabels.push(`[${aTransLabel}]`);
    }

    cursorSec = transitionEnd;
    activeBoundaries++;
  }

  // Final scene segment
  const vLastLabel = `ssv${activeBoundaries}`;
  parts.push(
    `[${vSplitLabels[videoSegmentIdx++]}]trim=${cursorSec.toFixed(3)}:${totalDurationSec.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[${vLastLabel}]`,
  );
  videoLabels.push(`[${vLastLabel}]`);
  if (audioInputLabel) {
    const aLastLabel = `ssa${activeBoundaries}`;
    parts.push(
      `[${aSplitLabels[audioSegmentIdx++]}]atrim=${cursorSec.toFixed(3)}:${totalDurationSec.toFixed(3)},asetpts=PTS-STARTPTS[${aLastLabel}]`,
    );
    audioLabels.push(`[${aLastLabel}]`);
  }

  const n = videoLabels.length;
  if (audioInputLabel) {
    const interleaved = videoLabels.map((v, i) => `${v}${audioLabels[i]}`).join('');
    parts.push(`${interleaved}concat=n=${n}:v=1:a=1[svout][saout]`);
    return { filterComplex: parts.join(';\n'), videoOutput: '[svout]', audioOutput: '[saout]' };
  }
  parts.push(`${videoLabels.join('')}concat=n=${n}:v=1:a=0[svout]`);
  return { filterComplex: parts.join(';\n'), videoOutput: '[svout]', audioOutput: null };
}
