import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { getVideoDurationMs } from './media.js';

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);

export interface ImportOptions {
  videoPath: string;
  demo?: string;
  cwd?: string;
}

export interface ImportResult {
  demoName: string;
  demoDir: string;
  durationMs: number;
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
  const { videoPath, cwd = process.cwd() } = options;

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

  // 5. Copy video as video.webm (ffmpeg handles format by content, not extension)
  const destVideoPath = join(demoDir, 'video.webm');
  copyFileSync(absVideoPath, destVideoPath);

  // 6. Get video duration
  const durationMs = getVideoDurationMs(destVideoPath);

  // 7. Create scaffold .scenes.json in demos/ directory
  const demosDir = join(cwd, 'demos');
  mkdirSync(demosDir, { recursive: true });
  const manifestPath = join(demosDir, `${demoName}.scenes.json`);
  if (!existsSync(manifestPath)) {
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
  if (!existsSync(timingPath)) {
    writeFileSync(timingPath, JSON.stringify({ intro: 0 }, null, 2) + '\n', 'utf-8');
  }

  return { demoName, demoDir, durationMs };
}
