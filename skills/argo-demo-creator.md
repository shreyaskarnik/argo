---
name: argo-demo-creator
description: Create polished product demo videos using Argo. Handles the full workflow from installation through finished video with AI voiceover and overlays.
---

## Overview

Argo is a CLI tool that turns Playwright demo scripts into polished product demo videos with AI voiceover and animated overlays. You write a Playwright script that records your app, mark scene boundaries with `narration.mark()`, provide voiceover text in a JSON manifest, and Argo handles TTS generation, timing alignment, overlay injection, and video export via ffmpeg.

Two operating modes:

- **Autonomous mode**: The agent drives the full pipeline — installs Argo, initializes the project, explores the target app, writes the demo script and manifests, and runs the pipeline to produce a finished video.
- **Assistive mode**: The agent helps a user who already has Argo scripts, config, or a partial setup — answering questions, fixing errors, editing manifests, or re-running pipeline steps.

---

## Prerequisites

Before writing or running any demo, verify the following:

1. **`@argo-video/cli` is installed** — check `devDependencies` in `package.json`. If missing:
   ```bash
   npm i -D @argo-video/cli
   ```

2. **`argo.config.js` exists in the project root** — if missing, scaffold it:
   ```bash
   npx argo init
   ```

3. **Node.js** — required to run Argo and Playwright.

4. **Playwright** — required for browser recording. Installed as a dependency of `@argo-video/cli`.

5. **ffmpeg** — required for video export and audio alignment.
   - macOS: `brew install ffmpeg`
   - Linux: `apt install ffmpeg`

---

## Quick Start (Autonomous Workflow)

Follow these steps in order when creating a demo from scratch:

1. **Check installation** — look for `@argo-video/cli` in `package.json` devDependencies. Install with `npm i -D @argo-video/cli` if absent.

2. **Check config** — look for `argo.config.js` in the project root. Run `npx argo init` if absent.

3. **Ask for the app's base URL** — Argo needs a running app to record. Ask the user: "What is the URL of the running app?" (e.g., `http://localhost:3000`). Set this as `baseURL` in `argo.config.js`.

4. **Explore the app** — navigate to the `baseURL` and explore routes and features so you can write a meaningful demo script.

5. **Write the demo script** — create `demos/<name>.demo.ts` with Playwright actions and `narration.mark()` calls to define scene boundaries.

6. **Write the voiceover manifest** — create `demos/<name>.voiceover.json` with narration text for each scene. Scene names must exactly match `narration.mark()` arguments.

7. **Optionally write the overlay manifest** — create `demos/<name>.overlays.json` with overlay cues keyed to scenes.

8. **Run the pipeline**:
   ```bash
   npx argo pipeline <name>
   ```

9. **Report the output** — the finished video will be in the `outputDir` (default: `videos/`). Report the file path to the user.

---

## Script Authoring

Demo scripts live in the `demos/` directory and use the `.demo.ts` extension.

**Critical**: always import `test` from `@argo-video/cli`, not from `@playwright/test`. The Argo test fixture provides the `narration` object alongside `page`. Using the wrong import means `narration` will be undefined and the pipeline will have no timing data.

The `test` fixture provides:
- `page` — a Playwright `Page` instance
- `narration` — a `NarrationTimeline` instance with a `mark(sceneName: string)` method

Use `narration.mark('scene-name')` to define scene boundaries. These timestamps are written to a timing file that the pipeline uses to align voiceover clips and overlays with the correct moments in the video.

Use `page.waitForTimeout(ms)` to add deliberate pauses for pacing — giving the viewer time to absorb what is happening on screen.

Example:

```typescript
import { test } from '@argo-video/cli';
import { showOverlay } from '@argo-video/cli';

test('my-demo', async ({ page, narration }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);

  narration.mark('intro');
  await showOverlay(page, 'intro', {
    type: 'lower-third',
    text: 'Welcome to our app',
    motion: 'fade-in',
  }, 3000);

  narration.mark('feature');
  await page.click('#start-button');
  await page.waitForTimeout(2000);
});
```

---

## Overlay API

Three functions are available for injecting overlays directly from the demo script.

### `showOverlay(page, scene, cue, durationMs)`

Show an overlay for a fixed duration, then auto-remove it.

- `page` — Playwright Page
- `scene` — string scene name (used for logging/alignment)
- `cue` — overlay template object (see template types below)
- `durationMs` — how long to display the overlay in milliseconds

### `withOverlay(page, scene, cue, action)`

Show an overlay for the duration of an async action, then hide it automatically (even if the action throws).

- `page` — Playwright Page
- `scene` — string scene name
- `cue` — overlay template object
- `action` — async function to run while overlay is visible

### `hideOverlay(page, zone?)`

Manually hide an overlay in a specific zone, or all zones if `zone` is omitted.

- `page` — Playwright Page
- `zone` — optional zone string (see Zones below)

---

### Overlay Template Types

Every cue object must include a `type` field. All other fields are optional unless noted.

**`lower-third`** — text banner, typically at the bottom of the screen.
```typescript
{
  type: 'lower-third',
  text: string,           // required
  placement?: Zone,       // default: 'bottom-center'
  motion?: MotionPreset,  // default: 'none'
}
```

**`headline-card`** — large card with a title and optional supporting text.
```typescript
{
  type: 'headline-card',
  title: string,          // required
  kicker?: string,        // small label above the title
  body?: string,          // supporting paragraph below the title
  placement?: Zone,       // default: 'bottom-center'
  motion?: MotionPreset,  // default: 'none'
}
```

**`callout`** — compact annotation for pointing out a UI element or fact.
```typescript
{
  type: 'callout',
  text: string,           // required
  placement?: Zone,       // default: 'bottom-center'
  motion?: MotionPreset,  // default: 'none'
}
```

**`image-card`** — image with optional caption text. `src` is a path relative to `demos/assets/`.
```typescript
{
  type: 'image-card',
  src: string,            // required, relative to demos/assets/
  title?: string,
  body?: string,
  placement?: Zone,       // default: 'bottom-center'
  motion?: MotionPreset,  // default: 'none'
}
```

---

### Zones

Controls where the overlay appears on screen. Only one overlay can occupy a zone at a time. Different zones can display overlays simultaneously.

| Zone | Description |
|---|---|
| `bottom-center` | Default. Horizontally centered at the bottom. |
| `top-left` | Top-left corner. |
| `top-right` | Top-right corner. |
| `bottom-left` | Bottom-left corner. |
| `bottom-right` | Bottom-right corner. |
| `center` | Center of the screen. |

---

### Motion Presets

Controls how the overlay animates in.

| Preset | Description |
|---|---|
| `none` | Default. Overlay appears instantly with no animation. |
| `fade-in` | 300ms opacity transition. |
| `slide-in` | 400ms combined translateX and opacity transition. |

---

## Overlay Manifest (optional)

File: `demos/<name>.overlays.json`

An optional JSON array of overlay entries. Used by the pipeline for automated overlay injection keyed to scene timestamps. The `scene` field must match a `narration.mark()` call in the demo script.

```json
[
  {
    "scene": "intro",
    "type": "lower-third",
    "text": "Welcome to our app",
    "motion": "fade-in"
  },
  {
    "scene": "feature",
    "type": "headline-card",
    "title": "Key Feature",
    "body": "Description of the feature",
    "placement": "top-right",
    "motion": "slide-in"
  }
]
```

Supported fields in each entry: `scene`, `type`, `text`, `title`, `kicker`, `body`, `src`, `placement`, `motion`. Which fields are valid depends on the `type` — see Overlay Template Types above.

---

## Voiceover Manifest

File: `demos/<name>.voiceover.json`

A JSON array of voiceover entries. Each `scene` must exactly match a `narration.mark()` argument in the corresponding demo script. The TTS step generates an audio clip per scene and the align step places each clip at the correct timestamp in the video.

```json
[
  {
    "scene": "intro",
    "text": "Welcome to our application. Let me show you around."
  },
  {
    "scene": "feature",
    "text": "This feature makes everything easier.",
    "voice": "af_heart",
    "speed": 1.0
  }
]
```

Fields:
- `scene` — **required**. Must exactly match a `narration.mark()` call.
- `text` — **required**. The spoken narration for this scene.
- `voice` — optional. Default: `af_heart`.
- `speed` — optional. Default: `1.0`.

---

## Configuration

File: `argo.config.js` in the project root. Uses ES module `export default { ... }` syntax.

| Field | Default | Description |
|---|---|---|
| `baseURL` | *(required, no default)* | URL of the running app to record. |
| `demosDir` | `'demos'` | Directory containing demo scripts and manifests. |
| `outputDir` | `'videos'` | Directory where finished videos are written. |
| `tts.defaultVoice` | `'af_heart'` | Default TTS voice used when `voice` is omitted from a voiceover entry. |
| `tts.defaultSpeed` | `1.0` | Default TTS speed used when `speed` is omitted from a voiceover entry. |
| `video.width` | `1920` | Recording and output video width in pixels. |
| `video.height` | `1080` | Recording and output video height in pixels. |
| `video.fps` | `30` | Frames per second. |
| `export.preset` | `'slow'` | ffmpeg encoding preset. Slower presets produce smaller files. |
| `export.crf` | `16` | ffmpeg constant rate factor. Lower = higher quality, larger file. |

Example:

```javascript
export default {
  baseURL: 'http://localhost:3000',
  demosDir: 'demos/',
  outputDir: 'videos/',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: { width: 1920, height: 1080, fps: 30 },
  export: { preset: 'slow', crf: 16 },
};
```

---

## Pipeline

The pipeline runs four steps in order: **TTS → Record → Align → Export**

### All-in-one (recommended)

```bash
npx argo pipeline <name>
```

Takes a bare demo name (e.g., `showcase` for `demos/showcase.demo.ts`). Handles all four steps internally in the correct order.

### Standalone commands

Run individual steps when debugging or re-running a single stage.

```bash
# Step 1: Generate TTS audio clips from the voiceover manifest
# IMPORTANT: takes a FILE PATH, not a bare name
npx argo tts generate demos/<name>.voiceover.json

# Step 2: Record the Playwright demo
# Takes a bare demo name
npx argo record <name>

# Step 3 & 4: Export (align + encode)
# Takes a bare demo name
npx argo export <name>
```

**Common mistake with `tts generate`**: passing `showcase` instead of `demos/showcase.voiceover.json` will fail silently. Always pass the full file path.

### Other commands

```bash
# Scaffold a new project with example demo, config, and manifests
npx argo init
```

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `"No video recording found"` | Playwright did not record the browser session. | Ensure `playwright.config.ts` has `use: { video: 'on' }` or `video: { mode: 'on' }`. |
| `"No timing file found"` | The timing file was not written — either wrong import or no `narration.mark()` calls. | Verify the demo script imports `test` from `@argo-video/cli` (not `@playwright/test`) and calls `narration.mark()` at least once. |
| `"ffmpeg/ffprobe not found"` | ffmpeg is not installed or not on PATH. | Install ffmpeg: `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux). |
| `"Playwright recording failed"` | Playwright cannot reach the app. | Verify the `baseURL` in `argo.config.js` points to a running, accessible app. |
| `"No TTS clips generated"` | Scene names in the voiceover manifest do not match `narration.mark()` arguments. | Check that every `scene` value in `<name>.voiceover.json` exactly matches a `narration.mark('...')` call in the demo script. |
| `"Failed to parse overlay manifest"` | `<name>.overlays.json` is malformed or uses unsupported values. | Validate the JSON (no trailing commas, balanced brackets). Confirm all `type`, `placement`, and `motion` values are from the supported lists above. |
