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

[![npm version](https://img.shields.io/npm/v/@argo-video/cli)](https://www.npmjs.com/package/@argo-video/cli)

**Turn Playwright demo scripts into polished product demo videos with AI voiceover.**

Write a demo script with Playwright. Add a scenes manifest. Run one command. Get an MP4 with overlays and narration.

## Showcase

[Watch the demo video](https://github.com/user-attachments/assets/2c0d25a2-3210-42fd-b511-dce2ec633712)

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
           .scenes.json → narration-aligned.wav → final.mp4
```

## Quick start

```bash
# Install
npm i -D @argo-video/cli

# Initialize project
npx argo init

# Edit your demo script (or convert an existing Playwright test)
vim demos/example.demo.ts
npx argo init --from tests/checkout.spec.ts  # auto-convert

# Run the full pipeline
npx argo pipeline example

# Or run steps individually
npx argo record example
npx argo tts generate demos/example.scenes.json
npx argo export example
```

## Writing a demo

A demo is two files: a **script** and a **scenes manifest**.

### Demo script (`demos/my-feature.demo.ts`)

```ts
import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('my-feature', async ({ page, narration }) => {
  await page.goto('/');

  narration.mark('intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  narration.mark('action');
  await withOverlay(page, 'action', async () => {
    await page.click('#get-started');
    await page.waitForTimeout(narration.durationFor('action'));
  });

  narration.mark('done');
  await showOverlay(page, 'done', narration.durationFor('done'));
});
```

### Scenes manifest (`demos/my-feature.scenes.json`)

```json
[
  {
    "scene": "intro",
    "text": "Welcome to our product — let me show you around.",
    "overlay": { "type": "lower-third", "text": "Welcome to our product", "placement": "bottom-center", "motion": "fade-in", "autoBackground": true }
  },
  {
    "scene": "action",
    "text": "Just click get started and you're off.",
    "overlay": { "type": "headline-card", "title": "Watch this", "placement": "top-right", "motion": "slide-in" }
  },
  {
    "scene": "done",
    "text": "And that's all there is to it.",
    "voice": "af_heart",
    "overlay": { "type": "callout", "text": "That's it!", "placement": "top-left", "motion": "fade-in" }
  }
]
```

Each `scene` in the manifest maps to a `narration.mark()` call in the script. The `text` field is spoken narration; the optional `overlay` sub-object defines what appears on screen. Argo records the timestamp of each mark, generates TTS clips, and aligns them to produce the final narrated video.

## Configuration

### `argo.config.mjs`

```js
import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: {
    width: 1920, height: 1080, fps: 30,
    browser: 'webkit',           // webkit > firefox > chromium on macOS
    // deviceScaleFactor: 2,     // enable after webkit 2x fix
  },
  export: {
    preset: 'slow', crf: 16,
    transition: { type: 'fade-through-black', durationMs: 2000 },   // scene transitions (2s+ recommended)
    speedRamp: { gapSpeed: 2.0 },                                   // speed up gaps between scenes
    formats: ['gif', '9:16'],                                       // additional export formats
  },
  overlays: {
    autoBackground: true,
    // defaultPlacement: 'top-right',
  },
});
```

> **Tip:** Use `browser: 'webkit'` for sharper video on macOS. Chromium has a [known video capture quality issue](https://github.com/microsoft/playwright/issues/31424). Set `deviceScaleFactor: 2` for retina-quality recordings (captured at 2x, downscaled with lanczos in export).

### Mobile Demos

Record mobile-viewport demos with touch support:

```ts
// In your demo script
test.use({
  viewport: { width: 390, height: 664 },
  isMobile: true,
  hasTouch: true,
  video: { mode: 'on' as const, size: { width: 390, height: 664 } },
});
```

Or set mobile options globally in config:

```js
video: {
  width: 390,
  height: 664,
  browser: 'webkit',
  isMobile: true,
  hasTouch: true,
},
```

> **Important:** Set `video.size` to match the viewport in `test.use()`, otherwise the capture canvas defaults to 1920×1080 and the mobile viewport renders with gray padding. Use `.tap()` instead of `.click()` for touch interactions.

See `demos/mobile.demo.ts` for a complete mobile demo example.

### `playwright.config.ts`

Argo scaffolds this for you via `argo init`. The key settings:

```ts
import { defineConfig } from '@playwright/test';
import config from './argo.config.mjs';

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
argo init --from <test>            Convert Playwright test to Argo demo
argo record <demo>                 Record browser session
argo tts generate <manifest>       Generate TTS clips from manifest
argo export <demo>                 Merge video + audio to MP4
argo pipeline <demo>               Run all steps end-to-end
argo pipeline --all                Run pipeline for every demo in demosDir
argo validate <demo>               Check scene name consistency (no TTS/recording)
argo preview <demo>                Browser-based editor for voiceover, overlays, timing
argo preview                       Multi-demo dashboard (lists all demos with status)
argo clip <demo> <scene>            Extract a scene clip from exported video
argo clip <demo> <scene> --format gif  Extract as palette-optimized GIF
argo doctor                        Check environment (ffmpeg, Playwright, config)
argo --config <path> <command>     Use a custom config file

Options:
  --browser <engine>               chromium | webkit | firefox (overrides config)
  --base-url <url>                 Override baseURL from config
  --headed                         Run browser in visible mode
  --all                            Run pipeline for all demos
  --port <number>                  Preview server port (default: auto)
```

## API

Argo exports Playwright fixtures and helpers for use in demo scripts:

```ts
import { test, expect, demoType } from '@argo-video/cli';
import { showOverlay, hideOverlay, withOverlay } from '@argo-video/cli';
import { showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';
import { showCaption, hideCaption, withCaption } from '@argo-video/cli';
import { defineConfig, demosProject, engines } from '@argo-video/cli';
```

| Export | Description |
|--------|-------------|
| `test` | Playwright `test` with `narration` fixture injected |
| `expect` | Re-exported from Playwright |
| `demoType(page, selectorOrLocator, text, delay?)` | Type character-by-character — accepts CSS selector or Playwright Locator |
| `showOverlay(page, scene, durationMs)` | Show overlay from manifest for a fixed duration |
| `showOverlay(page, scene, cue, durationMs)` | Show overlay with inline cue (backward compat) |
| `withOverlay(page, scene, action)` | Show overlay from manifest during an async action |
| `withOverlay(page, scene, cue, action)` | Show overlay with inline cue during action (backward compat) |
| `hideOverlay(page, zone?)` | Remove overlay from a zone |
| `showConfetti(page, opts?)` | Non-blocking confetti animation (`spread: 'burst' \| 'rain'`, `emoji: '🎃'` or `emoji: ['🎄', '⭐']` for emoji mode, `wait: true` to block) |
| `spotlight(page, selector, opts?)` | Dark overlay with hole around target element |
| `focusRing(page, selector, opts?)` | Pulsing glow border on target |
| `dimAround(page, selector, opts?)` | Fade sibling elements to highlight target |
| `zoomTo(page, selector, opts?)` | Scale viewport centered on target. Pass `{ narration }` for overlay-safe ffmpeg post-export zoom (recommended). |
| `resetCamera(page)` | Clear all active camera effects |
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

1. **TTS** — Generates WAV clips from the scenes manifest. Kokoro is the default (local, free), but you can swap in OpenAI, ElevenLabs, Gemini, Sarvam, or mlx-audio via `engines.*` factories. Clips are cached by content hash in `.argo/<demo>/clips/`.

   ```js
   import { defineConfig, engines } from '@argo-video/cli';
   export default defineConfig({
     tts: { engine: engines.openai({ model: 'tts-1-hd' }) },
   });
   ```

   | Engine | Type | Install | API Key |
   |--------|------|---------|---------|
   | `engines.kokoro()` | local | built-in | none |
   | `engines.mlxAudio()` | local | `pip install mlx-audio` | none |
   | `engines.openai()` | cloud | `npm i openai` | `OPENAI_API_KEY` |
   | `engines.elevenlabs()` | cloud | `npm i @elevenlabs/elevenlabs-js` | `ELEVENLABS_API_KEY` |
   | `engines.gemini()` | cloud | `npm i @google/genai` | `GEMINI_API_KEY` |
   | `engines.sarvam()` | cloud | `npm i sarvamai` | `SARVAM_API_KEY` |
   | `engines.transformers()` | local | built-in | none |

   **Transformers.js** — Use any HuggingFace `text-to-speech` model locally. Supertonic, or any future ONNX TTS model:

   ```js
   tts: {
     engine: engines.transformers({
       model: 'onnx-community/Supertonic-TTS-ONNX',
       speakerEmbeddings: 'https://huggingface.co/.../voices/F1.bin',
       numInferenceSteps: 10,
     }),
   }
   ```

   **Voice cloning** — Clone your own voice locally with mlx-audio. Record a 15-second clip, and every demo sounds like you — privately, no data leaves your machine:

   ```bash
   # Record a reference clip (macOS)
   bash $(npm root)/@argo-video/cli/scripts/record-voice-ref.sh assets/ref-voice.wav

   # Preview cloned voice against your manifest
   bash $(npm root)/@argo-video/cli/scripts/voice-clone-preview.sh \
     --ref-audio assets/ref-voice.wav \
     --ref-text "Transcript of what I said." \
     --voiceover demos/showcase.scenes.json --play
   ```

   ```js
   tts: {
     engine: engines.mlxAudio({
       model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
       refAudio: './assets/ref-voice.wav',
       refText: 'Transcript of what I said in the clip.',
     }),
   }
   ```

2. **Record** — Playwright runs the demo script in a real browser. The `narration` fixture records timestamps for each `mark()` call. Video is captured at native resolution.

3. **Align** — Each TTS clip is placed at its scene's recorded timestamp. Overlapping clips are pushed forward with a 100ms gap. All clips are mixed into a single `narration-aligned.wav`.

4. **Export** — ffmpeg combines the screen recording (WebM) with the aligned narration (WAV) into an H.264 MP4 with chapter markers. Subtitle files (`.srt` + `.vtt`) and a scene report are generated alongside the video. A progress bar shows encoding percentage during export.

### Scene Transitions

Add smooth transitions between scenes:

```js
export: {
  transition: { type: 'fade-through-black', durationMs: 2000 },
}
```

> **Tip:** Use `durationMs: 2000` or higher for transitions that are clearly visible during narration. Short durations (500ms) look like glitches rather than intentional transitions.

Transition types: `fade-through-black`, `dissolve` (quicker dip-to-black, not a true crossfade), `wipe-left`, `wipe-right`.

> **Tip:** Content changes (page navigation, slide switches) should happen **before** `narration.mark()` so the transition fades between the old and new content. If you change content after `mark()`, the transition just pulses the same visual.

### Speed Ramp

Compress gaps between scenes (navigation, page loads) to keep demos tight:

```js
export: {
  speedRamp: { gapSpeed: 2.0, minGapMs: 500 },
}
```

`gapSpeed: 2.0` means inter-scene gaps play at 2× speed. Only gaps longer than `minGapMs` (default 500ms) are affected. Both video and audio are sped up together.

### Multi-Format Export

Export additional formats alongside the main 16:9 MP4:

```js
export: {
  formats: ['1:1', '9:16', 'gif'],
}
```

- `1:1` — Square with blur-fill background for Instagram/LinkedIn
- `9:16` — Vertical with blur-fill background for TikTok/Reels
- `gif` — Animated GIF with palette optimization for docs/READMEs

### Audio Processing

```js
export: {
  audio: {
    loudnorm: true,                   // EBU R128 normalization (-16 LUFS)
    music: 'assets/bg-music.mp3',     // background music track
    musicVolume: 0.15,                // music volume (0.0-1.0, default 0.15)
  }
}
```

- **Loudnorm** — EBU R128 loudness normalization. Makes voiceover volume consistent across TTS engines and scenes.
- **Background music** — loops to fill the video, mixed at a constant low volume under narration, 2-second fade-out at the end. Works with silent demos too (music becomes the sole audio track).

### Freeze-Frame Holds

Pause the video at a key moment — great for CTAs, section transitions, or letting text breathe:

```json
{
  "scene": "cta",
  "text": "Sign up now.",
  "post": [{ "type": "freeze", "atMs": 1800, "durationMs": 1200 }]
}
```

`atMs` is relative to the scene start. The freeze extends the total video duration — chapters, subtitles, and the scene report auto-adjust.

### Watermark

Overlay a logo or brand bug on the exported video:

```js
export: {
  watermark: {
    src: 'assets/logo.png',
    position: 'bottom-right',   // top-left | top-right | bottom-left | bottom-right
    opacity: 0.7,               // 0.0 - 1.0 (default 0.7)
    margin: 20,                 // pixels from edge (default 20)
  }
}
```

### Post-Export Camera Moves

Zoom into specific elements with frame-exact ffmpeg `zoompan` — overlays stay unaffected:

```ts
import { zoomTo } from '@argo-video/cli';

narration.mark('details');
zoomTo(page, '#revenue-chart', {
  narration,
  scale: 1.35,
  duration: 5000,
  fadeIn: 1000,
  holdMs: 3000,
});
await showOverlay(page, 'details', narration.durationFor('details'));
```

When `narration` is passed, `zoomTo` records the target's bounding box as a camera move mark instead of manipulating the DOM. During export, the pipeline applies animated `zoompan` filters via ffmpeg. This is overlay-safe (overlays are already burned into the video before the zoom is applied) and frame-exact.

Without `narration`, `zoomTo` falls back to browser-side CSS transforms (for VS Code preview / standalone Playwright runs).

### Viewport-Native Variants

Re-record at different viewports for pixel-perfect multi-format output. CSS handles layout — much better than blur-fill for responsive content:

```js
export: {
  variants: [
    { name: 'vertical', video: { width: 1080, height: 1920 } },
    { name: 'square',   video: { width: 1080, height: 1080 } },
  ]
}
```

TTS runs once, then the pipeline records and exports each variant separately. Output: `videos/<demo>-vertical.mp4`, `videos/<demo>-square.mp4`.

### Batch Pipeline

Build all demos in one command:

```bash
npx argo pipeline --all
```

Discovers all `.scenes.json` files in `demosDir` and runs the full pipeline for each.

### Dashboard

View all demos at a glance:

```bash
npx argo preview
```

Opens a dashboard listing every discovered demo with build status, video size, resolution, and quick-action links. Run `argo preview <demo>` for the single-demo editor.

## Example

A self-contained example is in [`example/`](example/) — it records a demo of Argo's own showcase page:

```bash
cd example && npm install && npx playwright install webkit
npm run serve      # in one terminal
npm run demo       # in another
```

## LLM Skill

Argo ships as a **Claude Code skill** so LLMs can create demo videos autonomously. Install it as a plugin:

```bash
# In Claude Code
/plugin marketplace add shreyaskarnik/argo
```

The skill teaches Claude how to write demo scripts, scenes manifests, overlay cues, and run the pipeline — no manual guidance needed.

## License

MIT
