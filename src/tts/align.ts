export type SceneTiming = Record<string, number>;

export interface ClipInfo {
  scene: string;
  durationMs: number;
  samples: Float32Array;
}

export interface Placement {
  scene: string;
  startMs: number;
  endMs: number;
}

export interface AlignResult {
  placements: Placement[];
  samples: Float32Array;
}

const OVERLAP_GAP_MS = 100;

export function alignClips(
  timing: SceneTiming,
  clips: ClipInfo[],
  totalDurationMs: number,
  sampleRate = 24_000,
): AlignResult {
  // 1. Filter to clips with matching scenes
  const matched = clips.filter((c) => c.scene in timing);
  const unmatched = clips.filter((c) => !(c.scene in timing));
  if (unmatched.length > 0) {
    const names = unmatched.map((c) => c.scene).join(', ');
    console.warn(
      `Warning: ${unmatched.length} clip(s) have no matching scene in timing and will be skipped: ${names}. ` +
      `Check that voiceover manifest scene names match narration.mark() calls.`
    );
  }

  // 2. Sort by scene timestamp ascending
  matched.sort((a, b) => timing[a.scene] - timing[b.scene]);

  // 3. Place each clip, preventing overlap
  const placements: Placement[] = [];
  let previousEndMs = 0;

  for (const clip of matched) {
    let startMs = timing[clip.scene];

    // If this would overlap the previous clip, push forward
    if (placements.length > 0 && startMs < previousEndMs) {
      startMs = previousEndMs + OVERLAP_GAP_MS;
    }

    const endMs = startMs + clip.durationMs;
    placements.push({ scene: clip.scene, startMs, endMs });
    previousEndMs = endMs;
  }

  // 4. Create silence buffer
  const totalSamples = Math.round((totalDurationMs / 1000) * sampleRate);
  const output = new Float32Array(totalSamples);

  // 5. Mix each clip's samples into output
  for (let i = 0; i < placements.length; i++) {
    const placement = placements[i];
    const clip = matched[i];
    const startSample = Math.round((placement.startMs / 1000) * sampleRate);

    for (let j = 0; j < clip.samples.length && startSample + j < totalSamples; j++) {
      output[startSample + j] += clip.samples[j];
    }
  }

  return { placements, samples: output };
}
