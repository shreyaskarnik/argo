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

[Watch the demo video](https://github.com/user-attachments/assets/7693c67c-8850-4f57-a15c-47cfbfd3d180)

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
# Install the core (about 27 MB, no TTS engine yet)
npm i -D @argo-video/cli

# Add the TTS engine you want. Engines are optional peer dependencies,
# so you only pay for the one you use. Run `npx argo doctor` any time to
# see which engines are installed and the exact command for your setup.
npm i kokoro-js@1        # local, free, no API key (~410 MB of ONNX runtime)
npm i openai             # cloud, needs OPENAI_API_KEY (~20 MB)

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

  // Begin screen capture once setup (login, theme, navigation) is done.
  // The first narration.mark() below lands at t=0 in the recording.
  await narration.startRecording(page);

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
    browser: 'chromium',         // chromium with jpeg-stitch is the highest-quality path (v0.35+)
    captureMode: 'jpeg-stitch',  // CDP-direct paint-time capture; auto-downgrades on webkit/firefox
    deviceScaleFactor: 2,        // 4K supersample → lanczos downscale; auto-clamps to 1 on non-chromium
    cursorHighlight: true,       // pseudo-cursor ring that follows mouse movement in the recording
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

Set `video.cursorHighlight` to `true` for the default pseudo-cursor, or pass
`{ color, radius, pulse, clickRipple, opacity }` to customize it. Argo injects
the overlay when recording starts and restores it after top-level navigation,
so demo scripts do not need to call `cursorHighlight()` themselves.

For an **SVG mouse pointer with brief click feedback**, combine
`createHumanCursor()` with `cursorHighlight(page, { mode: 'click' })`. The pointer
travels alone along seeded curves and pauses before clicking. A circle
contracts toward the pointer tip on its first mouse event, on a click, or when
Control is released. It disappears after 700 ms and stays at the event position
if the mouse moves away. Rapid triggers restart one circle. Both helpers
survive navigation; `createHumanCursor()` adds no duplicate click feedback.

```ts
import { createHumanCursor, cursorHighlight, resetCursor } from '@argo-video/cli';

await cursorHighlight(page, { mode: 'click' }); // Or set video.cursorHighlight to this object.
const cursor = await createHumanCursor(page, { seed: 'my-demo', size: 30 });
await cursor.click(page.getByRole('button', { name: 'Continue' }));
await cursor.moveTo(page.getByRole('link', { name: 'Details' }), { durationMs: 900 });
await cursor.dispose();
await resetCursor(page);
```

`mode: 'continuous'` is the default for the existing persistent ring behavior.
Use one cursor instance across scenes. `cursor.hide()` hides the SVG until its
next move; `cursor.dispose()` removes it and its navigation listener. The ring
is independent and is removed with `resetCursor(page)`. `cursor.click(field)`
followed by `demoType(page, field, text)` makes typing follow visible cursor
travel. `start` and movement `target` options use fractions of the viewport and
target bounding box respectively; `size` uses CSS pixels.

Try the self-contained [pseudo-cursor demo](demos/pseudo-cursor.demo.ts):

[Watch the recorded demo](videos/pseudo-cursor.mp4) (47 seconds, 1280×720).

```bash
npm run build
node bin/argo.js pipeline pseudo-cursor
```

It records SVG pointer travel, brief appearance/click circles, Control-key
location feedback, three simultaneous overlays (callout, lower third, and
arrow), automatic restoration after a full page navigation,
custom styling, and `resetCursor()` cleanup. Nested `withOverlay()` calls keep
different zones visible together while the pseudo cursor clicks the page. The
demo uses a local HTML fixture with on-screen explanations, so no app server, TTS engine,
or API keys are needed. Chromium and ffmpeg must be installed. Output:
`videos/pseudo-cursor.mp4`. Settings live in
[`demos/pseudo-cursor.config.mjs`](demos/pseudo-cursor.config.mjs).

> **Tip:** Use `browser: 'webkit'` for sharper video on macOS. Chromium has a [known video capture quality issue](https://github.com/microsoft/playwright/issues/31424). Set `deviceScaleFactor: 2` for retina-quality recordings (captured at 2x, downscaled with lanczos in export).

### Mobile Demos

Record mobile-viewport demos with touch support:

```ts
// In your demo script
test.use({
  viewport: { width: 390, height: 664 },
  isMobile: true,
  hasTouch: true,
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

> **Important:** The recording size is derived from `video.width` × `video.height` and passed to `page.screencast.start()` automatically. Use `.tap()` instead of `.click()` for touch interactions.

See `demos/mobile.demo.ts` for a complete mobile demo example.

### `playwright.config.ts`

Argo scaffolds this for you via `argo init`. The key settings:

```ts
import { defineConfig } from '@playwright/test';
import config from './argo.config.mjs';

const scale = Math.max(1, Math.round(config.video?.deviceScaleFactor ?? 1));
const width = config.video?.width ?? 1920;
const height = config.video?.height ?? 1080;

// Recording is driven by narration.startRecording(page) inside the demo
// (page.screencast.start under the hood). Keep video: 'off' so Playwright's
// auto recordVideo doesn't fight the screencast.
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
      video: 'off',
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
argo import <video-file>           Import external video for post-production
argo doctor                        Check environment (ffmpeg, Playwright, config)
argo --config <path> <command>     Use a custom config file

Options:
  --browser <engine>               chromium | webkit | firefox (overrides config)
  --base-url <url>                 Override baseURL from config
  --headed                         Run browser in visible mode
  --all                            Run pipeline for all demos
  --port <number>                  Preview server port (default: auto)
```

### Overlay Blocks

Argo ships 12 curated overlay blocks for demo narratives. Reference them from `.scenes.json`:

```json
{
  "scene": "social-proof",
  "overlay": {
    "type": "block",
    "block": "x-post",
    "props": {
      "handle": "@jane",
      "name": "Jane Doe",
      "body": "this is exactly what I needed",
      "timestamp": "2m"
    },
    "placement": "top-right"
  }
}
```

**Static blocks** (use CSS-preset motion):

| Block | Purpose |
|-------|---------|
| `x-post` | Social post card for social proof |
| `macos-notification` | macOS-style notification banner |
| `yt-lower-third` | YouTube-style lower third for speaker intros |
| `data-chart` | Compact bar/line chart for metrics |
| `spotify-card` | Now-playing card for decorative inserts |

**Animated blocks** (ship with a GSAP `defaultMotion` — cue-level `motion` still overrides):

| Block | Motion |
|-------|--------|
| `instagram-follow` | Back-easing scale-in entrance + pulsing Follow button |
| `tiktok-follow` | Side-slide entrance + rotating gradient avatar ring |
| `reddit-post` | Simple slide-up entrance + fade-out |
| `logo-outro` | Scale-in end-card with back.out ease |
| `flowchart` | Staggered reveal across nodes and arrows |
| `app-showcase` | Back-eased hero entrance + slow floating icon loop |
| `ui-3d-reveal` | Perspective tilt-to-flat reveal with a subtle wobble loop |

### GSAP motion (advanced)

Every overlay supports two kinds of `motion`: a named CSS preset (`none`, `fade-in`, `slide-in`) or a declarative GSAP motion object with `in`, `out`, and `loop` phases. `showOverlay(page, scene, durationMs)` auto-times the exit so the visible window matches `durationMs`:

```json
{
  "scene": "hero",
  "overlay": {
    "type": "headline-card",
    "title": "Argo",
    "kicker": "Demo videos, locally",
    "motion": {
      "type": "gsap",
      "in":  { "from": { "y": 40, "opacity": 0 }, "duration": 0.5, "ease": "back.out" },
      "out": { "to":   { "opacity": 0, "y": -20 }, "duration": 0.3, "ease": "power2.in" }
    }
  }
}
```

`GsapTween` fields: `from` / `to` / `fromTo`, `duration`, `delay`, `ease`, `stagger`, `target` (CSS selector inside the overlay root), `repeat`, `yoyo`. Allowed eases and animation vars are whitelisted; `argo validate` rejects unknown values. Raw GSAP code via `motion.raw` is off by default — enable with `overlays.allowRawGsap: true` if you need the escape hatch. GSAP ships with Argo and is injected into the recording page on demand.

Blocks live under `src/blocks/<name>/` — see [demos/blocks-showcase](demos/blocks-showcase.demo.ts) for a complete example.

## API

Argo exports Playwright fixtures and helpers for use in demo scripts:

```ts
import { test, expect, demoType } from '@argo-video/cli';
import { showOverlay, hideOverlay, withOverlay } from '@argo-video/cli';
import { showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';
import { cursorHighlight, resetCursor } from '@argo-video/cli';
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
| `cursorHighlight(page, opts?)` | Enable a continuous ring or `mode: 'click'` for brief appearance/click/Control locator circles. For automatic setup, use `video.cursorHighlight`. Options: `mode`, `color`, `radius`, `pulse`, `clickRipple`, `opacity` |
| `resetCursor(page)` | Remove cursor highlight |
| `showCaption(page, scene, text, durationMs)` | Show a simple text caption |
| `withCaption(page, scene, text, action)` | Show caption during an async action |
| `hideCaption(page)` | Remove caption |
| `narration.mark(scene)` | Record a scene timestamp |
| `narration.durationFor(scene, opts?)` | Compute hold duration from TTS clip length (remaining time from now) |
| `narration.sceneDuration(scene, opts?)` | Full scene duration — stable, non-decreasing (for overlay display) |
| `defineConfig(userConfig)` | Create config with defaults |
| `demosProject(options)` | Create Playwright project entry |

## Requirements

- **Node.js** >= 20 (Playwright requires it)
- **Playwright** >= 1.59 (peer dependency)
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

   Every engine is an **optional peer dependency**: npm does not install it
   for you, so the base package stays small. Install the one you use.

   | Engine | Type | Install | Size | API Key |
   |--------|------|---------|------|---------|
   | `engines.kokoro()` | local | `npm i kokoro-js@1` | ~410 MB | none |
   | `engines.mlxAudio()` | local | `pip install mlx-audio` | n/a (Python) | none |
   | `engines.openai()` | cloud | `npm i openai` | ~20 MB | `OPENAI_API_KEY` |
   | `engines.elevenlabs()` | cloud | `npm i @elevenlabs/elevenlabs-js` | ~88 MB | `ELEVENLABS_API_KEY` |
   | `engines.gemini()` | cloud | `npm i @google/genai` | ~36 MB | `GEMINI_API_KEY` |
   | `engines.sarvam()` | cloud | `npm i sarvamai` | ~7 MB | `SARVAM_API_KEY` |
   | `engines.transformers()` | local | `npm i @huggingface/transformers@3` | ~380 MB | none |

   Sizes are `node_modules` on disk for that package alone in an empty
   project. They do not simply add up, because engines share transitive
   dependencies with Argo. Measured end to end, a project install comes to
   about 27 MB with no engine, 47 MB with OpenAI, and 435 MB with Kokoro.

   The commands above are for a project-local install. A **global** install
   (`npm i -g @argo-video/cli`) needs `-g` on the engine too, and Kokoro
   needs both packages in **one** command, because separate global installs
   do not deduplicate and you end up with two copies of the ONNX runtime:

   ```bash
   npm i -g kokoro-js@1 @huggingface/transformers@3   # one command, ~410 MB
   ```

   With **npx**, compose the engine into the same invocation:

   ```bash
   npx -p @argo-video/cli -p openai -- argo pipeline example
   ```

   `npx argo doctor` prints the right command for whichever of the three
   you are using.

   Word-level transcription (`tts.transcribe`) needs
   `@huggingface/transformers`. Installing `kokoro-js` already brings it in
   on a project install, so there is usually nothing extra to do.

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

### Shader Transitions

Pre-rendered WebGL shader transitions between scenes, cached by content hash.

```js
export: {
  transition: {
    type: 'shader',
    shader: 'crosswarp',   // crosswarp | swirl | ripple | luma-mask | light-leak
    durationMs: 800,
  },
}
```

Shaders are adapted from [gl-transitions.com](https://gl-transitions.com) (MIT). First export launches headless Chromium to pre-render shader frames; cached at `.argo/<demo>/shaders/<hash>/` so subsequent exports skip the browser launch.

See `demos/shaders-showcase.demo.ts` for a complete example.

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

### Export Quality

Argo's H.264 output is tagged BT.709 color space, uses x264 adaptive quantization (`aq-mode=3`) to reduce banding on gradients, and converts Chrome's full-range RGB to H.264 TV range. Tags ensure colors match across Safari, TVs, and mobile players.

**GPU encoding.** Argo auto-detects GPU encoders and uses them when available:

- macOS: `h264_videotoolbox`
- NVIDIA: `h264_nvenc`
- Linux/AMD: `h264_vaapi`
- Intel: `h264_qsv`

Typical speedup: 3-10x on macOS, 5-15x on NVIDIA. Falls back to libx264 when no GPU encoder is available.

Disable GPU encoding with `ARGO_USE_GPU=0` (e.g., for deterministic CI builds):

```bash
ARGO_USE_GPU=0 argo pipeline my-demo
```

### Studio Polish

```js
export: {
  sharpen: true,                        // contrast-adaptive sharpening (CAS) for crisp text
  frame: {                              // "Screen Studio" look
    padding: 48,
    borderRadius: 16,
    shadow: 0.5,
    background: { type: 'auto' },       // auto-derives gradient from video colors
    // background: { type: 'gradient', value: 'linear-gradient(135deg, #1a1a2e, #16213e)' },
    // background: { type: 'solid', value: '#000000' },
    // background: { type: 'image', value: 'assets/bg.jpg' },
  },
  motionBlur: { intensity: 0.5 },       // blur during camera move transitions
}
```

- **Frame** — Wraps the recording with padding, rounded corners, drop shadow, and a background. Background `auto` probes the video for dominant edge colors and generates a matching gradient.
- **Sharpening** — ffmpeg CAS filter restores text crispness lost during screen recording encode.
- **Motion blur** — Time-gated `tblend` that only activates during zoom-in/zoom-out camera move windows. Static frames stay sharp.

### Per-Scene Playback Speed

Control video playback rate per scene in the manifest (separate from TTS speech `speed`):

```json
{ "scene": "hero", "text": "...", "playbackSpeed": 0.5 }
```

Useful for slow-mo hero moments or fast-forwarding setup steps.

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

Opens a dashboard listing every discovered demo with build status, video size, resolution, and quick-action links. Run `argo preview <demo>` for the single-demo editor — scene list, overlay editor, frame & background panel, and a **waveform strip** painted from the aligned narration WAV (click-to-seek, mirrored playhead).

### Video Import

Bring any existing video into Argo for post-production — add voiceover, overlays, and scene boundaries:

```bash
npx argo import recording.mp4              # import with auto-detected name
npx argo import recording.mp4 --demo myapp # custom demo name
npx argo preview myapp                     # open in editor
```

Import scaffolds a `.scenes.json` manifest and `.timing.json` from the video. In the preview editor you can scrub the timeline, add scene boundaries at any point, write voiceover text, drag-to-snap overlays into position, and export — all without re-recording. Overlays are composited as PNGs with adaptive theme detection (light/dark auto-detected from video frames).

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
