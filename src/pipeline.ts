import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { generateClips } from './tts/generate.js';
import { record } from './record.js';
import { alignClips, type ClipInfo, type SceneTiming } from './tts/align.js';
import { parseWavHeader, createWavBuffer } from './tts/engine.js';
import { exportVideo, checkFfmpeg } from './export.js';
import { generateFramePng } from './frame.js';
import { generateSrt, generateVtt } from './subtitles.js';
import { generateChapterMetadata } from './chapters.js';
import { buildSceneReport, formatSceneReport } from './report.js';
import { applySpeedRampToTimeline, type SceneSpeedMap } from './speed-ramp.js';
import { scaleCameraMoves, shiftCameraMoves, type CameraMove } from './camera-move.js';
import {
  resolveFreezes,
  adjustPlacementsForFreezes,
  totalFreezeDurationMs,
  type FreezeSpec,
} from './freeze.js';
import { resolveExportSize, type ArgoConfig } from './config.js';
import { getVideoDurationMs } from './media.js';
import { buildOverlayPngsForImport } from './overlays/render-to-png.js';
import { renderShaderTransitions } from './transitions/shader-render.js';
// Note: MusicGen (AI music generation) is a preview-only feature — runs in browser via WebGPU.
// Pipeline uses saved WAV files via audio.music config path.
import {
  buildPlacementsFromTimingAndDurations,
  buildSceneTexts,
  computeHeadTrimMs,
  readScenesManifest,
  shiftPlacements,
} from './timeline.js';

export interface PipelineOptions {
  headed?: boolean;
  /** Override `video.retries` for this run. */
  retries?: number;
}

/**
 * Read the per-demo composition audio sidecar written by `renderComposition`
 * for each hyperframes-block <audio> child. Returns one entry per audio track
 * with its absolute path + scene-relative start time. Empty array if the
 * sidecar doesn't exist (no compositions in the demo, or none had audio).
 */
function readCompositionAudioSidecar(argoDir: string): Array<{ src: string; startMs: number; volume?: number }> {
  const sidecar = join(argoDir, '.composition-audio.jsonl');
  if (!existsSync(sidecar)) return [];
  const tracks: Array<{ src: string; startMs: number; volume?: number }> = [];
  for (const line of readFileSync(sidecar, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { src?: string; startMs?: number; volume?: number };
      if (parsed.src && typeof parsed.startMs === 'number') {
        tracks.push({ src: parsed.src, startMs: parsed.startMs, volume: parsed.volume });
      }
    } catch { /* malformed line — skip */ }
  }
  return tracks;
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

  const exportSize = resolveExportSize(config);

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

  // Note: AI music generation (MusicGen) is a preview-only feature.
  // Users generate + audition clips in the browser (WebGPU), then save
  // the selected WAV. Pipeline uses the saved file via audio.music.

  // Step 2: Record browser demo. When captureMode is 'jpeg-stitch', the recorder
  // (narration.startRecording) spawns an ffmpeg child and streams JPEGs from the
  // CDP screencast directly into libx264 — no separate stitch step is needed; the
  // mp4 lands inline at .argo/<demo>/video.mp4. Avoids Playwright's hardcoded VP8.
  console.log('🎬 Rolling camera...');
  const { timingPath, videoPath } = await record(demoName, {
    demosDir: config.demosDir,
    baseURL: config.baseURL,
    video: { width: config.video.width, height: config.video.height, fps: config.video.fps },
    browser: config.video.browser,
    deviceScaleFactor: config.video.deviceScaleFactor,
    isMobile: config.video.isMobile,
    hasTouch: config.video.hasTouch,
    contextOptions: config.video.contextOptions,
    autoBackground: config.overlays.autoBackground,
    defaultPlacement: config.overlays.defaultPlacement,
    allowRawGsap: config.overlays.allowRawGsap,
    showActions: config.video.showActions,
    sceneThumbnails: config.video.sceneThumbnails,
    captureMode: config.video.captureMode,
    jpegQuality: config.video.jpegQuality,
    retries: pipelineOpts?.retries ?? config.video.retries,
    experimentalCanvasDrawElement: config.video.experimentalCanvasDrawElement,
    browserChannel: config.video.browserChannel,
    // Compositions loaded via file:// need file-from-file fetches for relative
    // assets (GLTF, textures). Default on when html-in-canvas is enabled —
    // both flags travel together for renderComposition's use case.
    allowFileAccessFromFiles: config.video.experimentalCanvasDrawElement,
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

  // Use actual video duration for alignment (videoPath was returned by record() above)
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

  // Read per-scene playback speeds from scenes manifest
  const manifestPath = `${config.demosDir}/${demoName}.scenes.json`;
  const sceneSpeeds: SceneSpeedMap = {};
  let rawManifest: Array<{ scene?: string; playbackSpeed?: number; post?: Array<{ type?: string; atMs?: number; durationMs?: number }> }> = [];
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    for (const entry of rawManifest) {
      if (entry.scene && typeof entry.playbackSpeed === 'number' && entry.playbackSpeed !== 1.0) {
        sceneSpeeds[entry.scene] = entry.playbackSpeed;
      }
    }
  } catch { /* handled elsewhere */ }

  const speedRampPlan = applySpeedRampToTimeline(
    shiftedPlacements,
    shiftedDurationMs,
    config.export.speedRamp,
    Object.keys(sceneSpeeds).length > 0 ? sceneSpeeds : undefined,
  );

  // Read freeze-frame holds from scenes manifest `post` arrays
  const freezeSpecs: FreezeSpec[] = [];
  try {
    for (const entry of rawManifest) {
      if (!entry.scene || !Array.isArray(entry.post)) continue;
      for (const effect of entry.post) {
        if (
          effect.type === 'freeze' &&
          typeof effect.atMs === 'number' &&
          typeof effect.durationMs === 'number'
        ) {
          freezeSpecs.push({
            scene: entry.scene,
            atMs: effect.atMs,
            durationMs: effect.durationMs,
          });
        }
      }
    }
  } catch {
    // Manifest read errors are handled elsewhere — freezes are best-effort
  }

  // Resolve freeze specs to absolute timeline positions and adjust placements
  const resolvedFreezes = resolveFreezes(freezeSpecs, speedRampPlan.placements);
  const finalPlacements = adjustPlacementsForFreezes(speedRampPlan.placements, resolvedFreezes);
  const freezeAddedMs = totalFreezeDurationMs(resolvedFreezes);
  const finalDurationMs = speedRampPlan.totalDurationMs + freezeAddedMs;

  // Ensure output directory exists before writing subtitles
  mkdirSync(config.outputDir, { recursive: true });

  // Build scene text map for subtitles
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

  // Render overlay PNGs for imported videos (no Playwright recording step)
  const overlayPngs = await buildOverlayPngsForImport({
    argoDir: '.argo',
    demoName,
    manifestPath,
    placements: finalPlacements,
    videoWidth: exportSize.width,
    videoHeight: exportSize.height,
    deviceScaleFactor: config.video.deviceScaleFactor,
  });

  // Step 4: Export final video
  console.log('🎞️  Cutting the final take...');
  const exportOptions: Parameters<typeof exportVideo>[0] = {
    demoName,
    argoDir: '.argo',
    outputDir: config.outputDir,
    preset: config.export.preset,
    crf: config.export.crf,
    fps: config.video.fps,
    outputWidth: exportSize.width,
    outputHeight: exportSize.height,
    deviceScaleFactor: config.video.deviceScaleFactor,
    thumbnailPath: config.export.thumbnailPath,
    chapterMetadataPath,
    formats: config.export.formats,
    transition: config.export.transition,
    placements: finalPlacements,
    totalDurationMs: finalDurationMs,
    speedRampSegments: speedRampPlan.segments,
    loudnorm: config.export.audio?.loudnorm,
    musicPath: config.export.audio?.music,
    musicVolume: config.export.audio?.musicVolume,
    // Composition audio sidecar (written by renderComposition for each
    // <audio> child of a hyperframes block). Each entry gets adelayed to
    // its scene start in the export mix.
    extraAudioTracks: readCompositionAudioSidecar(argoDir),
    watermark: config.export.watermark,
    sharpen: config.export.sharpen,
    frame: config.export.frame,
    motionBlur: config.export.motionBlur,
    overlayPngs,
    encoder: config.export.encoder,
    encoderDefault: 'cpu',
  };

  // Pre-render frame PNG for faster encoding
  if (config.export.frame) {
    const framePngPath = join(argoDir, 'frame.png');
    const outW = exportSize.width;
    const outH = exportSize.height;
    const pngResult = generateFramePng(framePngPath, outW, outH, config.export.frame);
    if (pngResult) {
      exportOptions.framePngPath = pngResult;
    }
  }
  if (resolvedFreezes.length > 0) {
    exportOptions.freezeSpecs = resolvedFreezes;
  }
  if (tailPadMs !== undefined) exportOptions.tailPadMs = tailPadMs;
  if (headTrimMs > 0) exportOptions.headTrimMs = headTrimMs;

  // Apply camera moves — shift for head trim, then scale from CSS layout
  // coordinates to the final export dimensions when those differ.
  if (cameraMoves.length > 0) {
    let moves = shiftCameraMoves(cameraMoves, headTrimMs);
    const scaleX = exportSize.width / config.video.width;
    const scaleY = exportSize.height / config.video.height;
    moves = scaleCameraMoves(moves, scaleX, scaleY);
    exportOptions.cameraMoves = moves;
  }

  // Pre-render shader transition frames when transition type is 'shader'
  if (config.export?.transition?.type === 'shader' && finalPlacements.length > 1) {
    const shaderTransition = config.export.transition;
    // finalPlacements are post-trim; frame extraction needs pre-trim timestamps
    const boundaries = finalPlacements.slice(1).map(p => ({
      boundarySec: (p.startMs + headTrimMs) / 1000,
      durationMs: shaderTransition.durationMs ?? 800,
    }));
    const rendered = await renderShaderTransitions({
      videoPath,
      boundaries,
      shader: shaderTransition.shader,
      width: exportSize.width,
      height: exportSize.height,
      fps: config.video?.fps ?? 30,
      cacheDir: join(argoDir, 'shaders'),
    });
    // Remap boundarySec from pre-trim back to post-trim for the filter_complex splice
    exportOptions.shaderTransitions = rendered.map((r, i) => ({
      ...r,
      boundarySec: finalPlacements[i + 1].startMs / 1000,
    }));
  }

  const outputPath = await exportVideo(exportOptions);

  // Scene report
  const report = buildSceneReport(demoName, finalPlacements, overflowMs, finalDurationMs, outputPath);
  writeFileSync(join(argoDir, 'scene-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(formatSceneReport(report));

  // Slow-scene warning — surface scenes that took materially longer than the
  // median. Helpful signal when a long demo flakes intermittently: a scene
  // that drifts from 6s → 18s on retries is the most likely culprit.
  if (report.scenes.length >= 3) {
    const durations = report.scenes.map((s) => s.durationMs).sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const slowThreshold = median * 1.75;
    const slow = report.scenes.filter((s) => s.durationMs > slowThreshold);
    if (slow.length > 0) {
      const lines = slow.map((s) => `    · ${s.scene}: ${(s.durationMs / 1000).toFixed(1)}s (median ${(median / 1000).toFixed(1)}s)`);
      console.warn(
        `\n⚠ Slow scenes (>${(slowThreshold / 1000).toFixed(1)}s, more than 1.75× median):\n${lines.join('\n')}`
      );
    }
  }

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
        video: { width: variant.video.width, height: variant.video.height, fps: config.video.fps },
        browser: config.video.browser,
        deviceScaleFactor: config.video.deviceScaleFactor,
        isMobile: config.video.isMobile,
        hasTouch: config.video.hasTouch,
        contextOptions: config.video.contextOptions,
        autoBackground: config.overlays.autoBackground,
        defaultPlacement: config.overlays.defaultPlacement,
        allowRawGsap: config.overlays.allowRawGsap,
        showActions: config.video.showActions,
        sceneThumbnails: config.video.sceneThumbnails,
        captureMode: config.video.captureMode,
        jpegQuality: config.video.jpegQuality,
        retries: pipelineOpts?.retries ?? config.video.retries,
        experimentalCanvasDrawElement: config.video.experimentalCanvasDrawElement,
        browserChannel: config.video.browserChannel,
        allowFileAccessFromFiles: config.video.experimentalCanvasDrawElement,
        headed: pipelineOpts?.headed,
        argoSubdir: variantSubdir,
      });

      // Align with shared TTS clips
      const variantTiming: SceneTiming = JSON.parse(readFileSync(variantRecord.timingPath, 'utf-8'));
      const variantVideoPath = variantRecord.videoPath;
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

      // Resolve freeze-frame holds for variant
      const variantResolvedFreezes = resolveFreezes(freezeSpecs, variantPlacements);
      if (variantResolvedFreezes.length > 0) {
        variantPlacements = adjustPlacementsForFreezes(variantPlacements, variantResolvedFreezes);
        variantShiftedDurationMs += totalFreezeDurationMs(variantResolvedFreezes);
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
      }

      // Render overlay PNGs for imported video variants
      const variantOverlayPngs = await buildOverlayPngsForImport({
        argoDir: '.argo',
        demoName: variantSubdir,
        manifestPath,
        placements: variantPlacements,
        videoWidth: variant.video.width,
        videoHeight: variant.video.height,
        deviceScaleFactor: config.video.deviceScaleFactor,
      });

      // Pre-render shader transitions for this variant
      let variantShaderTransitions;
      if (config.export?.transition?.type === 'shader' && variantPlacements.length > 1) {
        const shaderTransition = config.export.transition;
        // variantPlacements are post-trim; frame extraction needs pre-trim timestamps
        const variantBoundaries = variantPlacements.slice(1).map(p => ({
          boundarySec: (p.startMs + variantHeadTrimMs) / 1000,
          durationMs: shaderTransition.durationMs ?? 800,
        }));
        const variantRendered = await renderShaderTransitions({
          videoPath: variantVideoPath,
          boundaries: variantBoundaries,
          shader: shaderTransition.shader,
          width: variant.video.width,
          height: variant.video.height,
          fps: config.video?.fps ?? 30,
          cacheDir: join('.argo', variantSubdir, 'shaders'),
        });
        // Remap boundarySec to post-trim for the filter_complex splice
        variantShaderTransitions = variantRendered.map((r, i) => ({
          ...r,
          boundarySec: variantPlacements[i + 1].startMs / 1000,
        }));
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
        musicPath: config.export.audio?.music,
        musicVolume: config.export.audio?.musicVolume,
        cameraMoves: variantCameraMoves.length > 0 ? variantCameraMoves : undefined,
        watermark: config.export.watermark,
        sharpen: config.export.sharpen,
        frame: config.export.frame,
        framePngPath: exportOptions.framePngPath, // reuse pre-rendered PNG
        motionBlur: config.export.motionBlur,
        freezeSpecs: variantResolvedFreezes.length > 0 ? variantResolvedFreezes : undefined,
        overlayPngs: variantOverlayPngs,
        shaderTransitions: variantShaderTransitions,
        encoder: config.export.encoder,
        encoderDefault: 'cpu',
      });

      console.log(`🚀 Variant saved to: ${variantOutputPath}`);
    }
  }

  return outputPath;
}
