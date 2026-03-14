import type { Placement } from './tts/align.js';

export interface SceneReport {
  demo: string;
  totalDurationMs: number;
  overflowMs: number;
  scenes: {
    scene: string;
    startMs: number;
    endMs: number;
    durationMs: number;
  }[];
  output: string;
}

export function buildSceneReport(
  demo: string,
  placements: Placement[],
  overflowMs: number,
  totalDurationMs: number,
  outputPath: string,
): SceneReport {
  return {
    demo,
    totalDurationMs,
    overflowMs,
    scenes: placements.map((p) => ({
      scene: p.scene,
      startMs: p.startMs,
      endMs: p.endMs,
      durationMs: p.endMs - p.startMs,
    })),
    output: outputPath,
  };
}

export function formatSceneReport(report: SceneReport): string {
  const lines: string[] = [];
  lines.push(`Scene report: ${report.demo}`);
  lines.push(`${'─'.repeat(50)}`);

  for (const s of report.scenes) {
    const start = (s.startMs / 1000).toFixed(1).padStart(6);
    const end = (s.endMs / 1000).toFixed(1).padStart(6);
    const dur = (s.durationMs / 1000).toFixed(1).padStart(5);
    lines.push(`  ${s.scene.padEnd(24)} ${start}s → ${end}s  (${dur}s)`);
  }

  lines.push(`${'─'.repeat(50)}`);
  lines.push(`  Total: ${(report.totalDurationMs / 1000).toFixed(1)}s`);
  if (report.overflowMs > 0) {
    lines.push(`  Overflow: ${(report.overflowMs / 1000).toFixed(1)}s (video padded)`);
  }
  lines.push(`  Output: ${report.output}`);

  return lines.join('\n');
}
