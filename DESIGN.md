# Argo — Playwright Demo Recording with Voiceover

**Date:** 2026-03-12
**Status:** Draft

## Overview

Argo is a standalone, open-source tool that turns Playwright scripts into polished product demo videos with AI-generated voiceover. Developers author demo scripts using Playwright fixtures; anyone can regenerate the final video with a single CLI command.

The pipeline: **TTS** (Kokoro generates voiceover clips via Transformers.js, cached) → **record** (Playwright captures video + scene timestamps) → **align** (clips placed at recorded timestamps) → **export** (ffmpeg merges video + audio into MP4).

## Target Users

- **Developers** author demo scripts using Playwright's familiar test API
- **Non-developers** (marketing, DevRel) regenerate videos via CLI without touching code

## Architecture

### Library + CLI

Argo ships as a single package with two interfaces:

**Library** — Playwright fixtures and helpers for authoring demos:
- `test`, `expect` — re-exported Playwright fixtures with `narration` auto-injected
- `NarrationTimeline` — low-level control for manual usage
- `showCaption`, `hideCaption`, `withCaption` — DOM caption helpers
- `defineConfig` — creates a full Argo config with sensible defaults
- `demosProject` — creates a Playwright project entry for integration into existing configs

**CLI** — pipeline commands anyone can run:
- `argo record <demo>` — run Playwright for a specific demo
- `argo tts generate <manifest>` — generate TTS clips from `.voiceover.json`
- `argo tts align <demo>` — align clips to recording timestamps
- `argo export <demo>` — merge video + audio via ffmpeg
- `argo pipeline <demo>` — all steps end-to-end
- `argo init` — scaffold demo files + config into a project

### Project Layout

```
argo/
├── src/
│   ├── index.ts          # Library exports
│   ├── cli.ts            # CLI entry point
│   ├── fixtures.ts       # Playwright test fixture (injects narration)
│   ├── narration.ts      # NarrationTimeline class
│   ├── captions.ts       # DOM caption overlay helpers
│   ├── tts/
│   │   ├── engine.ts     # TTSEngine interface
│   │   ├── kokoro.ts     # Default Kokoro via @huggingface/transformers
│   │   └── align.ts      # Timestamp alignment logic
│   ├── export.ts         # ffmpeg video+audio merge
│   ├── pipeline.ts       # Orchestrates record→tts→align→export
│   └── config.ts         # defineConfig helper + defaults
├── bin/
│   └── argo.js           # CLI bin entry
├── package.json
└── tsconfig.json
```

### Dependencies

- `playwright` — recording engine (peer dependency)
- `@huggingface/transformers@next` — Kokoro TTS via ONNX in Node.js
- `ffmpeg` — system dependency for video export (not bundled)

No Python required. The entire pipeline runs in Node.js.

**ffmpeg detection:** All CLI commands that need ffmpeg (`export`, `pipeline`) check for it on startup and exit with a clear error message + install instructions if missing.

## Authoring API

A demo consists of two files:

### Demo Script (`demos/onboarding.demo.ts`)

```ts
import { test, demoType } from 'argo';

test('onboarding', async ({ page, narration }) => {
  // narration.start() is called automatically by the fixture before the test runs
  await page.goto('/');

  // Show caption + record scene timestamp
  await narration.showCaption(page, 'welcome', 'Welcome to our app', 3000);

  // Caption around an action
  await narration.withCaption(page, 'signup', 'Sign up in seconds', async () => {
    await page.fill('[name=email]', 'demo@example.com');
    await demoType(page, '[name=password]', 'supersecure');
  });

  // Timestamp-only scene (no visible caption, used for voiceover alignment)
  narration.mark('dashboard-loaded');
});
```

**Constraints:** Each demo file must contain exactly one `test()` block (one video per demo). Use separate demo files for separate videos.

**Key API:**
- `narration.showCaption(page, scene, text, durationMs)` — show overlay + record timestamp
- `narration.withCaption(page, scene, text, action)` — wrap action with caption
- `narration.mark(scene)` — record timestamp without visual
- `demoType(page, selector, text)` — standalone helper, slow-types for demo effect (60ms/char)
- `narration.start()` — sets timestamp zero; called automatically by fixture before each test
- `narration.flush()` — writes `.timing.json`; called automatically by fixture after each test

### Voiceover Manifest (`demos/onboarding.voiceover.json`)

```json
[
  {
    "scene": "welcome",
    "text": "Welcome to Acme — get started in under a minute."
  },
  {
    "scene": "signup",
    "text": "Just enter your email and choose a password.",
    "speed": 0.9
  },
  {
    "scene": "dashboard-loaded",
    "text": "And you're in.",
    "voice": "af_heart"
  }
]
```

Scene names link the manifest to the demo script. `voice` and `speed` are optional (defaults from config).

### Config (`argo.config.ts`, optional)

The CLI looks for `argo.config.ts` (or `.js`, `.mjs`) in the current working directory. Override with `--config <path>` on any CLI command.

```ts
import { defineConfig } from 'argo';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos/',
  outputDir: 'videos/',
  tts: {
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
    // engine: myCustomTTSEngine
  },
  video: {
    width: 2560,
    height: 1440,
    fps: 30,
  },
  export: {
    preset: 'slow',
    crf: 16,
  },
});
```

## TTS System

### Default Engine: Kokoro via Transformers.js

- Uses `@huggingface/transformers@next` with ONNX Kokoro model
- Runs in Node.js — no Python, no GPU
- Model downloaded on first run (~80MB ONNX), cached locally
- Generates one WAV clip per scene

### Alignment

1. Recording produces `.timing.json` (scene name → millisecond timestamp)
2. Aligner reads `.timing.json` + clip durations
3. Places each clip at its scene's recorded timestamp
4. Prevents overlap — clips pushed forward with 100ms minimum gap
5. Outputs single `narration-aligned.wav` matching video duration

### Plugin Interface

```ts
interface TTSEngine {
  generate(text: string, options: {
    voice?: string;
    speed?: number;
    lang?: string;
  }): Promise<Buffer>;
  // Must return a complete WAV file (with headers).
  // Required format: mono, 24kHz, 32-bit float.
  // Argo will resample if needed, but matching this format avoids overhead.
}
```

Custom engines (ElevenLabs, OpenAI TTS, Piper, etc.) implement this single method. Argo validates the returned WAV headers and resamples to 24kHz mono if the format doesn't match.

### Clip Caching

Clips stored in `.argo/<demoName>/clips/`. Each clip is keyed by a hash of its manifest entry (`scene` + `text` + `voice` + `speed`). When a clip's entry hasn't changed, the cached WAV is reused. When an entry changes (different text, voice, or speed), only that clip is regenerated. This is per-entry, not per-file — reordering entries or changing one scene doesn't invalidate others.

## Recording

- `argo record` runs Playwright with the demos project config
- Uses Playwright's default VP8 encoder (no patching)
- Higher quality achieved during export via ffmpeg re-encoding
- Output: `video.webm` + `.timing.json` in `.argo/<demoName>/`

## Export

- ffmpeg merges video + aligned audio
- Re-encodes to `libx264` (compensates for VP8's lower quality)
- Default: preset slow, crf 16, AAC audio @ 192k
- Configurable via `argo.config.ts` or CLI flags (`--crf`, `--preset`, `--fps`, `--width`, `--height`)
- Uses `-shortest` so audio trims to video length
- Output: `<outputDir>/<demoName>.mp4`

## Pipeline

`argo pipeline <demo>` chains all steps:

```
1. Generate TTS clips (skip if cached & manifest unchanged)
2. Record demo via Playwright → .webm + .timing.json
3. Align clips to timestamps → narration-aligned.wav
4. Export → final .mp4
```

Each step is independently runnable.

## `argo init`

Scaffolds into an existing project:
- Creates `demos/` directory
- Generates sample `example.demo.ts` and `example.voiceover.json`
- Creates starter `argo.config.ts`
- Adds `demos` project to `playwright.config.ts` (or creates one) using `defineConfig`
- Prints next steps

## Playwright Integration

Two modes:

**Standalone** — Argo provides its own Playwright config via `defineConfig`. Users just install and point at their app URL. `argo init` sets this up.

**Integrated** — Power users add a `demos` project to their existing `playwright.config.ts` using the exported config helper:

```ts
import { demosProject } from 'argo';

export default defineConfig({
  projects: [
    // ... existing projects
    demosProject({ baseURL: 'http://localhost:3000' }),
  ],
});
```

## Out of Scope (v1)

- Post-render subtitle burn-in via ffmpeg (future enhancement)
- npm registry publishing
- Non-Playwright backends (Puppeteer, Cypress)
- Video editing (cuts, transitions, zooms)
- Background music / audio mixing
- GUI / visual editor
