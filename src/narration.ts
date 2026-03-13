import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class NarrationTimeline {
  private timings: Map<string, number> = new Map();
  private startTime: number | null = null;

  start(): void {
    this.startTime = Date.now();
    this.timings = new Map();
  }

  mark(scene: string): void {
    if (this.startTime === null) {
      throw new Error('Cannot mark before start() has been called');
    }
    if (this.timings.has(scene)) {
      throw new Error(`Duplicate scene name: "${scene}"`);
    }
    this.timings.set(scene, Date.now() - this.startTime);
  }

  getTimings(): Record<string, number> {
    return Object.fromEntries(this.timings);
  }

  async flush(outputPath: string): Promise<void> {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(this.getTimings(), null, 2), 'utf-8');
  }
}
