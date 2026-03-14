/**
 * Content-addressed clip cache for Argo TTS output.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ManifestEntry {
  scene: string;
  text: string;
  voice?: string;
  speed?: number;
  lang?: string;
}

export class ClipCache {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Returns the full file path for a cached clip.
   */
  getClipPath(demoName: string, entry: ManifestEntry): string {
    const hash = this.computeHash(entry);
    return path.join(this.projectRoot, '.argo', demoName, 'clips', `${hash}.wav`);
  }

  /**
   * Checks whether a clip is already cached on disk.
   */
  isCached(demoName: string, entry: ManifestEntry): boolean {
    return fs.existsSync(this.getClipPath(demoName, entry));
  }

  /**
   * Returns the cached WAV buffer, or null if not cached.
   */
  getCachedClip(demoName: string, entry: ManifestEntry): Buffer | null {
    const clipPath = this.getClipPath(demoName, entry);
    if (!fs.existsSync(clipPath)) {
      return null;
    }
    return fs.readFileSync(clipPath);
  }

  /**
   * Writes a WAV buffer to the cache, creating directories as needed.
   */
  cacheClip(demoName: string, entry: ManifestEntry, wavBuffer: Buffer): void {
    const clipPath = this.getClipPath(demoName, entry);
    fs.mkdirSync(path.dirname(clipPath), { recursive: true });
    fs.writeFileSync(clipPath, wavBuffer);
  }

  private computeHash(entry: ManifestEntry): string {
    const { scene, text, voice, speed, lang } = entry;
    return crypto
      .createHash('sha256')
      .update(JSON.stringify({ scene, text, voice, speed, lang }))
      .digest('hex');
  }
}
