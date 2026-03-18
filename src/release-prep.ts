/**
 * Pre-release preparation: extract all scene clips and generate a
 * release notes draft from the demo's scene manifest.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractClip } from './clip.js';

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
  return JSON.parse(raw).chapters ?? [];
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export interface ReleasePrepOptions {
  demoName: string;
  outputDir: string;
  demosDir: string;
  includeGif?: boolean;
  gifWidth?: number;
  gifFps?: number;
  version?: string;
}

export async function releasePrep(options: ReleasePrepOptions): Promise<string> {
  const {
    demoName, outputDir, demosDir,
    includeGif = false, gifWidth = 640, gifFps = 10,
    version,
  } = options;

  const videoPath = join(outputDir, `${demoName}.mp4`);
  if (!existsSync(videoPath)) {
    throw new Error(`No exported video at ${videoPath}. Run 'argo pipeline ${demoName}' first.`);
  }

  const chapters = getChapters(videoPath);
  if (chapters.length === 0) {
    throw new Error(`No chapters in ${videoPath}. Re-run the pipeline to embed chapter markers.`);
  }

  // Load manifest for scene descriptions
  const manifestPath = join(demosDir, `${demoName}.scenes.json`);
  let manifest: Array<{ scene: string; text?: string }> = [];
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch { /* ignore */ }
  }
  const sceneTexts = new Map(manifest.map(e => [e.scene, e.text]));

  // Load meta for stats
  const metaPath = join(outputDir, `${demoName}.meta.json`);
  let meta: any = {};
  if (existsSync(metaPath)) {
    try { meta = JSON.parse(readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
  }

  const clipsDir = join(outputDir, 'clips');
  mkdirSync(clipsDir, { recursive: true });

  console.log(`\nExtracting ${chapters.length} scene clips from ${demoName}...\n`);

  const clipPaths: Array<{ scene: string; mp4: string; gif?: string; durationSec: number }> = [];

  for (const chapter of chapters) {
    const scene = chapter.tags.title;
    const durationSec = parseFloat(chapter.end_time) - parseFloat(chapter.start_time);

    // MP4 clip
    process.stdout.write(`  ${scene} (${formatDuration(durationSec)})...`);
    const mp4Path = await extractClip({
      demoName, scene, outputDir, format: 'mp4',
    });

    let gifPath: string | undefined;
    if (includeGif) {
      gifPath = await extractClip({
        demoName, scene, outputDir, format: 'gif', gifWidth, gifFps,
      });
    }

    console.log(` ✓${gifPath ? ' (+ GIF)' : ''}`);
    clipPaths.push({ scene, mp4: mp4Path, gif: gifPath, durationSec });
  }

  // Generate release notes draft
  const totalDuration = clipPaths.reduce((sum, c) => sum + c.durationSec, 0);
  const versionLine = version ? `# ${version}\n\n` : '';

  let notes = `${versionLine}## Demo: ${demoName}\n\n`;
  notes += `Total: ${formatDuration(totalDuration)} · ${chapters.length} scenes\n\n`;
  notes += `| Scene | Duration | Description | Clip |\n`;
  notes += `|-------|----------|-------------|------|\n`;

  for (const clip of clipPaths) {
    const desc = sceneTexts.get(clip.scene) ?? '';
    const shortDesc = desc.length > 80 ? desc.substring(0, 77) + '...' : desc;
    const clipLink = clip.gif
      ? `[MP4](${clip.mp4}) · [GIF](${clip.gif})`
      : `[MP4](${clip.mp4})`;
    notes += `| ${clip.scene} | ${formatDuration(clip.durationSec)} | ${shortDesc} | ${clipLink} |\n`;
  }

  notes += `\n### Clips\n\n`;
  notes += `All clips saved to \`${clipsDir}/\`:\n\n`;
  notes += `\`\`\`\n`;
  for (const clip of clipPaths) {
    notes += `${clip.mp4}\n`;
    if (clip.gif) notes += `${clip.gif}\n`;
  }
  notes += `\`\`\`\n`;

  // Write the draft
  const notesPath = join(clipsDir, `${demoName}-release-notes.md`);
  writeFileSync(notesPath, notes, 'utf-8');

  console.log(`\n✓ ${clipPaths.length} clips extracted`);
  if (includeGif) console.log(`✓ ${clipPaths.length} GIFs generated`);
  console.log(`✓ Release notes draft: ${notesPath}`);

  return notesPath;
}
