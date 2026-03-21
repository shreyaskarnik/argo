import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { getVideoDurationMs, getVideoDimensions } from './media.js';

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);

export interface ImportOptions {
  videoPath: string;
  demo?: string;
  /** Directory for scenes manifests. Default: 'demos'. */
  demosDir?: string;
  cwd?: string;
  /** Overwrite existing scaffold files (.scenes.json, .timing.json). */
  force?: boolean;
}

export interface ImportResult {
  demoName: string;
  demoDir: string;
  durationMs: number;
  /** Video dimensions probed from the source file. */
  dimensions?: { width: number; height: number };
}

/**
 * Sanitize a filename into a valid demo name: [a-zA-Z0-9][a-zA-Z0-9_-]*
 * Replaces invalid characters with hyphens, collapses runs, trims edges.
 */
function sanitizeDemoName(filename: string): string {
  // Strip extension
  const name = basename(filename, extname(filename));
  // Replace anything not alphanumeric, hyphen, or underscore with hyphen
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-');
  // Collapse consecutive hyphens
  sanitized = sanitized.replace(/-+/g, '-');
  // Trim leading/trailing hyphens and underscores
  sanitized = sanitized.replace(/^[-_]+|[-_]+$/g, '');
  // Must start with alphanumeric
  if (!sanitized || !/^[a-zA-Z0-9]/.test(sanitized)) {
    throw new Error(
      `Cannot derive a valid demo name from "${filename}". Use --demo <name> to specify one.`,
    );
  }
  return sanitized;
}

export async function importVideo(options: ImportOptions): Promise<ImportResult> {
  const { videoPath, cwd = process.cwd(), force = false } = options;

  // 1. Validate video file exists
  const resolvedVideoPath = join(cwd, videoPath);
  const absVideoPath = existsSync(videoPath) ? videoPath : resolvedVideoPath;
  if (!existsSync(absVideoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  // 2. Validate extension
  const ext = extname(absVideoPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported video format "${ext}". Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
    );
  }

  // 3. Derive demo name
  const demoName = options.demo ?? sanitizeDemoName(basename(absVideoPath));

  // Validate demo name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(demoName)) {
    throw new Error(
      `Invalid demo name "${demoName}": only letters, numbers, hyphens, and underscores are allowed (must start with a letter or number).`,
    );
  }

  // 4. Create .argo/<demo>/ directory
  const demoDir = join(cwd, '.argo', demoName);
  mkdirSync(demoDir, { recursive: true });

  // 5. Copy video with original extension — no renaming to .webm
  // Export and preview both find the video by scanning extensions.
  const destVideoPath = join(demoDir, `video${ext}`);
  copyFileSync(absVideoPath, destVideoPath);

  // 6. Get video duration and dimensions
  const durationMs = getVideoDurationMs(destVideoPath);
  const dimensions = getVideoDimensions(destVideoPath);

  // 7. Create scaffold .scenes.json in demos directory
  const demosDir = join(cwd, options.demosDir ?? 'demos');
  mkdirSync(demosDir, { recursive: true });
  const manifestPath = join(demosDir, `${demoName}.scenes.json`);
  if (force || !existsSync(manifestPath)) {
    const manifest = [
      {
        scene: 'intro',
        text: '',
        overlay: null,
      },
    ];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  // 8. Create .timing.json with single mark at 0ms
  const timingPath = join(demoDir, '.timing.json');
  if (force || !existsSync(timingPath)) {
    writeFileSync(timingPath, JSON.stringify({ intro: 0 }, null, 2) + '\n', 'utf-8');
  }

  // 9. Write .imported marker with metadata so export paths know overlays
  // need PNG compositing and can use the probed video dimensions.
  const importedMeta = {
    importedAt: new Date().toISOString(),
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    durationMs,
  };
  writeFileSync(join(demoDir, '.imported'), JSON.stringify(importedMeta, null, 2) + '\n', 'utf-8');

  return { demoName, demoDir, durationMs, dimensions: dimensions ?? undefined };
}
