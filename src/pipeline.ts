import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { generateClips } from './tts/generate.js';
import { record } from './record.js';
import { alignClips, type ClipInfo, type SceneTiming } from './tts/align.js';
import { parseWavHeader, createWavBuffer } from './tts/engine.js';
import { exportVideo, checkFfmpeg } from './export.js';
import { generateSrt, generateVtt } from './subtitles.js';
import { generateChapterMetadata } from './chapters.js';
import { buildSceneReport, formatSceneReport } from './report.js';
import { computeSegments, applySpeedRamp } from './speed-ramp.js';
import type { ArgoConfig } from './config.js';

function getVideoDurationMs(videoPath: string): number {
  let raw: string;
  try {
    raw = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath],
      { encoding: 'utf-8' },
    ).trim();
  } catch (err) {
    throw new Error(
      `Failed to get video duration from ${videoPath}. ` +
      `Ensure ffprobe is installed (it usually comes with ffmpeg). ` +
      `Original error: ${(err as Error).message}`
    );
  }
  const durationMs = Math.round(parseFloat(raw) * 1000);
  if (isNaN(durationMs) || durationMs <= 0) {
    throw new Error(
      `ffprobe returned invalid duration "${raw}" for ${videoPath}. The video file may be corrupt.`
    );
  }
  return durationMs;
}

export interface PipelineOptions {
  headed?: boolean;
}

/**
 * Discover all demo names in the demos directory by looking for `.scenes.json` files.
 */
export function discoverDemos(demosDir: string): string[] {
  try {
    return readdirSync(demosDir)
      .filter((f) => f.endsWith('.scenes.json'))
      .map((f) => basename(f).replace(/\.scenes\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Run the pipeline for all demos in the demosDir.
 */
export async function runBatchPipeline(
  config: Pick<ArgoConfig, 'baseURL' | 'demosDir' | 'outputDir' | 'tts' | 'video' | 'export' | 'overlays'>,
  pipelineOpts?: PipelineOptions,
): Promise<string[]> {
  const demos = discoverDemos(config.demosDir);
  if (demos.length === 0) {
    throw new Error(`No demos found in ${config.demosDir}/ (no .scenes.json files)`);
  }

  console.log(`Found ${demos.length} demo(s): ${demos.join(', ')}\n`);
  const results: string[] = [];

  for (const demo of demos) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Pipeline: ${demo}`);
    console.log(`${'═'.repeat(60)}\n`);
    try {
      const output = await runPipeline(demo, config, pipelineOpts);
      results.push(output);
    } catch (err) {
      console.error(`\n✗ Pipeline failed for ${demo}: ${(err as Error).message}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Batch complete: ${results.length}/${demos.length} succeeded`);
  console.log(`${'═'.repeat(60)}\n`);
  return results;
}

export async function runPipeline(
  demoName: string,
  config: Pick<ArgoConfig, 'baseURL' | 'demosDir' | 'outputDir' | 'tts' | 'video' | 'export' | 'overlays'>,
  pipelineOpts?: PipelineOptions,
): Promise<string> {
  if (!config.baseURL) {
    throw new Error(
      'baseURL is required but not set. Set it in argo.config.js or pass --config.'
    );
  }
  if (!config.tts.engine) {
    throw new Error('TTS engine is not configured. Ensure config.tts.engine is set.');
  }

  checkFfmpeg();

  const argoDir = join('.argo', demoName);

  // Step 1: Generate TTS clips
  console.log('★ Brewing voiceover clips...');
  const clipResults = await generateClips({
    manifestPath: `${config.demosDir}/${demoName}.scenes.json`,
    demoName,
    engine: config.tts.engine,
    projectRoot: '.',
    defaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
  });

  const isSilent = clipResults.length === 0;

  // Write scene durations so demo scripts can use narration.durationFor()
  const sceneDurations: Record<string, number> = {};
  for (const cr of clipResults) {
    sceneDurations[cr.scene] = cr.durationMs;
  }
  const sceneDurationsPath = join(argoDir, '.scene-durations.json');
  writeFileSync(sceneDurationsPath, JSON.stringify(sceneDurations, null, 2), 'utf-8');

  // Step 2: Record browser demo
  console.log('★ Rolling camera...');
  const { timingPath } = await record(demoName, {
    demosDir: config.demosDir,
    baseURL: config.baseURL,
    video: { width: config.video.width, height: config.video.height },
    browser: config.video.browser,
    deviceScaleFactor: config.video.deviceScaleFactor,
    isMobile: config.video.isMobile,
    hasTouch: config.video.hasTouch,
    contextOptions: config.video.contextOptions,
    autoBackground: config.overlays.autoBackground,
    defaultPlacement: config.overlays.defaultPlacement,
    headed: pipelineOpts?.headed,
  });

  // Step 3: Align clips with timing
  let timing: SceneTiming;
  try {
    timing = JSON.parse(readFileSync(timingPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to parse timing file at ${timingPath}: ${(err as Error).message}. ` +
      `The file may be corrupt from an interrupted recording. Try re-running: argo record ${demoName}`
    );
  }

  // Use actual video duration for alignment
  const videoPath = join(argoDir, 'video.webm');
  const totalDurationMs = getVideoDurationMs(videoPath);

  let tailPadMs: number | undefined;
  let overflowMs = 0;
  let shiftedPlacements: Array<{ scene: string; startMs: number; endMs: number }> = [];
  let shiftedDurationMs = totalDurationMs;

  // Auto-trim: skip setup before first scene mark (with 200ms lead-in)
  const markTimes = Object.values(timing);
  let headTrimMs = 0;
  if (markTimes.length > 0) {
    const firstMarkMs = Math.min(...markTimes);
    headTrimMs = Math.max(0, firstMarkMs - 200);
    if (headTrimMs <= 500) headTrimMs = 0;
  }

  if (!isSilent) {
    console.log('★ Mixing the soundtrack...');

    // Load WAV clips into memory
    const clips: ClipInfo[] = clipResults.map((cr) => {
      const wavBuf = readFileSync(cr.clipPath);
      const header = parseWavHeader(wavBuf);
      const sampleCount = header.dataSize / 4;
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount && header.dataOffset + i * 4 + 3 < wavBuf.length; i++) {
        samples[i] = wavBuf.readFloatLE(header.dataOffset + i * 4);
      }
      return { scene: cr.scene, durationMs: header.durationMs, samples };
    });

    const aligned = alignClips(timing, clips, totalDurationMs);
    const alignedWav = createWavBuffer(aligned.samples, 24_000);
    writeFileSync(join(argoDir, 'narration-aligned.wav'), alignedWav);
    overflowMs = aligned.overflowMs;
    tailPadMs = overflowMs > 0 ? overflowMs + 100 : undefined;

    if (tailPadMs !== undefined) {
      console.warn(
        `Aligned narration runs ${aligned.overflowMs}ms past the recording. ` +
        `Padding the final video frame to preserve the full audio.`
      );
    }

    // Merge voiced placements with silent scenes (scenes that have timing marks but no TTS clips)
    const voicedScenes = new Set(aligned.placements.map(p => p.scene));
    const sortedMarks = Object.entries(timing).sort((a, b) => a[1] - b[1]);
    const silentPlacements = sortedMarks
      .filter(([scene]) => !voicedScenes.has(scene))
      .map(([scene, startMs], _i, arr) => {
        const idx = sortedMarks.findIndex(([s]) => s === scene);
        const endMs = idx + 1 < sortedMarks.length ? sortedMarks[idx + 1][1] : totalDurationMs;
        return { scene, startMs, endMs };
      });
    const allPlacements = [...aligned.placements, ...silentPlacements].sort((a, b) => a.startMs - b.startMs);

    shiftedPlacements = headTrimMs > 0
      ? allPlacements.map(p => ({ ...p, startMs: p.startMs - headTrimMs, endMs: p.endMs - headTrimMs }))
      : allPlacements;
    shiftedDurationMs = Math.max(totalDurationMs, aligned.requiredDurationMs) - headTrimMs;
  } else {
    console.log('★ Silent mode — no voiceover clips');
    shiftedDurationMs = totalDurationMs - headTrimMs;
    // Build placements from timing marks for chapters (each scene runs until the next mark)
    const sortedMarks = Object.entries(timing).sort((a, b) => a[1] - b[1]);
    shiftedPlacements = sortedMarks.map(([scene, startMs], i) => {
      const endMs = i + 1 < sortedMarks.length ? sortedMarks[i + 1][1] : totalDurationMs;
      return { scene, startMs: startMs - headTrimMs, endMs: endMs - headTrimMs };
    });
  }

  // Ensure output directory exists before writing subtitles
  mkdirSync(config.outputDir, { recursive: true });

  // Build scene text map for subtitles
  const manifestPath = `${config.demosDir}/${demoName}.scenes.json`;
  const sceneTexts: Record<string, string> = {};
  try {
    const manifestContent = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    for (const entry of manifestContent) {
      if (entry.scene && entry.text) sceneTexts[entry.scene] = entry.text;
    }

    // Generate subtitles (shifted if head-trimming)
    const srt = generateSrt(shiftedPlacements, sceneTexts);
    const vtt = generateVtt(shiftedPlacements, sceneTexts);
    writeFileSync(join(config.outputDir, `${demoName}.srt`), srt, 'utf-8');
    writeFileSync(join(config.outputDir, `${demoName}.vtt`), vtt, 'utf-8');
  } catch {
    // Subtitles are best-effort — don't fail the pipeline
  }

  // Generate chapter metadata for ffmpeg
  const chapterMetadataPath = join(argoDir, 'chapters.txt');
  const chapterMetadata = generateChapterMetadata(shiftedPlacements, shiftedDurationMs);
  writeFileSync(chapterMetadataPath, chapterMetadata, 'utf-8');

  // Step 4: Export final video
  console.log('★ Cutting the final take...');
  const exportOptions: Parameters<typeof exportVideo>[0] = {
    demoName,
    argoDir: '.argo',
    outputDir: config.outputDir,
    preset: config.export.preset,
    crf: config.export.crf,
    fps: config.video.fps,
    outputWidth: config.video.width,
    outputHeight: config.video.height,
    deviceScaleFactor: config.video.deviceScaleFactor,
    thumbnailPath: config.export.thumbnailPath,
    chapterMetadataPath,
    formats: config.export.formats,
    transition: config.export.transition,
    placements: shiftedPlacements,
    totalDurationMs: shiftedDurationMs,
  };
  if (tailPadMs !== undefined) exportOptions.tailPadMs = tailPadMs;
  if (headTrimMs > 0) exportOptions.headTrimMs = headTrimMs;

  const outputPath = await exportVideo(exportOptions);

  // Step 4b: Speed ramp — compress gaps between scenes
  if (config.export.speedRamp && config.export.speedRamp.gapSpeed > 1.0 && shiftedPlacements.length > 0) {
    console.log(`★ Applying speed ramp (${config.export.speedRamp.gapSpeed}× gaps)...`);
    const hasAudioFile = !isSilent;
    const segments = computeSegments(shiftedPlacements, shiftedDurationMs, config.export.speedRamp);
    if (segments.length > 0) {
      await applySpeedRamp(outputPath, segments, hasAudioFile, config.export.preset, config.export.crf);
    }
  }

  // Scene report
  const report = buildSceneReport(demoName, shiftedPlacements, overflowMs, shiftedDurationMs, outputPath);
  writeFileSync(join(argoDir, 'scene-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(formatSceneReport(report));

  // Pipeline metadata — provenance tracking for voices, settings, resolution
  const manifest: Array<{ scene: string; voice?: string; speed?: number }> = (() => {
    try { return JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch { return []; }
  })();
  const pipelineMeta = {
    demo: demoName,
    createdAt: new Date().toISOString(),
    video: {
      width: config.video.width,
      height: config.video.height,
      fps: config.video.fps,
      browser: config.video.browser,
      deviceScaleFactor: config.video.deviceScaleFactor ?? 1,
    },
    tts: config.tts.engine?.describe?.() ?? { engine: 'unknown' },
    scenes: manifest.map((entry) => ({
      scene: entry.scene,
      voice: entry.voice ?? config.tts.defaultVoice,
      speed: entry.speed ?? config.tts.defaultSpeed,
      durationMs: sceneDurations[entry.scene] ?? 0,
    })),
    export: {
      preset: config.export.preset,
      crf: config.export.crf,
      headTrimMs: headTrimMs > 0 ? headTrimMs : undefined,
    },
    output: outputPath,
  };
  writeFileSync(join(config.outputDir, `${demoName}.meta.json`), JSON.stringify(pipelineMeta, null, 2) + '\n', 'utf-8');

  console.log(`\n✓ That's a wrap! Video saved to: ${outputPath}`);
  return outputPath;
}
