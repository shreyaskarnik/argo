import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  parsePlaywrightTest,
  generateDemoScript,
  generateVoiceoverSkeleton,
  generateOverlaysSkeleton,
} from './parse-playwright.js';

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await access(filePath);
    console.log(`  skip ${filePath} (already exists)`);
    return false;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw new Error(`Cannot access ${filePath}: ${err.message}`);
    }
    await writeFile(filePath, content, 'utf-8');
    console.log(`  create ${filePath}`);
    return true;
  }
}

const EXAMPLE_DEMO = `import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('example', async ({ page, narration }) => {
  await page.goto('/');

  narration.mark('welcome');
  await showOverlay(page, 'welcome', {
    type: 'lower-third',
    text: 'Welcome to our app',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('welcome'));

  narration.mark('action');
  await withOverlay(page, 'action', {
    type: 'headline-card',
    title: 'Watch this',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    await page.click('button');
    await page.waitForTimeout(narration.durationFor('action'));
  });

  narration.mark('done');
  await showOverlay(page, 'done', {
    type: 'callout',
    text: 'All done!',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('done'));
});
`;

const EXAMPLE_VOICEOVER = JSON.stringify(
  [
    { scene: 'welcome', text: 'Welcome to our app — let me show you around.' },
    { scene: 'action', text: 'It only takes one click to get started.' },
    { scene: 'done', text: "And that's it. You're all set.", voice: 'af_heart' },
  ],
  null,
  2,
) + '\n';

const EXAMPLE_OVERLAYS = JSON.stringify(
  [
    {
      scene: 'welcome',
      type: 'lower-third',
      text: 'Welcome to our app',
    },
    {
      scene: 'action',
      type: 'headline-card',
      placement: 'top-left',
      title: 'One-click setup',
      body: 'Just press the button to get started.',
      motion: 'slide-in',
    },
  ],
  null,
  2,
) + '\n';

const ARGO_CONFIG = `import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: {
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
  },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'webkit',         // webkit > firefox > chromium for video quality on macOS
    // deviceScaleFactor: 2,   // 2x capture + lanczos downscale (known issue with webkit — enable after fix)
  },
  export: {
    preset: 'slow',            // slower = smaller file, higher quality
    crf: 16,                   // 16-28 range (lower = higher quality)
  },
  overlays: {
    autoBackground: true,      // auto-detect dark/light page for overlay contrast
    // defaultPlacement: 'top-right',  // default zone when cue omits placement
  },
});
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';
import config from './argo.config.mjs';

const scale = Math.max(1, Math.round(config.video?.deviceScaleFactor ?? 1));
const width = config.video?.width ?? 1920;
const height = config.video?.height ?? 1080;

export default defineConfig({
  preserveOutput: 'always',
  projects: [
    {
      name: 'demos',
      testDir: 'demos',
      testMatch: '**/*.demo.ts',
      use: {
        browserName: config.video?.browser ?? 'chromium',
        baseURL: process.env.BASE_URL || config.baseURL || 'http://localhost:3000',
        viewport: { width, height },
        deviceScaleFactor: scale,
        video: {
          mode: 'on',
          size: { width: width * scale, height: height * scale },
        },
      },
    },
  ],
});
`;

export async function init(cwd: string = process.cwd()): Promise<void> {
  const demosDir = join(cwd, 'demos');
  await mkdir(demosDir, { recursive: true });

  await writeIfMissing(join(demosDir, 'example.demo.ts'), EXAMPLE_DEMO);
  await writeIfMissing(join(demosDir, 'example.voiceover.json'), EXAMPLE_VOICEOVER);
  await writeIfMissing(join(demosDir, 'example.overlays.json'), EXAMPLE_OVERLAYS);
  await writeIfMissing(join(cwd, 'argo.config.mjs'), ARGO_CONFIG);
  await writeIfMissing(join(cwd, 'playwright.config.ts'), PLAYWRIGHT_CONFIG);

  console.log('\nArgo initialized! Next steps:');
  console.log('  1. Edit demos/example.demo.ts');
  console.log('  2. Run: npx argo record example');
  console.log('  3. Run: npx argo pipeline example');
}

export interface InitFromOptions {
  /** Path to the Playwright test file to convert. */
  from: string;
  /** Demo name override. Defaults to filename without extension. */
  demo?: string;
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Convert an existing Playwright test into an Argo demo project.
 * Generates demo script (with fixture swap + mark() calls),
 * skeleton voiceover.json (with _hint fields for LLM),
 * and skeleton overlays.json.
 */
export async function initFrom(options: InitFromOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const source = await readFile(options.from, 'utf-8');

  // Derive demo name from filename: checkout.spec.ts → checkout
  const demoName =
    options.demo ??
    basename(options.from)
      .replace(/\.(spec|test|demo)\.(ts|js|mjs)$/, '')
      .replace(/\.(ts|js|mjs)$/, '');

  const parsed = parsePlaywrightTest(source);

  if (parsed.scenes.length === 0) {
    throw new Error(
      `No scenes detected in ${options.from}. The file should contain Playwright actions like page.goto(), page.click(), etc.`,
    );
  }

  const demosDir = join(cwd, 'demos');
  await mkdir(demosDir, { recursive: true });

  // Generate demo script
  const demoScript = generateDemoScript(parsed);
  await writeIfMissing(join(demosDir, `${demoName}.demo.ts`), demoScript);

  // Generate voiceover skeleton with hints
  const voiceover = generateVoiceoverSkeleton(parsed);
  const voiceoverJson = JSON.stringify(voiceover, null, 2) + '\n';
  await writeIfMissing(join(demosDir, `${demoName}.voiceover.json`), voiceoverJson);

  // Generate overlays skeleton
  const overlays = generateOverlaysSkeleton(parsed);
  const overlaysJson = JSON.stringify(overlays, null, 2) + '\n';
  await writeIfMissing(join(demosDir, `${demoName}.overlays.json`), overlaysJson);

  // Scaffold config files if they don't exist
  await writeIfMissing(join(cwd, 'argo.config.mjs'), ARGO_CONFIG);
  await writeIfMissing(join(cwd, 'playwright.config.ts'), PLAYWRIGHT_CONFIG);

  console.log(`\nConverted ${options.from} → ${demoName} (${parsed.scenes.length} scenes)`);
  console.log('\nNext steps:');
  console.log(`  1. Fill in voiceover text: demos/${demoName}.voiceover.json`);
  console.log(`     (use _hint fields as context, then remove them)`);
  console.log(`  2. Refine overlays: demos/${demoName}.overlays.json`);
  console.log(`  3. Run: npx argo pipeline ${demoName}`);
  console.log(`\nTip: Ask your LLM to "flesh out the voiceover for ${demoName}" — it can`);
  console.log('read the _hint fields and write natural narration text for each scene.');
}
