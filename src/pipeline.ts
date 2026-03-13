import { generateClips } from './tts/generate.js';
import { record } from './record.js';
import { exportVideo, checkFfmpeg } from './export.js';
import type { ArgoConfig } from './config.js';

export async function runPipeline(
  demoName: string,
  config: Pick<ArgoConfig, 'baseURL' | 'demosDir' | 'outputDir' | 'tts' | 'video' | 'export'>
): Promise<string> {
  checkFfmpeg();

  // Step 1: Generate TTS
  await generateClips({
    manifestPath: `${config.demosDir}/${demoName}.voiceover.json`,
    demoName,
    engine: config.tts.engine!,
    projectRoot: '.',
    defaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
  });

  // Step 2: Record
  await record(demoName, {
    demosDir: config.demosDir,
    baseURL: config.baseURL!,
    video: { width: config.video.width, height: config.video.height },
  });

  // Step 3: Export
  const outputPath = await exportVideo({
    demoName,
    argoDir: '.argo',
    outputDir: config.outputDir,
    preset: config.export.preset,
    crf: config.export.crf,
    fps: config.video.fps,
    width: config.video.width,
    height: config.video.height,
  });

  return outputPath;
}
