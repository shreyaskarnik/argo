import { Command, Option } from 'commander';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, type ArgoConfig, type BrowserEngine } from './config.js';
import { record } from './record.js';
import { generateClips } from './tts/generate.js';
import { exportVideo } from './export.js';
import { runPipeline, runBatchPipeline } from './pipeline.js';
import { init, initFrom } from './init.js';
import { startPreviewServer } from './preview.js';
import { startDashboardServer } from './dashboard.js';
import { validateDemo } from './validate.js';
import { runDoctor, formatDoctorResults } from './doctor.js';

function validateDemoName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid demo name "${name}": only letters, numbers, hyphens, and underscores are allowed.`
    );
  }
  return name;
}

async function ensureTTSEngine(config: ArgoConfig): Promise<ArgoConfig> {
  if (!config.tts.engine) {
    const { KokoroEngine } = await import('./tts/kokoro.js');
    config.tts.engine = new KokoroEngine();
  }
  return config;
}

export function createProgram(): Command {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json');
  const program = new Command();

  program
    .name('argo')
    .description('Turn Playwright demo scripts into polished product demo videos with AI voiceover')
    .version(version, '-V, --version', 'output the version number')
    .option('-c, --config <path>', 'path to config file');

  program
    .command('record <demo>')
    .description('Record a demo using Playwright')
    .addOption(new Option('--browser <engine>', 'browser engine').choices(['chromium', 'webkit', 'firefox']))
    .option('--base-url <url>', 'override baseURL from config')
    .option('--headed', 'run browser in headed mode (visible window)')
    .action(async (demo: string, cmdOpts: { browser?: string; baseUrl?: string; headed?: boolean }) => {
      validateDemoName(demo);
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      const baseURL = cmdOpts.baseUrl ?? config.baseURL;
      if (!baseURL) {
        throw new Error('baseURL is required but not set. Set it in argo.config.js, pass --config, or use --base-url.');
      }
      const browser = (cmdOpts.browser as BrowserEngine) ?? config.video.browser;
      await record(demo, {
        demosDir: config.demosDir,
        baseURL,
        video: { width: config.video.width, height: config.video.height },
        browser,
        deviceScaleFactor: config.video.deviceScaleFactor,
        isMobile: config.video.isMobile,
        hasTouch: config.video.hasTouch,
        contextOptions: config.video.contextOptions,
        autoBackground: config.overlays?.autoBackground,
        defaultPlacement: config.overlays?.defaultPlacement,
        headed: cmdOpts.headed,
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
        demoName: basename(manifest).replace(/\.scenes\.json$/, '').replace(/\.voiceover\.json$/, '').replace(/\.json$/, ''),
        engine: config.tts.engine!,
        projectRoot: '.',
        defaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
      });
    });

  program
    .command('export <demo>')
    .description('Export demo to MP4')
    .action(async (demo: string) => {
      validateDemoName(demo);
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      await exportVideo({
        demoName: demo,
        argoDir: '.argo',
        outputDir: config.outputDir,
        preset: config.export.preset,
        crf: config.export.crf,
        fps: config.video.fps,
        outputWidth: config.video.width,
        outputHeight: config.video.height,
        deviceScaleFactor: config.video.deviceScaleFactor,
        thumbnailPath: config.export.thumbnailPath,
        formats: config.export.formats,
        transition: config.export.transition,
      });
    });

  program
    .command('pipeline [demo]')
    .description('Run the full pipeline: TTS → record → export')
    .addOption(new Option('--browser <engine>', 'browser engine').choices(['chromium', 'webkit', 'firefox']))
    .option('--base-url <url>', 'override baseURL from config')
    .option('--headed', 'run browser in headed mode (visible window)')
    .option('--all', 'run pipeline for all demos in demosDir')
    .action(async (demo: string | undefined, cmdOpts: { browser?: string; baseUrl?: string; headed?: boolean; all?: boolean }) => {
      const configPath = program.opts().config;
      const loaded = await ensureTTSEngine(await loadConfig(process.cwd(), configPath));
      let config = cmdOpts.browser
        ? { ...loaded, video: { ...loaded.video, browser: cmdOpts.browser as BrowserEngine } }
        : loaded;
      if (cmdOpts.baseUrl) {
        config = { ...config, baseURL: cmdOpts.baseUrl };
      }

      if (cmdOpts.all) {
        await runBatchPipeline(config, { headed: cmdOpts.headed });
      } else if (demo) {
        validateDemoName(demo);
        await runPipeline(demo, config, { headed: cmdOpts.headed });
      } else {
        throw new Error('Provide a demo name or use --all to run all demos.');
      }
    });

  program
    .command('validate <demo>')
    .description('Validate demo script and manifests without running the pipeline')
    .action(async (demo: string) => {
      validateDemoName(demo);
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      const result = validateDemo({ demoName: demo, demosDir: config.demosDir });

      for (const err of result.errors) {
        console.error(`  ERROR: ${err}`);
      }
      for (const warn of result.warnings) {
        console.warn(`  WARN: ${warn}`);
      }

      if (result.errors.length === 0 && result.warnings.length === 0) {
        console.log(`  ${demo}: all checks passed`);
      } else if (result.errors.length === 0) {
        console.log(`\n  ${demo}: passed with ${result.warnings.length} warning(s)`);
      } else {
        console.error(`\n  ${demo}: ${result.errors.length} error(s), ${result.warnings.length} warning(s)`);
        process.exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description('Check environment: ffmpeg, Playwright, config, assets')
    .action(async () => {
      const results = await runDoctor();
      console.log(formatDoctorResults(results));
      const fails = results.filter(r => r.status === 'fail').length;
      if (fails > 0) process.exitCode = 1;
    });

  program
    .command('preview [demo]')
    .description('Start a browser-based preview server (omit demo name for dashboard)')
    .option('--port <number>', 'server port (default: auto)', parseInt)
    .action(async (demo: string | undefined, cmdOpts: { port?: number }) => {
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);

      if (!demo) {
        // Dashboard mode — list all demos
        const { url } = await startDashboardServer({
          demosDir: config.demosDir,
          outputDir: config.outputDir,
          port: cmdOpts.port,
        });
        console.log(`\nArgo Dashboard running at: ${url}`);
        console.log('Press Ctrl+C to stop.\n');
        await new Promise(() => {});
        return;
      }

      validateDemoName(demo);
      const { url } = await startPreviewServer({
        demoName: demo,
        argoDir: '.argo',
        demosDir: config.demosDir,
        outputDir: config.outputDir,
        port: cmdOpts.port,
        ttsDefaults: {
          voice: config.tts.defaultVoice,
          speed: config.tts.defaultSpeed,
        },
      });
      console.log(`\nArgo Preview running at: ${url}`);
      console.log('Press Ctrl+C to stop.\n');
      // Keep process alive
      await new Promise(() => {});
    });

  program
    .command('init')
    .description('Initialize a new Argo project')
    .option('--from <path>', 'convert an existing Playwright test into an Argo demo')
    .option('--demo <name>', 'demo name (defaults to filename without extension)')
    .action(async (cmdOpts: { from?: string; demo?: string }) => {
      if (cmdOpts.from) {
        if (cmdOpts.demo) validateDemoName(cmdOpts.demo);
        await initFrom({ from: cmdOpts.from, demo: cmdOpts.demo });
      } else {
        await init();
      }
    });

  return program;
}

if (process.env.VITEST === undefined) {
  createProgram().parseAsync(process.argv).catch((err) => { console.error(err.message); process.exit(1); });
}
