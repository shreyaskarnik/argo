import { describe, it, expect } from 'vitest';
import { buildSceneReport, formatSceneReport } from '../src/report.js';
import type { Placement } from '../src/tts/align.js';

const placements: Placement[] = [
  { scene: 'intro', startMs: 1000, endMs: 4000 },
  { scene: 'closing', startMs: 5000, endMs: 8000 },
];

describe('buildSceneReport', () => {
  it('builds report with correct structure', () => {
    const report = buildSceneReport('test', placements, 0, 10000, 'videos/test.mp4');
    expect(report.demo).toBe('test');
    expect(report.totalDurationMs).toBe(10000);
    expect(report.overflowMs).toBe(0);
    expect(report.output).toBe('videos/test.mp4');
    expect(report.scenes).toHaveLength(2);
  });

  it('computes per-scene durationMs', () => {
    const report = buildSceneReport('test', placements, 0, 10000, 'out.mp4');
    expect(report.scenes[0].durationMs).toBe(3000);
    expect(report.scenes[1].durationMs).toBe(3000);
  });
});

describe('formatSceneReport', () => {
  it('includes scene names and timing', () => {
    const report = buildSceneReport('test', placements, 0, 10000, 'out.mp4');
    const formatted = formatSceneReport(report);
    expect(formatted).toContain('intro');
    expect(formatted).toContain('closing');
    expect(formatted).toContain('Total: 10.0s');
    expect(formatted).toContain('out.mp4');
  });

  it('includes overflow when present', () => {
    const report = buildSceneReport('test', placements, 2000, 10000, 'out.mp4');
    const formatted = formatSceneReport(report);
    expect(formatted).toContain('Overflow: 2.0s');
  });
});
