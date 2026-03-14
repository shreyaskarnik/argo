import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { generateClips } from './tts/generate.js';
import { record } from './record.js';
import { alignClips, type ClipInfo, type SceneTiming } from './tts/align.js';
import { parseWavHeader, createWavBuffer } from './tts/engine.js';
import { exportVideo, checkFfmpeg } from './export.js';
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

export async function runPipeline(
  demoName: string,
  config: Pick<ArgoConfig, 'baseURL' | 'demosDir' | 'outputDir' | 'tts' | 'video' | 'export' | 'overlays'>
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
  console.log('Step 1/4: Generating TTS clips...');
  const clipResults = await generateClips({
    manifestPath: `${config.demosDir}/${demoName}.voiceover.json`,
    demoName,
    engine: config.tts.engine,
    projectRoot: '.',
    defaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
  });

  if (clipResults.length === 0) {
    throw new Error(
      `No TTS clips were generated from ${config.demosDir}/${demoName}.voiceover.json. ` +
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
  console.log('Step 2/4: Recording browser demo...');
  const { timingPath } = await record(demoName, {
    demosDir: config.demosDir,
    baseURL: config.baseURL,
    video: { width: config.video.width, height: config.video.height },
    browser: config.video.browser,
    deviceScaleFactor: config.video.deviceScaleFactor,
    autoBackground: config.overlays.autoBackground,
  });

  // Step 3: Align clips with timing
  console.log('Step 3/4: Aligning narration with video...');
  const timing: SceneTiming = JSON.parse(readFileSync(timingPath, 'utf-8'));

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

  // Step 4: Export final video
  console.log('Step 4/4: Exporting final video...');
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
  };
  if (tailPadMs !== undefined) exportOptions.tailPadMs = tailPadMs;
  const outputPath = await exportVideo(exportOptions);

  console.log(`Done! Video saved to: ${outputPath}`);
  return outputPath;
}
