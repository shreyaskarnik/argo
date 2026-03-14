```
                                     ___
        _____                       /  /
       /  _  |  _ __  __ _  ___    /  /
      /  /_| | | '__|/ _` |/ _ \  /  /
     /  ___  | | |  | (_| | (_) |/  /
    /__/   |_| |_|   \__, |\___//__/
                      __/ |
                     |___/
```

# @argo-video/cli

**Turn Playwright demo scripts into polished product demo videos with AI voiceover.**

Write a demo script with Playwright. Add a voiceover manifest. Run one command. Get an MP4 with overlays and narration.

## Showcase

[Watch the demo video](https://gist.github.com/user-attachments/assets/1344780c-75e4-40fc-ab4a-c9e546f8c2ea)

> *This demo was recorded by Argo, using Argo. Yes, really.*

## How it works

```bash
 TTS          Record        Align         Export
 ───          ──────        ─────         ──────
 Kokoro       Playwright    Place clips   ffmpeg
 generates    captures      at scene      merges
 voice        browser +     timestamps    video +
 clips        scene marks                 audio
                  │              │
                  ▼              ▼
           .voiceover.json → narration-aligned.wav → final.mp4
```

## Quick start

```bash
# Install
npm i -D @argo-video/cli

# Initialize project
npx argo init

# Edit your demo script
vim demos/example.demo.ts

# Run the full pipeline
npx argo pipeline example

# Or run steps individually
npx argo record example
npx argo tts generate demos/example.voiceover.json
npx argo export example
```

## Writing a demo

A demo is two files: a **script** and a **voiceover manifest**.

### Demo script (`demos/my-feature.demo.ts`)

```ts
import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('my-feature', async ({ page, narration }) => {
  await page.goto('/');

  narration.mark('intro');
  await showOverlay(page, 'intro', {
    type: 'lower-third',
    text: 'Welcome to our product',
    placement: 'bottom-center',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('intro'));

  narration.mark('action');
  await withOverlay(page, 'action', {
    type: 'headline-card',
    title: 'Watch this',
    placement: 'top-right',
    motion: 'slide-in',
  }, async () => {
    await page.click('#get-started');
    await page.waitForTimeout(narration.durationFor('action'));
  });

  narration.mark('done');
  await showOverlay(page, 'done', {
    type: 'callout',
    text: "That's it!",
    placement: 'top-left',
    motion: 'fade-in',
  }, narration.durationFor('done'));
});
```

### Voiceover manifest (`demos/my-feature.voiceover.json`)

```json
[
  { "scene": "intro", "text": "Welcome to our product — let me show you around." },
  { "scene": "action", "text": "Just click get started and you're off." },
  { "scene": "done", "text": "And that's all there is to it.", "voice": "af_heart" }
]
```

Each `scene` in the manifest maps to a `narration.mark()` call in the script. Argo records the timestamp of each mark, generates TTS clips, and aligns them to produce the final narrated video.

## Configuration

### `argo.config.js`

```js
export default {
  baseURL: 'http://localhost:3000',
  demosDir: 'demos/',
  outputDir: 'videos/',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 1920, height: 1080, fps: 30, browser: 'chromium', deviceScaleFactor: 1 },
  export: { preset: 'slow', crf: 16 },
};
```

> **Tip:** Use `browser: 'webkit'` for sharper video on macOS. Chromium has a [known video capture quality issue](https://github.com/microsoft/playwright/issues/31424). Set `deviceScaleFactor: 2` for retina-quality recordings (captured at 2x, downscaled with lanczos in export).

### `playwright.config.ts`

Argo scaffolds this for you via `argo init`. The key settings:

```ts
import { defineConfig } from '@playwright/test';
import config from './argo.config.js';

const scale = Math.max(1, Math.round(config.video?.deviceScaleFactor ?? 1));
const width = config.video?.width ?? 1920;
const height = config.video?.height ?? 1080;

export default defineConfig({
  preserveOutput: 'always',
  projects: [{
    name: 'demos',
    testDir: 'demos',
    testMatch: '**/*.demo.ts',
    use: {
      browserName: config.video?.browser ?? 'chromium',
      baseURL: process.env.BASE_URL || config.baseURL || 'http://localhost:3000',
      viewport: { width, height },
      deviceScaleFactor: scale,
      video: { mode: 'on', size: { width: width * scale, height: height * scale } },
    },
  }],
});
```

## CLI

```
argo init                          Scaffold demo files + config
argo record <demo>                 Record browser session
argo tts generate <manifest>       Generate TTS clips from manifest
argo export <demo>                 Merge video + audio to MP4
argo pipeline <demo>               Run all steps end-to-end
argo --config <path> <command>     Use a custom config file

Options:
  --browser <engine>               chromium | webkit | firefox (overrides config)
```

## API

Argo exports Playwright fixtures and helpers for use in demo scripts:

```ts
import { test, expect, demoType } from '@argo-video/cli';
import { showOverlay, hideOverlay, withOverlay } from '@argo-video/cli';
import { showCaption, hideCaption, withCaption } from '@argo-video/cli';
import { defineConfig, demosProject } from '@argo-video/cli';
```

| Export | Description |
|--------|-------------|
| `test` | Playwright `test` with `narration` fixture injected |
| `expect` | Re-exported from Playwright |
| `demoType(page, selector, text, delay?)` | Type text character-by-character (cinematic) |
| `showOverlay(page, scene, cue, durationMs)` | Show a templated overlay (lower-third, headline-card, callout, image-card) |
| `withOverlay(page, scene, cue, action)` | Show overlay during an async action |
| `hideOverlay(page, zone?)` | Remove overlay from a zone |
| `showCaption(page, scene, text, durationMs)` | Show a simple text caption |
| `withCaption(page, scene, text, action)` | Show caption during an async action |
| `hideCaption(page)` | Remove caption |
| `narration.mark(scene)` | Record a scene timestamp |
| `narration.durationFor(scene, opts?)` | Compute hold duration from TTS clip length |
| `defineConfig(userConfig)` | Create config with defaults |
| `demosProject(options)` | Create Playwright project entry |

## Requirements

- **Node.js** >= 18
- **Playwright** >= 1.40 (peer dependency)
- **ffmpeg** — system install required for export

```bash
# Install ffmpeg
brew install ffmpeg        # macOS
apt install ffmpeg         # Linux
choco install ffmpeg       # Windows
```

## How the pipeline works

1. **TTS** — Kokoro (via `kokoro-js`) generates WAV clips from the voiceover manifest. Clips are cached by content hash in `.argo/<demo>/clips/` so regeneration is instant if text hasn't changed.

2. **Record** — Playwright runs the demo script in a real browser. The `narration` fixture records timestamps for each `mark()` call. Video is captured at native resolution.

3. **Align** — Each TTS clip is placed at its scene's recorded timestamp. Overlapping clips are pushed forward with a 100ms gap. All clips are mixed into a single `narration-aligned.wav`.

4. **Export** — ffmpeg combines the screen recording (WebM) with the aligned narration (WAV) into an H.264 MP4.

## License

MIT
