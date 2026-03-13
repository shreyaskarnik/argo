import { Command } from 'commander';
import { loadConfig } from './config.js';
import { record } from './record.js';
import { generateClips } from './tts/generate.js';
import { exportVideo } from './export.js';
import { runPipeline } from './pipeline.js';
import { init } from './init.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('argo')
    .description('Turn Playwright demo scripts into polished product demo videos with AI voiceover')
    .option('-c, --config <path>', 'path to config file');

  program
    .command('record <demo>')
    .description('Record a demo using Playwright')
    .action(async (demo: string) => {
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      await record(demo, {
        demosDir: config.demosDir,
        baseURL: config.baseURL!,
        video: { width: config.video.width, height: config.video.height },
      });
    });

  const tts = program
    .command('tts')
    .description('TTS commands');

  tts
    .command('generate <manifest>')
    .description('Generate TTS clips from a manifest file')
    .action(async (manifest: string) => {
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      await generateClips({
        manifestPath: manifest,
        demoName: manifest.replace(/\.voiceover\.json$/, '').replace(/\.json$/, ''),
        engine: config.tts.engine!,
        projectRoot: '.',
        defaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
      });
    });

  tts
    .command('align <demo>')
    .description('Align TTS clips with video')
    .action(async (demo: string) => {
      console.log(`tts align: ${demo} — not yet implemented`);
    });

  program
    .command('export <demo>')
    .description('Export demo to MP4')
    .action(async (demo: string) => {
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      await exportVideo({
        demoName: demo,
        argoDir: '.argo',
        outputDir: config.outputDir,
        preset: config.export.preset,
        crf: config.export.crf,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
      });
    });

  program
    .command('pipeline <demo>')
    .description('Run the full pipeline: TTS → record → export')
    .action(async (demo: string) => {
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      await runPipeline(demo, config);
    });

  program
    .command('init')
    .description('Initialize a new Argo project')
    .action(async () => {
      await init();
    });

  return program;
}

const url = import.meta.url;
if (url && process.argv[1] && url.endsWith(process.argv[1])) {
  createProgram().parseAsync(process.argv).catch((err) => { console.error(err.message); process.exit(1); });
}
