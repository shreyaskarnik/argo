import { Command, Option } from 'commander';
import { loadConfig, type ArgoConfig, type BrowserEngine } from './config.js';
import { record } from './record.js';
import { generateClips } from './tts/generate.js';
import { exportVideo } from './export.js';
import { runPipeline } from './pipeline.js';
import { init } from './init.js';

async function ensureTTSEngine(config: ArgoConfig): Promise<ArgoConfig> {
  if (!config.tts.engine) {
    const { KokoroEngine } = await import('./tts/kokoro.js');
    config.tts.engine = new KokoroEngine();
  }
  return config;
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('argo')
    .description('Turn Playwright demo scripts into polished product demo videos with AI voiceover')
    .option('-c, --config <path>', 'path to config file');

  program
    .command('record <demo>')
    .description('Record a demo using Playwright')
    .addOption(new Option('--browser <engine>', 'browser engine').choices(['chromium', 'webkit', 'firefox']))
    .action(async (demo: string, cmdOpts: { browser?: string }) => {
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      if (!config.baseURL) {
        throw new Error('baseURL is required but not set. Set it in argo.config.js or pass --config.');
      }
      const browser = (cmdOpts.browser as BrowserEngine) ?? config.video.browser;
      await record(demo, {
        demosDir: config.demosDir,
        baseURL: config.baseURL,
        video: { width: config.video.width, height: config.video.height },
        browser,
        deviceScaleFactor: config.video.deviceScaleFactor,
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
      const config = await ensureTTSEngine(await loadConfig(process.cwd(), configPath));
      await generateClips({
        manifestPath: manifest,
        demoName: manifest.replace(/^.*\//, '').replace(/\.voiceover\.json$/, '').replace(/\.json$/, ''),
        engine: config.tts.engine!,
        projectRoot: '.',
        defaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
      });
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
      });
    });

  program
    .command('pipeline <demo>')
    .description('Run the full pipeline: TTS → record → export')
    .addOption(new Option('--browser <engine>', 'browser engine').choices(['chromium', 'webkit', 'firefox']))
    .action(async (demo: string, cmdOpts: { browser?: string }) => {
      const configPath = program.opts().config;
      const loaded = await ensureTTSEngine(await loadConfig(process.cwd(), configPath));
      const config = cmdOpts.browser
        ? { ...loaded, video: { ...loaded.video, browser: cmdOpts.browser as BrowserEngine } }
        : loaded;
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

if (process.env.VITEST === undefined) {
  createProgram().parseAsync(process.argv).catch((err) => { console.error(err.message); process.exit(1); });
}
