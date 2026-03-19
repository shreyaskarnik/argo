import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { schedulePlacements, type Placement } from './tts/align.js';
import type { CameraMove } from './camera-move.js';

export interface SceneDurationOptions {
  leadInMs?: number;
  leadOutMs?: number;
  minMs?: number;
  maxMs?: number;
  multiplier?: number;
  fallbackMs?: number;
}

export class NarrationTimeline {
  private timings: Map<string, number> = new Map();
  private startTime: number | null = null;
  private sceneDurations: Record<string, number> = {};
  private cachedPlacements: Placement[] | null = null;
  private _cameraMoves: CameraMove[] = [];

  constructor(sceneDurations?: Record<string, number>) {
    if (sceneDurations) {
      this.sceneDurations = sceneDurations;
    }
  }

  start(): void {
    this.startTime = Date.now();
    this.timings = new Map();
    this.cachedPlacements = null;
  }

  mark(scene: string): void {
    if (this.startTime === null) {
      throw new Error('Cannot mark before start() has been called');
    }
    if (this.timings.has(scene)) {
      throw new Error(`Duplicate scene name: "${scene}"`);
    }
    this.timings.set(scene, Date.now() - this.startTime);
    this.cachedPlacements = null;
  }

  /**
   * Record a camera move (zoom/pan) to be applied as an ffmpeg post-export effect.
   * Call this during recording with the target element's bounding box.
   */
  recordCameraMove(move: Omit<CameraMove, 'startMs'> & { startMs?: number }): void {
    if (this.startTime === null) {
      throw new Error('Cannot record camera move before start() has been called');
    }
    const startMs = move.startMs ?? (Date.now() - this.startTime);
    this._cameraMoves.push({ ...move, startMs });
  }

  getCameraMoves(): CameraMove[] {
    return [...this._cameraMoves];
  }

  getTimings(): Record<string, number> {
    return Object.fromEntries(this.timings);
  }

  async flush(outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(this.getTimings(), null, 2), 'utf-8');

    // Write camera moves to a sidecar file if any were recorded
    if (this._cameraMoves.length > 0) {
      const cameraMovesPath = outputPath.replace(/\.json$/, '') + '.camera-moves.json';
      await writeFile(cameraMovesPath, JSON.stringify(this._cameraMoves, null, 2), 'utf-8');
    }
  }

  private getBaseDuration(scene: string, options?: SceneDurationOptions): number {
    const clipMs = this.sceneDurations[scene];
    const fallback = options?.fallbackMs ?? 3000;
    if (clipMs === undefined) return fallback;

    const raw = clipMs * (options?.multiplier ?? 1)
      + (options?.leadInMs ?? 200)
      + (options?.leadOutMs ?? 400);

    const min = options?.minMs ?? 2200;
    const max = options?.maxMs ?? 8000;
    return Math.max(min, Math.min(max, raw));
  }

  private getPlacements(): Placement[] {
    if (this.cachedPlacements) return this.cachedPlacements;

    const scheduledScenes = Array.from(this.timings.entries())
      .filter(([name]) => this.sceneDurations[name] !== undefined)
      .map(([name, startMs]) => ({
        scene: name,
        startMs,
        durationMs: this.sceneDurations[name],
      }));

    this.cachedPlacements = schedulePlacements(scheduledScenes);
    return this.cachedPlacements;
  }

  /**
   * Compute a hold duration for a scene based on its TTS clip length.
   * Use for overlay durations and passive reading time — not for
   * page loads, click completion, or selector readiness.
   *
   * When the scene has already been marked, this returns the remaining wait
   * from "now", not the full scene duration. It also accounts for any audio
   * backlog caused by earlier clips running long.
   */
  durationFor(scene: string, options?: SceneDurationOptions): number {
    const baseDurationMs = this.getBaseDuration(scene, options);
    if (this.startTime === null) return baseDurationMs;

    const markMs = this.timings.get(scene);
    if (markMs === undefined) return baseDurationMs;

    const placement = this.getPlacements().find((p) => p.scene === scene);
    if (!placement) return baseDurationMs;

    const leadOutMs = options?.leadOutMs ?? 400;
    const desiredEndMs = Math.max(
      markMs + baseDurationMs,
      placement.endMs + leadOutMs,
    );
    const nowMs = Math.max(0, Date.now() - this.startTime);

    return Math.max(0, Math.ceil(desiredEndMs - nowMs));
  }
}
