/**
 * TTS clip generation with manifest parsing and cache integration.
 */

import fs from 'node:fs';
import type { TTSEngine } from './engine.js';
import { parseWavHeader } from './engine.js';
import { ClipCache, type ManifestEntry } from './cache.js';
import { transcribeWav, warmTranscriber, DEFAULT_WHISPER_MODEL, type WordTiming } from './transcribe.js';

export interface TranscribeConfig {
  /** Whisper model id (HF Hub). Defaults to `onnx-community/whisper-base.en`. */
  model?: string;
  /** Optional language hint passed to Whisper. */
  language?: string;
}

export interface GenerateClipsOptions {
  manifestPath: string;
  demoName: string;
  engine: TTSEngine;
  projectRoot: string;
  defaults?: { voice?: string; speed?: number };
  /** Enable per-clip word-level transcription via Whisper. Off by default
   *  in v0.38.0 — opt in with `tts.transcribe: true` (or pass an object
   *  to override model/language). */
  transcribe?: boolean | TranscribeConfig;
}

export interface ClipResult {
  scene: string;
  clipPath: string;
  durationMs: number;
  /** Per-clip word timestamps (clip-relative). Only populated when
   *  transcription is enabled and succeeded; otherwise undefined. */
  wordTimings?: WordTiming[];
  /** Filesystem path of the cached transcript JSON, when written. */
  transcriptPath?: string;
}

export async function generateClips(options: GenerateClipsOptions): Promise<ClipResult[]> {
  const { manifestPath, demoName, engine, projectRoot, defaults } = options;

  // 1. Check manifest exists
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  // 2. Read and parse JSON
  let rawEntries: unknown[];
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    rawEntries = JSON.parse(content);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Failed to parse manifest ${manifestPath}: ${err.message}`);
    }
    throw err;
  }

  if (!Array.isArray(rawEntries)) {
    throw new Error(`Manifest ${manifestPath} must contain a JSON array`);
  }

  // 3. Validate entries — scene is required, text is optional (empty = silent scene)
  for (const entry of rawEntries) {
    const e = entry as Record<string, unknown>;
    if (typeof e.scene !== 'string') {
      throw new Error('Manifest entry missing required field: scene is required');
    }
  }

  const cache = new ClipCache(projectRoot);

  // Build manifest entries with defaults (skip entries with empty text for silent scenes)
  const entries: { entry: ManifestEntry; clipPath: string }[] = rawEntries
    .filter((raw) => {
      const r = raw as Record<string, unknown>;
      return typeof r.text === 'string' && r.text.trim().length > 0;
    })
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      const entry: ManifestEntry = {
        scene: r.scene as string,
        text: r.text as string,
        voice: (r.voice as string | undefined) ?? defaults?.voice,
        speed: (r.speed as number | undefined) ?? defaults?.speed,
        lang: r.lang as string | undefined,
      };
      return { entry, clipPath: cache.getClipPath(demoName, entry) };
    });

  // Log per-scene status and generate uncached clips sequentially —
  // Kokoro's ONNX runtime is not safe for concurrent generate() calls.
  for (const { entry } of entries) {
    if (cache.isCached(demoName, entry)) {
      console.log(`  ▸ ${entry.scene} (cached)`);
    } else {
      process.stdout.write(`  ▸ ${entry.scene} (generating...)`);
      const wavBuffer = await engine.generate(entry.text, {
        voice: entry.voice,
        speed: entry.speed,
        lang: entry.lang,
      });
      cache.cacheClip(demoName, entry, wavBuffer);
      process.stdout.write(' done\n');
    }
  }

  // Optional Step 4: per-clip word-level transcription via Whisper. Runs
  // sequentially after audio is fully cached so the transcriber model
  // load happens once and is shared across clips.
  const transcribeConfig = normalizeTranscribeConfig(options.transcribe);
  const transcripts = new Map<string, { words: WordTiming[]; path: string }>();

  if (transcribeConfig && entries.length > 0) {
    const model = transcribeConfig.model ?? DEFAULT_WHISPER_MODEL;
    console.log(`✍️  Transcribing for word timestamps (${model})...`);

    let warmed = false;
    for (const { entry, clipPath } of entries) {
      const transcriptPath = cache.getTranscriptPath(demoName, entry, model);

      if (cache.isTranscriptCached(demoName, entry, model)) {
        console.log(`  ▸ ${entry.scene} (cached)`);
        const words = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8')) as WordTiming[];
        transcripts.set(entry.scene, { words, path: transcriptPath });
        continue;
      }

      // Pre-warm only on first cache miss — saves the model-download cost
      // entirely when every clip is already transcribed.
      if (!warmed) {
        await warmTranscriber(model);
        warmed = true;
      }

      process.stdout.write(`  ▸ ${entry.scene} (transcribing...)`);
      try {
        const words = await transcribeWav(clipPath, {
          model,
          language: transcribeConfig.language ?? entry.lang,
        });
        fs.writeFileSync(transcriptPath, JSON.stringify(words, null, 2));
        transcripts.set(entry.scene, { words, path: transcriptPath });
        process.stdout.write(' done\n');
      } catch (err) {
        // Transcription is best-effort — never fail the pipeline because
        // Whisper choked on a clip.
        process.stdout.write(' failed\n');
        console.warn(`  Whisper failed for "${entry.scene}": ${(err as Error).message}`);
      }
    }
  }

  // Read results (all clips now cached)
  return entries.map(({ entry, clipPath }): ClipResult => {
    const wavBuf = fs.readFileSync(clipPath);
    const { durationMs } = parseWavHeader(wavBuf);
    const t = transcripts.get(entry.scene);
    return {
      scene: entry.scene,
      clipPath,
      durationMs,
      wordTimings: t?.words,
      transcriptPath: t?.path,
    };
  });
}

function normalizeTranscribeConfig(
  cfg: GenerateClipsOptions['transcribe'],
): TranscribeConfig | null {
  if (!cfg) return null;
  if (cfg === true) return {};
  return cfg;
}
