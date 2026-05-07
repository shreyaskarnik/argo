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
   * Returns the full file path for a cached transcript (word-level
   * timestamps from Whisper). Lives next to the audio clip and shares
   * its content hash so clip cache hits ride along — but folds the
   * Whisper model id into the filename so swapping models doesn't bust
   * the (much more expensive) audio cache.
   */
  getTranscriptPath(demoName: string, entry: ManifestEntry, model: string): string {
    const hash = this.computeHash(entry);
    const modelTag = sanitizeModelId(model);
    return path.join(
      this.projectRoot,
      '.argo',
      demoName,
      'clips',
      `${hash}.${modelTag}.transcript.json`,
    );
  }

  /**
   * Checks whether a clip is already cached on disk.
   */
  isCached(demoName: string, entry: ManifestEntry): boolean {
    return fs.existsSync(this.getClipPath(demoName, entry));
  }

  /** Whether a transcript for this clip+model pair is already cached. */
  isTranscriptCached(demoName: string, entry: ManifestEntry, model: string): boolean {
    return fs.existsSync(this.getTranscriptPath(demoName, entry, model));
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

/** Make a Hugging Face model id safe to embed in a filename — strip the
 *  org slash and any other non-word chars. `onnx-community/whisper-base.en`
 *  → `onnx-community-whisper-base-en`. Preserves enough that it remains
 *  human-readable when ls'ing the clips dir. */
function sanitizeModelId(model: string): string {
  return model.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
