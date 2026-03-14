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
  requiredDurationMs: number;
  overflowMs: number;
}

export interface ScheduledSceneInput {
  scene: string;
  startMs: number;
  durationMs: number;
}

export const OVERLAP_GAP_MS = 100;

export function schedulePlacements(scenes: ScheduledSceneInput[]): Placement[] {
  const sorted = [...scenes].sort((a, b) => a.startMs - b.startMs);
  const placements: Placement[] = [];
  let previousEndMs = 0;

  for (const scene of sorted) {
    let startMs = scene.startMs;

    if (placements.length > 0 && startMs < previousEndMs) {
      startMs = previousEndMs + OVERLAP_GAP_MS;
    }

    const endMs = startMs + scene.durationMs;
    placements.push({ scene: scene.scene, startMs, endMs });
    previousEndMs = endMs;
  }

  return placements;
}

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

  if (matched.length === 0 && clips.length > 0) {
    const names = clips.map((c) => c.scene).join(', ');
    throw new Error(
      `None of the ${clips.length} TTS clip(s) matched any scene in the timing data (clips: ${names}). ` +
      `Check that voiceover manifest scene names match narration.mark() calls in the demo script.`
    );
  }

  // 2. Sort by scene timestamp ascending
  matched.sort((a, b) => timing[a.scene] - timing[b.scene]);

  // 3. Place each clip, preventing overlap
  const placements = schedulePlacements(
    matched.map((clip) => ({
      scene: clip.scene,
      startMs: timing[clip.scene],
      durationMs: clip.durationMs,
    })),
  );
  const requiredDurationMs = placements.length > 0
    ? placements[placements.length - 1].endMs
    : 0;
  const overflowMs = Math.max(0, requiredDurationMs - totalDurationMs);

  // 4. Create silence buffer
  const outputDurationMs = Math.max(totalDurationMs, requiredDurationMs);
  const totalSamples = Math.round((outputDurationMs / 1000) * sampleRate);
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

  return { placements, samples: output, requiredDurationMs, overflowMs };
}
