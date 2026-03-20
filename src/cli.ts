import { Command, Option } from 'commander';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { getVideoDurationMs } from './media.js';
import {
  buildPlacementsFromTimingAndDurations,
  buildSceneDurationsFromCache,
  buildSceneTexts,
  computeHeadTrimMs,
  readScenesManifest,
  shiftPlacements,
} from './timeline.js';
import { generateChapterMetadata } from './chapters.js';
import { generateSrt, generateVtt } from './subtitles.js';
import { applySpeedRampToTimeline, type Segment } from './speed-ramp.js';
import { shiftCameraMoves, scaleCameraMoves, type CameraMove } from './camera-move.js';
import { resolveFreezes, adjustPlacementsForFreezes, totalFreezeDurationMs, type FreezeSpec } from './freeze.js';
import type { Placement } from './tts/align.js';

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
      const demoDir = `.argo/${demo}`;
      const timingPath = `${demoDir}/.timing.json`;
      const manifestPath = `${config.demosDir}/${demo}.scenes.json`;
      let chapterMetadataPath: string | undefined;
      let placements: Placement[] | undefined;
      let totalDurationMs: number | undefined;
      let headTrimMs: number | undefined;
      let speedRampSegments: Segment[] | undefined;
      let resolvedFreezes: import('./freeze.js').ResolvedFreeze[] = [];

      if (existsSync(timingPath) && existsSync(manifestPath)) {
        const timing = JSON.parse(readFileSync(timingPath, 'utf-8')) as Record<string, number>;
        const manifestEntries = readScenesManifest(manifestPath);
        const rawVideoDurationMs = getVideoDurationMs(`${demoDir}/video.webm`);
        const sceneDurations = buildSceneDurationsFromCache(
          demo,
          manifestEntries,
          { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
        );
        const untrimmedPlacements = buildPlacementsFromTimingAndDurations(
          timing,
          sceneDurations,
          rawVideoDurationMs,
        );
        const computedHeadTrimMs = computeHeadTrimMs(timing);
        const shiftedPlacements = shiftPlacements(untrimmedPlacements, computedHeadTrimMs);
        const shiftedDurationMs = rawVideoDurationMs - computedHeadTrimMs;
        const speedRampPlan = applySpeedRampToTimeline(
          shiftedPlacements,
          shiftedDurationMs,
          config.export.speedRamp,
        );

        placements = speedRampPlan.placements;
        totalDurationMs = speedRampPlan.totalDurationMs;
        speedRampSegments = speedRampPlan.segments;
        headTrimMs = computedHeadTrimMs > 0 ? computedHeadTrimMs : undefined;

        // Resolve freeze-frame holds from manifest
        const cliFreeze: FreezeSpec[] = [];
        for (const entry of manifestEntries) {
          if (!entry.scene || !Array.isArray((entry as any).post)) continue;
          for (const effect of (entry as any).post) {
            if (effect.type === 'freeze' && typeof effect.atMs === 'number' && typeof effect.durationMs === 'number') {
              cliFreeze.push({ scene: entry.scene, atMs: effect.atMs, durationMs: effect.durationMs });
            }
          }
        }
        const resolvedFreezes = resolveFreezes(cliFreeze, placements);
        if (resolvedFreezes.length > 0) {
          placements = adjustPlacementsForFreezes(placements, resolvedFreezes);
          totalDurationMs += totalFreezeDurationMs(resolvedFreezes);
        }

        chapterMetadataPath = `${demoDir}/chapters.txt`;
        writeFileSync(chapterMetadataPath, generateChapterMetadata(placements, totalDurationMs), 'utf-8');

        const sceneTexts = buildSceneTexts(manifestEntries);
        if (Object.keys(sceneTexts).length > 0) {
          mkdirSync(config.outputDir, { recursive: true });
          writeFileSync(`${config.outputDir}/${demo}.srt`, generateSrt(placements, sceneTexts), 'utf-8');
          writeFileSync(`${config.outputDir}/${demo}.vtt`, generateVtt(placements, sceneTexts), 'utf-8');
        }
      } else {
        console.warn(
          `Warning: missing timing or manifest for ${demo}; exporting without chapters, subtitles, transitions, or speed ramp.`,
        );
      }

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
        chapterMetadataPath,
        formats: config.export.formats,
        transition: chapterMetadataPath ? config.export.transition : undefined,
        placements,
        totalDurationMs,
        headTrimMs,
        speedRampSegments,
        loudnorm: config.export.audio?.loudnorm,
        musicPath: config.export.audio?.music,
        musicVolume: config.export.audio?.musicVolume,
        cameraMoves: (() => {
          const cameraMovesPath = `${demoDir}/.timing.camera-moves.json`;
          try {
            if (existsSync(cameraMovesPath)) {
              let moves: CameraMove[] = JSON.parse(readFileSync(cameraMovesPath, 'utf-8'));
              if (headTrimMs && headTrimMs > 0) moves = shiftCameraMoves(moves, headTrimMs);
              moves = scaleCameraMoves(moves, config.video.deviceScaleFactor ?? 1);
              return moves;
            }
          } catch { /* optional */ }
          return undefined;
        })(),
        watermark: config.export.watermark,
        freezeSpecs: resolvedFreezes.length > 0 ? resolvedFreezes : undefined,
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
        const demos = (await import('./pipeline.js')).discoverDemos(config.demosDir);
        const results = await runBatchPipeline(config, { headed: cmdOpts.headed });
        if (results.length < demos.length) {
          process.exitCode = 1;
        }
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
    .command('release-prep <demo>')
    .description('Extract all scene clips and generate release notes draft')
    .option('--gif', 'also generate GIF for each scene clip')
    .option('--gif-width <pixels>', 'GIF width in pixels (default: 640)', parseInt)
    .option('--gif-fps <fps>', 'GIF framerate (default: 10)', parseInt)
    .option('--version <version>', 'version string for the release notes header')
    .action(async (demo: string, cmdOpts: { gif?: boolean; gifWidth?: number; gifFps?: number; version?: string }) => {
      validateDemoName(demo);
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      const { releasePrep } = await import('./release-prep.js');
      await releasePrep({
        demoName: demo,
        outputDir: config.outputDir,
        demosDir: config.demosDir,
        includeGif: cmdOpts.gif,
        gifWidth: cmdOpts.gifWidth,
        gifFps: cmdOpts.gifFps,
        version: cmdOpts.version,
      });
    });

  program
    .command('clip <demo> <scene>')
    .description('Extract a scene clip from an exported video using chapter markers')
    .option('--format <type>', 'output format: mp4 (default) or gif', 'mp4')
    .option('--gif-width <pixels>', 'GIF width in pixels (default: 640)', parseInt)
    .option('--gif-fps <fps>', 'GIF framerate (default: 10)', parseInt)
    .action(async (demo: string, scene: string, cmdOpts: { format?: string; gifWidth?: number; gifFps?: number }) => {
      validateDemoName(demo);
      const configPath = program.opts().config;
      const config = await loadConfig(process.cwd(), configPath);
      const { extractClip } = await import('./clip.js');
      const outputPath = await extractClip({
        demoName: demo,
        scene,
        outputDir: config.outputDir,
        format: (cmdOpts.format === 'gif' ? 'gif' : 'mp4') as 'mp4' | 'gif',
        gifWidth: cmdOpts.gifWidth,
        gifFps: cmdOpts.gifFps,
      });
      console.log(`\n✓ Clip saved to: ${outputPath}`);
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
          ttsDefaults: { voice: config.tts.defaultVoice, speed: config.tts.defaultSpeed },
          exportConfig: {
            preset: config.export.preset,
            crf: config.export.crf,
            fps: config.video.fps,
            outputWidth: config.video.width,
            outputHeight: config.video.height,
            deviceScaleFactor: config.video.deviceScaleFactor,
            thumbnailPath: config.export.thumbnailPath,
            formats: config.export.formats,
            transition: config.export.transition,
            speedRamp: config.export.speedRamp,
            loudnorm: config.export.audio?.loudnorm,
            musicPath: config.export.audio?.music,
            musicVolume: config.export.audio?.musicVolume,
            watermark: config.export.watermark,
          },
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
        exportConfig: {
          preset: config.export.preset,
          crf: config.export.crf,
          fps: config.video.fps,
          outputWidth: config.video.width,
          outputHeight: config.video.height,
          deviceScaleFactor: config.video.deviceScaleFactor,
          thumbnailPath: config.export.thumbnailPath,
          formats: config.export.formats,
          transition: config.export.transition,
          speedRamp: config.export.speedRamp,
          loudnorm: config.export.audio?.loudnorm,
          musicPath: config.export.audio?.music,
          musicVolume: config.export.audio?.musicVolume,
          watermark: config.export.watermark,
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
