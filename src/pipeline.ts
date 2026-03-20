import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { generateClips } from './tts/generate.js';
import { record } from './record.js';
import { alignClips, type ClipInfo, type SceneTiming } from './tts/align.js';
import { parseWavHeader, createWavBuffer } from './tts/engine.js';
import { exportVideo, checkFfmpeg } from './export.js';
import { generateSrt, generateVtt } from './subtitles.js';
import { generateChapterMetadata } from './chapters.js';
import { buildSceneReport, formatSceneReport } from './report.js';
import { applySpeedRampToTimeline } from './speed-ramp.js';
import { shiftCameraMoves, scaleCameraMoves, type CameraMove } from './camera-move.js';
import type { ArgoConfig } from './config.js';
import { getVideoDurationMs } from './media.js';
import {
  buildPlacementsFromTimingAndDurations,
  buildSceneTexts,
  computeHeadTrimMs,
  readScenesManifest,
  shiftPlacements,
} from './timeline.js';

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
  mkdirSync(argoDir, { recursive: true });

  // Step 1: Generate TTS clips
  console.log('🎙️  Brewing voiceover clips...');
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
  console.log('🎬 Rolling camera...');
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

  // Read camera moves if recorded by zoomTo with narration option
  let cameraMoves: CameraMove[] = [];
  const cameraMovesPath = join(argoDir, '.timing.camera-moves.json');
  try {
    if (existsSync(cameraMovesPath)) {
      cameraMoves = JSON.parse(readFileSync(cameraMovesPath, 'utf-8'));
    }
  } catch {
    // Camera moves are optional — don't fail the pipeline
  }

  // Use actual video duration for alignment
  const videoPath = join(argoDir, 'video.webm');
  const totalDurationMs = getVideoDurationMs(videoPath);

  let tailPadMs: number | undefined;
  let overflowMs = 0;
  let shiftedPlacements: Array<{ scene: string; startMs: number; endMs: number }> = [];
  let shiftedDurationMs = totalDurationMs;

  // Auto-trim: skip setup before first scene mark (with 200ms lead-in)
  const headTrimMs = computeHeadTrimMs(timing);

  if (!isSilent) {
    console.log('🎧 Mixing the soundtrack...');

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

    const allPlacements = buildPlacementsFromTimingAndDurations(timing, sceneDurations, totalDurationMs);
    shiftedPlacements = shiftPlacements(allPlacements, headTrimMs);
    shiftedDurationMs = Math.max(totalDurationMs, aligned.requiredDurationMs) - headTrimMs;
  } else {
    console.log('★ Silent mode — no voiceover clips');
    shiftedDurationMs = totalDurationMs - headTrimMs;
    shiftedPlacements = shiftPlacements(
      buildPlacementsFromTimingAndDurations(timing, sceneDurations, totalDurationMs),
      headTrimMs,
    );
  }

  const speedRampPlan = applySpeedRampToTimeline(
    shiftedPlacements,
    shiftedDurationMs,
    config.export.speedRamp,
  );
  const finalPlacements = speedRampPlan.placements;
  const finalDurationMs = speedRampPlan.totalDurationMs;

  // Ensure output directory exists before writing subtitles
  mkdirSync(config.outputDir, { recursive: true });

  // Build scene text map for subtitles
  const manifestPath = `${config.demosDir}/${demoName}.scenes.json`;
  try {
    const sceneTexts = buildSceneTexts(readScenesManifest(manifestPath));

    // Generate subtitles on the final export timeline.
    const srt = generateSrt(finalPlacements, sceneTexts);
    const vtt = generateVtt(finalPlacements, sceneTexts);
    writeFileSync(join(config.outputDir, `${demoName}.srt`), srt, 'utf-8');
    writeFileSync(join(config.outputDir, `${demoName}.vtt`), vtt, 'utf-8');
  } catch {
    // Subtitles are best-effort — don't fail the pipeline
  }

  // Generate chapter metadata for ffmpeg
  const chapterMetadataPath = join(argoDir, 'chapters.txt');
  const chapterMetadata = generateChapterMetadata(finalPlacements, finalDurationMs);
  writeFileSync(chapterMetadataPath, chapterMetadata, 'utf-8');

  // Step 4: Export final video
  console.log('🎞️  Cutting the final take...');
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
    placements: finalPlacements,
    totalDurationMs: finalDurationMs,
    speedRampSegments: speedRampPlan.segments,
    loudnorm: config.export.audio?.loudnorm,
  };
  if (tailPadMs !== undefined) exportOptions.tailPadMs = tailPadMs;
  if (headTrimMs > 0) exportOptions.headTrimMs = headTrimMs;

  // Apply camera moves — shift for head trim, scale for deviceScaleFactor
  if (cameraMoves.length > 0) {
    let moves = shiftCameraMoves(cameraMoves, headTrimMs);
    moves = scaleCameraMoves(moves, config.video.deviceScaleFactor ?? 1);
    exportOptions.cameraMoves = moves;
  }

  const outputPath = await exportVideo(exportOptions);

  // Scene report
  const report = buildSceneReport(demoName, finalPlacements, overflowMs, finalDurationMs, outputPath);
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

  console.log(`\n🚀 That's a wrap! Video saved to: ${outputPath}`);

  // Viewport-native variants — re-record at different viewports
  const variants = config.export.variants;
  if (variants && variants.length > 0) {
    for (const variant of variants) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`  📐 Variant: ${variant.name} (${variant.video.width}×${variant.video.height})`);
      console.log(`${'─'.repeat(50)}\n`);

      const variantArgoDir = join('.argo', `${demoName}-${variant.name}`);
      mkdirSync(variantArgoDir, { recursive: true });

      // Copy scene durations (TTS is shared)
      writeFileSync(
        join(variantArgoDir, '.scene-durations.json'),
        JSON.stringify(sceneDurations, null, 2),
        'utf-8',
      );

      // Record at variant viewport
      const variantSubdir = `${demoName}-${variant.name}`;
      console.log('🎬 Rolling camera...');
      const variantRecord = await record(demoName, {
        demosDir: config.demosDir,
        baseURL: config.baseURL,
        video: { width: variant.video.width, height: variant.video.height },
        browser: config.video.browser,
        deviceScaleFactor: config.video.deviceScaleFactor,
        isMobile: config.video.isMobile,
        hasTouch: config.video.hasTouch,
        contextOptions: config.video.contextOptions,
        autoBackground: config.overlays.autoBackground,
        defaultPlacement: config.overlays.defaultPlacement,
        headed: pipelineOpts?.headed,
        argoSubdir: variantSubdir,
      });

      // Align with shared TTS clips
      const variantTiming: SceneTiming = JSON.parse(readFileSync(variantRecord.timingPath, 'utf-8'));
      const variantVideoPath = join('.argo', variantSubdir, 'video.webm');
      const variantDurationMs = getVideoDurationMs(variantVideoPath);
      const variantHeadTrimMs = computeHeadTrimMs(variantTiming);

      let variantPlacements: Array<{ scene: string; startMs: number; endMs: number }> = [];
      let variantShiftedDurationMs = variantDurationMs;

      if (!isSilent) {
        console.log('🎧 Mixing the soundtrack...');
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

        const variantAligned = alignClips(variantTiming, clips, variantDurationMs);
        const variantAlignedPath = join('.argo', variantSubdir, 'narration-aligned.wav');
        writeFileSync(variantAlignedPath, createWavBuffer(variantAligned.samples, 24000));

        variantPlacements = variantAligned.placements.map(p => ({
          scene: p.scene,
          startMs: Math.max(0, p.startMs - variantHeadTrimMs),
          endMs: Math.max(0, p.endMs - variantHeadTrimMs),
        }));
        variantShiftedDurationMs = variantDurationMs - variantHeadTrimMs;
      }

      // Export variant
      console.log('🎞️  Cutting the final take...');
      const variantChapterPath = join('.argo', variantSubdir, 'chapters.txt');
      writeFileSync(variantChapterPath, generateChapterMetadata(variantPlacements, variantShiftedDurationMs), 'utf-8');

      // Subtitles — read from manifest file directly for text field
      const variantSceneTexts: Record<string, string> = {};
      try {
        const rawManifest: Array<{ scene?: string; text?: string }> = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        for (const entry of rawManifest) {
          if (entry.scene && entry.text) variantSceneTexts[entry.scene] = entry.text;
        }
      } catch { /* ignore */ }
      mkdirSync(config.outputDir, { recursive: true });
      try {
        writeFileSync(join(config.outputDir, `${demoName}.${variant.name}.srt`), generateSrt(variantPlacements, variantSceneTexts), 'utf-8');
        writeFileSync(join(config.outputDir, `${demoName}.${variant.name}.vtt`), generateVtt(variantPlacements, variantSceneTexts), 'utf-8');
      } catch { /* subtitles are best-effort */ }

      // Read camera moves for this variant if recorded
      let variantCameraMoves: CameraMove[] = [];
      const variantCameraMovesPath = join('.argo', variantSubdir, '.timing.camera-moves.json');
      try {
        if (existsSync(variantCameraMovesPath)) {
          variantCameraMoves = JSON.parse(readFileSync(variantCameraMovesPath, 'utf-8'));
        }
      } catch { /* optional */ }

      if (variantCameraMoves.length > 0) {
        variantCameraMoves = shiftCameraMoves(variantCameraMoves, variantHeadTrimMs);
        variantCameraMoves = scaleCameraMoves(variantCameraMoves, config.video.deviceScaleFactor ?? 1);
      }

      const variantOutputPath = await exportVideo({
        demoName: variantSubdir,
        argoDir: '.argo',
        outputDir: config.outputDir,
        preset: config.export.preset,
        crf: config.export.crf,
        fps: config.video.fps,
        outputWidth: variant.video.width,
        outputHeight: variant.video.height,
        chapterMetadataPath: variantChapterPath,
        transition: config.export.transition,
        placements: variantPlacements,
        totalDurationMs: variantShiftedDurationMs,
        headTrimMs: variantHeadTrimMs > 0 ? variantHeadTrimMs : undefined,
        loudnorm: config.export.audio?.loudnorm,
        cameraMoves: variantCameraMoves.length > 0 ? variantCameraMoves : undefined,
      });

      console.log(`🚀 Variant saved to: ${variantOutputPath}`);
    }
  }

  return outputPath;
}
