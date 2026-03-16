import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { generateClips } from './tts/generate.js';
import { record } from './record.js';
import { alignClips, type ClipInfo, type SceneTiming } from './tts/align.js';
import { parseWavHeader, createWavBuffer } from './tts/engine.js';
import { exportVideo, checkFfmpeg } from './export.js';
import { generateSrt, generateVtt } from './subtitles.js';
import { generateChapterMetadata } from './chapters.js';
import { buildSceneReport, formatSceneReport } from './report.js';
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

  if (clipResults.length === 0) {
    throw new Error(
      `No TTS clips were generated from ${config.demosDir}/${demoName}.scenes.json. ` +
      `Ensure the manifest contains at least one entry.`
    );
  }

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
    autoBackground: config.overlays.autoBackground,
    defaultPlacement: config.overlays.defaultPlacement,
    headed: pipelineOpts?.headed,
  });

  // Step 3: Align clips with timing
  console.log('★ Mixing the soundtrack...');
  let timing: SceneTiming;
  try {
    timing = JSON.parse(readFileSync(timingPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to parse timing file at ${timingPath}: ${(err as Error).message}. ` +
      `The file may be corrupt from an interrupted recording. Try re-running: argo record ${demoName}`
    );
  }

  // Load WAV clips into memory
  const clips: ClipInfo[] = clipResults.map((cr) => {
    const wavBuf = readFileSync(cr.clipPath);
    const header = parseWavHeader(wavBuf);
    // Extract Float32 samples from the data chunk
    const sampleCount = header.dataSize / 4; // 32-bit float = 4 bytes
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount && header.dataOffset + i * 4 + 3 < wavBuf.length; i++) {
      samples[i] = wavBuf.readFloatLE(header.dataOffset + i * 4);
    }
    return {
      scene: cr.scene,
      durationMs: header.durationMs,
      samples,
    };
  });

  // Use actual video duration for alignment
  const videoPath = join(argoDir, 'video.webm');
  const totalDurationMs = getVideoDurationMs(videoPath);

  const aligned = alignClips(timing, clips, totalDurationMs);
  const alignedWav = createWavBuffer(aligned.samples, 24_000);
  const alignedPath = join(argoDir, 'narration-aligned.wav');
  writeFileSync(alignedPath, alignedWav);
  const tailPadMs = aligned.overflowMs > 0 ? aligned.overflowMs + 100 : undefined;

  if (tailPadMs !== undefined) {
    console.warn(
      `Aligned narration runs ${aligned.overflowMs}ms past the recording. ` +
      `Padding the final video frame to preserve the full audio.`
    );
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

    // Generate subtitles
    const srt = generateSrt(aligned.placements, sceneTexts);
    const vtt = generateVtt(aligned.placements, sceneTexts);
    writeFileSync(join(config.outputDir, `${demoName}.srt`), srt, 'utf-8');
    writeFileSync(join(config.outputDir, `${demoName}.vtt`), vtt, 'utf-8');
  } catch {
    // Subtitles are best-effort — don't fail the pipeline
  }

  // Generate chapter metadata for ffmpeg
  const chapterMetadataPath = join(argoDir, 'chapters.txt');
  const chapterMetadata = generateChapterMetadata(aligned.placements, Math.max(totalDurationMs, aligned.requiredDurationMs));
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
  };
  if (tailPadMs !== undefined) exportOptions.tailPadMs = tailPadMs;
  const outputPath = await exportVideo(exportOptions);

  // Scene report
  const report = buildSceneReport(demoName, aligned.placements, aligned.overflowMs, totalDurationMs, outputPath);
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
    },
    output: outputPath,
  };
  writeFileSync(join(config.outputDir, `${demoName}.meta.json`), JSON.stringify(pipelineMeta, null, 2) + '\n', 'utf-8');

  console.log(`\n✓ That's a wrap! Video saved to: ${outputPath}`);
  return outputPath;
}
