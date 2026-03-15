---
name: argo-guide
description: Guide for using Argo to create polished product demo videos from Playwright scripts with AI voiceover and animated overlays. Use this skill whenever the user mentions Argo, demo videos, product demos, screen recordings with narration, Playwright video demos, voiceover generation, or wants to automate creating marketing/sales/onboarding videos from a web app. Also use when you see imports from '@argo-video/cli', files named '*.demo.ts' or '*.voiceover.json', or an 'argo.config.js' in the project. Even if the user just says "record a demo" or "make a video of my app", this skill applies.
---

# Argo — Playwright Demo Videos with AI Voiceover

Argo turns Playwright demo scripts into polished product demo videos with AI voiceover and animated overlays. You write a Playwright script, mark scene boundaries, provide voiceover text in a JSON manifest, and Argo handles TTS generation, timing alignment, overlay injection, and ffmpeg video export — all locally, no cloud services.

## Operating Modes

- **Autonomous**: Drive the full pipeline — install Argo, explore the target app, write demo script + manifests, run the pipeline, deliver a finished MP4.
- **Assistive**: Help a user who already has Argo scripts — answer questions, fix errors, edit manifests, re-run individual pipeline steps.

---

## Prerequisites

Before writing or running any demo, verify:

1. **`@argo-video/cli`** in `devDependencies` — install with `npm i -D @argo-video/cli` if missing
2. **`argo.config.js`** in project root — scaffold with `npx argo init` if missing
3. **Playwright browsers** — `npx playwright install chromium` (or `webkit` for best macOS quality)
4. **ffmpeg** — required for export. `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux)

---

## Quick Start (Autonomous Workflow)

1. Check installation — look for `@argo-video/cli` in `package.json`. Install if absent.
2. Check config — look for `argo.config.js`. Run `npx argo init` if absent.
3. Ask the user for the app's base URL (e.g., `http://localhost:3000`). Set as `baseURL` in config.
4. Explore the app — navigate routes and features to plan a meaningful demo script.
5. Write `demos/<name>.demo.ts` — Playwright actions with `narration.mark()` scene boundaries.
6. Write `demos/<name>.voiceover.json` — narration text per scene. Scene names must exactly match `narration.mark()` arguments.
7. Optionally write `demos/<name>.overlays.json` — overlay cues keyed to scenes.
8. Run: `npx argo pipeline <name>`
9. Report output — finished MP4 is in `videos/` (or configured `outputDir`).

---

## Demo Script Authoring

Scripts live in `demos/` with the `.demo.ts` extension.

**Critical**: Import `test` from `@argo-video/cli`, NOT from `@playwright/test`. The Argo fixture provides the `narration` object. Using the Playwright import means `narration` will be undefined and timing data won't be captured.

```typescript
import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('my-demo', async ({ page, narration }) => {
  test.setTimeout(90000); // extend for long demos (Playwright default is 30s)
  await page.goto('/');
  await page.waitForTimeout(800);

  // Scene 1: Intro
  narration.mark('intro');
  await showOverlay(page, 'intro', {
    type: 'lower-third',
    text: 'Welcome to our app',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('intro'));

  // Scene 2: Feature walkthrough
  narration.mark('feature');
  await page.click('#start-button');
  await withOverlay(page, 'feature', {
    type: 'headline-card',
    title: 'One-Click Setup',
    body: 'Get started in seconds',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    await page.waitForTimeout(narration.durationFor('feature'));
  });

  // Scene 3: Closing
  narration.mark('closing');
  await page.waitForTimeout(narration.durationFor('closing'));
});
```

### Key APIs

| API | Description |
|-----|-------------|
| `narration.mark(scene)` | Record a timestamp for this scene. Every scene in voiceover/overlay manifests must have a matching mark. |
| `narration.durationFor(scene, opts?)` | Compute how long to hold this scene based on the TTS clip length. Replaces hardcoded `waitForTimeout(ms)` values. |
| `showOverlay(page, scene, cue, durationMs)` | Show overlay for N ms, then auto-remove. |
| `withOverlay(page, scene, cue, action)` | Show overlay during an async action, auto-remove when done (even on throw). |
| `hideOverlay(page, zone?)` | Manually remove overlay from a zone (or all zones). |
| `demoType(page, selectorOrLocator, text, delay?)` | Type text character-by-character (60ms default delay). Accepts a CSS selector string OR a Playwright Locator: `demoType(page, page.getByLabel('Email'), 'test@example.com')`. |
| `showConfetti(page, opts?)` | Burst confetti animation for mic-drop moments. **Non-blocking by default** — fires the animation and returns immediately, safe to call without `await`. Options: `duration` (3000ms), `pieces` (150), `spread` (`'burst'` / `'rain'`), `colors` (hex array), `fadeOut` (800ms), `wait` (false). Set `wait: true` to block until animation completes. |
| `spotlight(page, selector, opts?)` | Dark overlay with hole around target. Non-blocking. Options: `duration`, `opacity` (0.7), `padding` (12px). |
| `focusRing(page, selector, opts?)` | Pulsing glow border on target. Non-blocking. Options: `duration`, `color` ('#3b82f6'), `pulse` (true). |
| `dimAround(page, selector, opts?)` | Fade sibling elements to highlight target. Non-blocking. Options: `duration`, `dimOpacity` (0.3). |
| `zoomTo(page, selector, opts?)` | Scale viewport centered on target element. Options: `duration`, `scale` (1.5), `wait`. Note: overlays active during zoom will scale with the page. |
| `resetCamera(page)` | Clear all active camera effects immediately. |
| `page.waitForTimeout(ms)` | Add deliberate pauses for pacing. |

**Camera best practice**: Derive effect durations from `narration.durationFor()` so camera timing tracks the voiceover. Example: `const stepDur = Math.floor(narration.durationFor('scene') / 3)` then use `stepDur` for each effect.

### Dynamic Scene Durations with `durationFor()`

Instead of hardcoding wait times, use `narration.durationFor(scene, opts?)` which computes hold duration from the actual TTS clip length:

**Formula**: `clipMs × multiplier + leadInMs + leadOutMs`, clamped to `[minMs, maxMs]`

| Option | Default | Description |
|--------|---------|-------------|
| `multiplier` | `1` | Scale clip duration |
| `leadInMs` | `200` | Pause before clip starts |
| `leadOutMs` | `400` | Pause after clip ends |
| `minMs` | `2200` | Minimum scene duration |
| `maxMs` | `8000` | Maximum scene duration |
| `fallbackMs` | `3000` | Used if clip duration unknown |

Example with custom options:
```typescript
narration.durationFor('closing', { maxMs: 14000, leadOutMs: 800 });
```

---

## Overlay System

### Template Types

Every cue must include a `type` field. Common options shared by all: `placement` (Zone), `motion` (MotionPreset), `autoBackground` (boolean).

**`lower-third`** — text banner
```typescript
{ type: 'lower-third', text: 'Banner text', placement: 'bottom-center', motion: 'fade-in' }
```

**`headline-card`** — large card with title and optional body
```typescript
{ type: 'headline-card', title: 'Title', kicker: 'Label', body: 'Description', placement: 'top-right', motion: 'slide-in' }
```

**`callout`** — compact annotation bubble
```typescript
{ type: 'callout', text: 'Note this', placement: 'top-left', motion: 'fade-in' }
```

**`image-card`** — image with optional caption (`src` relative to `demos/assets/`)
```typescript
{ type: 'image-card', src: 'screenshot.png', title: 'Caption', body: 'Details' }
```

### Zones (6 positions)

`bottom-center` (default) | `top-left` | `top-right` | `bottom-left` | `bottom-right` | `center`

Only one overlay per zone at a time. Different zones can show overlays simultaneously.

**Placement tip**: If the app has a left sidebar or nav, prefer `top-right` / `bottom-right` for overlays on dashboard-style pages to avoid covering navigation. Use `top-left` for pages with right-heavy content or clean layouts.

### Motion Presets

`none` (default, instant) | `fade-in` (300ms opacity) | `slide-in` (400ms translateX + opacity)

### Auto Background Detection

Set `autoBackground: true` on any overlay cue (or globally via `overlays.autoBackground` in config). Argo reads the page background color at the overlay's zone position and picks a contrasting theme — dark background gets light overlay text, light background gets dark overlay text.

Detection skips `position: fixed/sticky` elements (e.g., navbars) so it reads the actual content area.

---

## Voiceover Manifest

File: `demos/<name>.voiceover.json` — JSON array of entries.

```json
[
  { "scene": "intro", "text": "Welcome to our application." },
  { "scene": "feature", "text": "This feature simplifies everything.", "voice": "af_heart", "speed": 1.0 },
  { "scene": "closing", "text": "Thanks for watching.", "voice": "am_michael", "speed": 0.9 }
]
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `scene` | yes | — | Must exactly match a `narration.mark()` call |
| `text` | yes | — | Spoken narration text |
| `voice` | no | `af_heart` | Kokoro voice: `af_heart` (female), `am_michael` (male) |
| `speed` | no | `1.0` | Playback speed (0.9 = slightly slower, good for narration) |

TTS runs locally via Kokoro by default — no API keys needed. Clips are content-addressed cached in `.argo/<demo>/clips/` by SHA256 of `{scene, text, voice, speed}`. Clear the cache (`rm -rf .argo/<demo>/clips`) if voiceover text changes and stale clips persist.

### TTS Engine Selection

Argo supports 6 TTS engines via typed factory functions. Set the engine in config:

```javascript
import { defineConfig, engines } from '@argo-video/cli';

export default defineConfig({
  tts: {
    engine: engines.openai({ model: 'tts-1-hd' }),  // swap engine here
    defaultVoice: 'alloy',
  },
});
```

| Engine | Type | Install | Voices |
|--------|------|---------|--------|
| `engines.kokoro()` | local | built-in | `af_heart`, `am_michael` |
| `engines.openai()` | cloud | `npm i openai` | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `engines.elevenlabs()` | cloud | `npm i elevenlabs` | ElevenLabs voice IDs |
| `engines.gemini()` | cloud | `npm i @google/genai` | Gemini voice names |
| `engines.sarvam()` | cloud | none (fetch) | `meera` + Indian language voices |
| `engines.mlxAudio()` | local | `pip install mlx-audio` | model-dependent (Apple Silicon) |

Cloud engines read API keys from environment variables (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `SARVAM_API_KEY`) or accept `apiKey` in the factory options.

Custom engines: implement the `TTSEngine` interface and pass to `tts.engine` in config.

### Voice Cloning (mlx-audio)

Clone your own voice from a 15-second reference clip. Local, private — no data leaves the machine.

```javascript
engines.mlxAudio({
  model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
  refAudio: './assets/ref-voice.wav',
  refText: 'Transcript of what I said in the reference clip.',
})
```

Helper scripts:
- `./scripts/record-voice-ref.sh assets/ref-voice.wav` — record reference clip (macOS)
- `./scripts/voice-clone-preview.sh --ref-audio ... --voiceover ... --play` — preview cloned voice

Qwen3-TTS produces the best voice clone quality. CSM is supported but lower quality.

### Phonetic Spelling for TTS Pronunciation

The voiceover `text` is only spoken, never displayed — overlay text in the demo script is what viewers see. So you can spell words phonetically in the manifest to fix TTS pronunciation without affecting visuals.

**Important:** Phonetic spellings are for voiceover manifest text only. Overlay text in demo scripts is visible to viewers, so always use normal human-facing spelling there.

| Written | Phonetic for TTS |
|---------|-----------------|
| `SaaS` | `sass` |
| `PostgreSQL` | `post-gress Q L` |
| `OAuth` | `oh-auth` |
| `API` | `A P I` |
| `kubectl` | `cube control` |
| `nginx` | `engine X` |
| `CI/CD` | `C I C D` |
| `.env` | `dot env` |

**Patterns:**
1. **Acronyms** — spell out with spaces: `CI/CD` → `C I C D`
2. **Portmanteaus** — hyphenate syllables: `Kubernetes` → `koo-ber-net-eez`
3. **Elongated letters** — reduce repeated chars: `IaaS` → `ee-ass`
4. **Silent/odd spellings** — write how it sounds: `sudo` → `sue-doo`

---

## Configuration

File: `argo.config.mjs` (use `.mjs` to avoid ESM warnings in non-module projects).

```javascript
import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'webkit',        // webkit > firefox > chromium on macOS for video quality
    // deviceScaleFactor: 2,  // 2x capture + lanczos downscale (known issue with webkit)
  },
  export: {
    preset: 'slow',           // ffmpeg preset: slower = smaller file
    crf: 16,                  // quality: 16-28 (lower = higher quality)
    thumbnailPath: 'assets/logo-thumb.png',  // optional MP4 cover art (PNG)
  },
  overlays: {
    autoBackground: true,     // auto-detect dark/light page for overlay contrast
    // defaultPlacement: 'top-right',  // default zone when cue omits placement
  },
});
```

All fields are optional — `defineConfig()` merges with sensible defaults.

### Browser Quality

On macOS, video capture quality varies by browser engine: **webkit > firefox > chromium**. Chromium has a known capture quality issue. Use `--browser webkit` or set `video.browser: 'webkit'` in config for best results.

### High-DPI Recording

Set `video.deviceScaleFactor: 2` to capture at 2x resolution. The export step automatically downscales to the logical resolution using a lanczos filter, producing sharper final output.

**Known issue**: `deviceScaleFactor: 2` may cause rendering issues with webkit (viewport at 1/4 of the frame). Stick to `deviceScaleFactor: 1` until this is fixed.

### Config File Extension

Use `.mjs` for the config file in projects without `"type": "module"` in their `package.json` to avoid Node ESM warnings. The `argo init` scaffold generates `.js` by default — rename to `argo.config.mjs` if you see `MODULE_TYPELESS_PACKAGE_JSON` warnings.

---

## Pipeline Commands

### Full pipeline (recommended)
```bash
npx argo pipeline <name>              # e.g., npx argo pipeline showcase
npx argo pipeline <name> --browser webkit  # override browser
npx argo pipeline <name> --base-url http://localhost:4000  # override baseURL
```

### Validate (dry run, no TTS/recording)
```bash
npx argo validate <name>    # checks scene name consistency across script + manifests
```

### Individual steps (for debugging)
```bash
# Step 1: TTS — IMPORTANT: takes a FILE PATH, not a bare name
npx argo tts generate demos/<name>.voiceover.json

# Step 2: Record — takes a bare demo name
npx argo record <name>
npx argo record <name> --browser webkit --base-url http://localhost:4000

# Step 3+4: Export (align + encode) — takes a bare demo name
npx argo export <name>
```

### Scaffold
```bash
npx argo init    # creates example demo, config (.mjs), playwright config
```

### Pipeline order
**TTS → Record → Align → Export** (not Record first — TTS must run first so `durationFor()` has clip lengths available during recording).

### Pipeline output
After a successful run, the pipeline produces:
- `videos/<name>.mp4` — the final video with embedded chapter markers
- `videos/<name>.srt` — SRT subtitle file
- `videos/<name>.vtt` — WebVTT subtitle file
- `.argo/<name>/scene-report.json` — scene timing report (durations, overflow)

TTS clips are cached by content hash for faster rebuilds. Subtitles are derived from voiceover manifest text + alignment placements.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| No video recording found | Playwright didn't capture video | Ensure video mode is `'on'` in playwright config |
| No timing file | Wrong import or missing `narration.mark()` | Import `test` from `@argo-video/cli`, not `@playwright/test` |
| ffmpeg not found | ffmpeg not installed | `brew install ffmpeg` (macOS) or `apt install ffmpeg` |
| Recording fails / app unreachable | Wrong `baseURL` | Verify the app is running and URL is correct in config |
| Stale voiceover audio | TTS cache not cleared after text change | `rm -rf .argo/<demo>/clips` |
| Scene names not matching | Mismatch between manifest and `mark()` calls | Scene names are case-sensitive exact strings |
| Timeout during recording | Demo exceeds Playwright's 30s default | Add `test.setTimeout(90000)` at start of test |
| `tts generate` fails silently | Passed bare name instead of file path | Use `demos/<name>.voiceover.json`, not just `<name>` |

---

## Runtime Directory Structure

```
project/
├── demos/
│   ├── <name>.demo.ts           # Demo script
│   ├── <name>.voiceover.json    # Voiceover manifest
│   ├── <name>.overlays.json     # Overlay manifest (optional)
│   └── assets/                  # Images for image-card overlays
├── videos/                      # Output MP4s
├── .argo/                       # Working directory (auto-created)
│   └── <name>/
│       ├── clips/               # Cached TTS WAV files
│       ├── video.webm           # Recorded browser session
│       ├── .timing.json         # Scene timestamps
│       ├── .scene-durations.json # TTS clip durations
│       └── narration-aligned.wav # Mixed audio track
├── argo.config.js               # Configuration
└── playwright.config.ts         # Playwright config (auto-generated or scaffolded)
```

### Gitignore

Add `.argo/` and `videos/` to `.gitignore` — they contain large generated artifacts (WAV clips, WebM recordings, mixed audio). When setting up a new project, ensure these lines are present:

```
.argo/
videos/
test-results/
```

### Cleanup

To free disk space or force a full re-run:

```bash
# Remove all pipeline artifacts for a specific demo
rm -rf .argo/<name>/

# Remove only cached TTS clips (forces re-generation)
rm -rf .argo/<name>/clips/

# Remove everything
rm -rf .argo/
```
