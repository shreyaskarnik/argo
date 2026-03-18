/**
 * Extract a scene clip from an exported MP4 using chapter markers.
 *
 * Reads chapter metadata embedded in the MP4 to find the scene's
 * start/end timestamps, then extracts a clip. Supports MP4 (copy)
 * and GIF (palette-optimized) output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

interface Chapter {
  start_time: string;
  end_time: string;
  tags: { title: string };
}

function getChapters(videoPath: string): Chapter[] {
  const raw = execFileSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_chapters',
    videoPath,
  ], { encoding: 'utf-8' });

  const parsed = JSON.parse(raw);
  return parsed.chapters ?? [];
}

export interface ClipOptions {
  demoName: string;
  scene: string;
  outputDir: string;
  format?: 'mp4' | 'gif';
  /** GIF width in pixels (default: 640) */
  gifWidth?: number;
  /** GIF framerate (default: 10) */
  gifFps?: number;
}

export async function extractClip(options: ClipOptions): Promise<string> {
  const { demoName, scene, outputDir, format = 'mp4', gifWidth = 640, gifFps = 10 } = options;
  const videoPath = join(outputDir, `${demoName}.mp4`);

  if (!existsSync(videoPath)) {
    throw new Error(
      `No exported video found at ${videoPath}. Run 'argo pipeline ${demoName}' first.`
    );
  }

  const chapters = getChapters(videoPath);
  if (chapters.length === 0) {
    throw new Error(
      `No chapters found in ${videoPath}. The video may have been exported without chapter markers.`
    );
  }

  const chapter = chapters.find(c => c.tags.title === scene);
  if (!chapter) {
    const available = chapters.map(c => c.tags.title).join(', ');
    throw new Error(
      `Scene "${scene}" not found in ${demoName}. Available scenes: ${available}`
    );
  }

  const startSec = parseFloat(chapter.start_time);
  const endSec = parseFloat(chapter.end_time);
  const clipsDir = join(outputDir, 'clips');
  mkdirSync(clipsDir, { recursive: true });

  if (format === 'gif') {
    const outputPath = join(clipsDir, `${demoName}-${scene}.gif`);
    // Two-pass palette-optimized GIF
    const palettePath = join(clipsDir, `.palette-${demoName}-${scene}.png`);
    const filters = `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos`;

    execFileSync('ffmpeg', [
      '-ss', String(startSec),
      '-to', String(endSec),
      '-i', videoPath,
      '-vf', `${filters},palettegen=stats_mode=diff`,
      '-y', palettePath,
    ], { stdio: 'pipe' });

    execFileSync('ffmpeg', [
      '-ss', String(startSec),
      '-to', String(endSec),
      '-i', videoPath,
      '-i', palettePath,
      '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
      '-y', outputPath,
    ], { stdio: 'pipe' });

    // Clean up palette
    try { execFileSync('rm', [palettePath]); } catch { /* ignore */ }

    return outputPath;
  }

  // MP4: stream copy (fast, no re-encoding)
  const outputPath = join(clipsDir, `${demoName}-${scene}.mp4`);
  execFileSync('ffmpeg', [
    '-ss', String(startSec),
    '-to', String(endSec),
    '-i', videoPath,
    '-c', 'copy',
    '-y', outputPath,
  ], { stdio: 'pipe' });

  return outputPath;
}
