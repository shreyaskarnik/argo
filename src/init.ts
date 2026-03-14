import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

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
import { showCaption, withCaption } from '@argo-video/cli';

test('example', async ({ page, narration }) => {
  await page.goto('/');

  narration.mark('welcome');
  await showCaption(page, 'welcome', 'Welcome to our app', 3000);

  narration.mark('action');
  await withCaption(page, 'action', 'Watch how easy it is', async () => {
    await page.click('button');
  });

  narration.mark('done');
  await showCaption(page, 'done', 'All done!', 2000);
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

const ARGO_CONFIG = `export default {
  baseURL: 'http://localhost:3000',
  demosDir: 'demos/',
  outputDir: 'videos/',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 1920, height: 1080, fps: 30, browser: 'chromium', deviceScaleFactor: 1 },
  export: { preset: 'slow', crf: 16 },
};
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  preserveOutput: 'always',
  projects: [
    {
      name: 'demos',
      testDir: 'demos',
      testMatch: '**/*.demo.ts',
      use: {
        baseURL: process.env.BASE_URL || 'http://localhost:3000',
        viewport: { width: 1920, height: 1080 },
        video: {
          mode: 'on',
          size: { width: 1920, height: 1080 },
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
  await writeIfMissing(join(cwd, 'argo.config.js'), ARGO_CONFIG);
  await writeIfMissing(join(cwd, 'playwright.config.ts'), PLAYWRIGHT_CONFIG);

  console.log('\nArgo initialized! Next steps:');
  console.log('  1. Edit demos/example.demo.ts');
  console.log('  2. Run: npx argo record example');
  console.log('  3. Run: npx argo pipeline example');
}
