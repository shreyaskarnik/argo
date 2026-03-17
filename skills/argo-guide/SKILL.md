---
name: argo-guide
description: Guide for using Argo to create polished product demo videos from Playwright scripts with AI voiceover and animated overlays. Use this skill whenever the user mentions Argo, demo videos, product demos, screen recordings with narration, Playwright video demos, voiceover generation, or wants to automate creating marketing/sales/onboarding videos from a web app. Also use when you see imports from '@argo-video/cli', files named '*.demo.ts' or '*.scenes.json', or an 'argo.config.js' in the project. Even if the user just says "record a demo" or "make a video of my app", this skill applies.
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
4. **If the user already has a Playwright test:** Run `npx argo init --from <path>` to auto-generate demo script + skeleton manifest. Then fill in voiceover text (use `_hint` fields as context) and refine overlays. Skip to step 8.
5. Explore the app — navigate routes and features to plan a meaningful demo script.
6. Write `demos/<name>.demo.ts` — Playwright actions with `narration.mark()` scene boundaries.
7. Write `demos/<name>.scenes.json` — unified manifest with narration text and optional overlay per scene. Scene names must exactly match `narration.mark()` arguments.
8. Run: `npx argo pipeline <name>`
10. Report output — finished MP4 is in `videos/` (or configured `outputDir`).

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
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  // Scene 2: Feature walkthrough
  narration.mark('feature');
  await page.click('#start-button');
  await withOverlay(page, 'feature', async () => {
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
| `narration.mark(scene)` | Record a timestamp for this scene. Every scene in the scenes manifest must have a matching mark. |
| `narration.durationFor(scene, opts?)` | Compute how long to hold this scene based on the TTS clip length. Replaces hardcoded `waitForTimeout(ms)` values. |
| `showOverlay(page, scene, cue, durationMs)` | Show overlay for N ms, then auto-remove. |
| `withOverlay(page, scene, cue, action)` | Show overlay during an async action, auto-remove when done (even on throw). |
| `hideOverlay(page, zone?)` | Manually remove overlay from a zone (or all zones). |
| `demoType(page, selectorOrLocator, text, delay?)` | Type text character-by-character (60ms default delay). Accepts a CSS selector string OR a Playwright Locator: `demoType(page, page.getByLabel('Email'), 'test@example.com')`. |
| `showConfetti(page, opts?)` | Burst confetti animation for mic-drop moments. **Non-blocking by default** — fires the animation and returns immediately, safe to call without `await`. Options: `duration` (3000ms), `pieces` (150), `spread` (`'burst'` / `'rain'`), `colors` (hex array), `fadeOut` (800ms), `wait` (false). Set `wait: true` to block until animation completes. |
| `spotlight(page, selectorOrLocator, opts?)` | Dark overlay with hole around target. Non-blocking. Accepts CSS selector or Playwright Locator. Options: `duration`, `opacity` (0.7), `padding` (12px). |
| `focusRing(page, selectorOrLocator, opts?)` | Pulsing glow border on target. Non-blocking. Accepts CSS selector or Playwright Locator. Options: `duration`, `color` ('#3b82f6'), `pulse` (true). |
| `dimAround(page, selectorOrLocator, opts?)` | Fade sibling elements to highlight target. Non-blocking. Accepts CSS selector or Playwright Locator. Options: `duration`, `dimOpacity` (0.3). |
| `zoomTo(page, selectorOrLocator, opts?)` | Scale viewport centered on target element. Accepts CSS selector or Playwright Locator. Options: `duration`, `scale` (1.5), `wait`. Note: overlays active during zoom will scale with the page. |
| `resetCamera(page)` | Clear all active camera effects immediately. |
| `cursorHighlight(page, opts?)` | Persistent cursor highlight that follows the mouse. Options: `color` ('#3b82f6'), `radius` (20px), `pulse` (true), `clickRipple` (true), `opacity` (0.5). Call `resetCursor(page)` to remove. |
| `resetCursor(page)` | Remove cursor highlight. |
| `page.waitForTimeout(ms)` | Add deliberate pauses for pacing. |

**Camera best practice**: Derive effect durations from `narration.durationFor()` so camera timing tracks the voiceover. Example: `const stepDur = Math.floor(narration.durationFor('scene') / 3)` then use `stepDur` for each effect.

### Off-Camera Setup and Teardown

The pipeline **auto-trims** the video to start ~200ms before the first `narration.mark()` and end when narration finishes. Everything before the first mark (setup, login, feature flags) and after the last scene is automatically cut from the final MP4. Use this for:

```typescript
test('demo', async ({ page, narration }) => {
  // OFF-CAMERA SETUP — login, enable feature flags, seed data
  await page.goto('/admin');
  await page.fill('#email', process.env.ADMIN_EMAIL);
  await page.click('#login');
  await page.waitForURL('/dashboard');
  await page.click('#enable-beta-feature');

  // ON-CAMERA — demo starts at first mark
  narration.mark('intro');
  await showOverlay(page, 'intro', narration.durationFor('intro'));

  // ... more scenes ...

  narration.mark('closing');
  await showOverlay(page, 'closing', narration.durationFor('closing'));

  // OFF-CAMERA TEARDOWN — clean up after video ends
  await page.goto('/admin');
  await page.click('#disable-beta-feature');
});
```

This means you can toggle feature flags, switch accounts, or seed test data without it appearing in the final video — and tear it down after so re-recording works cleanly.

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

## Scenes Manifest

File: `demos/<name>.scenes.json` — unified JSON array of entries combining voiceover and overlay definitions.

```json
[
  {
    "scene": "intro",
    "text": "Welcome to our application.",
    "overlay": { "type": "lower-third", "text": "Welcome", "placement": "bottom-center", "motion": "fade-in" }
  },
  {
    "scene": "feature",
    "text": "This feature simplifies everything.",
    "voice": "af_heart",
    "speed": 1.0,
    "overlay": { "type": "headline-card", "title": "One-Click Setup", "placement": "top-right", "motion": "slide-in" }
  },
  {
    "scene": "closing",
    "text": "Thanks for watching.",
    "voice": "am_michael",
    "speed": 0.9
  }
]
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `scene` | yes | — | Must exactly match a `narration.mark()` call |
| `text` | no | — | Spoken narration text. Omit for silent scenes (no TTS generated). |
| `voice` | no | `af_heart` | Kokoro voice: `af_heart` (female), `am_michael` (male) |
| `speed` | no | `1.0` | Playback speed (0.9 = slightly slower, good for narration) |
| `lang` | no | — | Language code for multilingual TTS engines |
| `_hint` | no | — | LLM hint describing scene context (generated by `init --from`, remove before recording) |
| `overlay` | no | — | Optional overlay cue for this scene (same fields as inline `showOverlay` cue) |
| `effects` | no | — | Array of effects to apply during this scene: `confetti`, `spotlight`, `focus-ring`, `dim-around`, `zoom-to` |

TTS runs locally via Kokoro by default — no API keys needed. Clips are content-addressed cached in `.argo/<demo>/clips/` by SHA256 of `{scene, text, voice, speed}`. Clear the cache (`rm -rf .argo/<demo>/clips`) if voiceover text changes and stale clips persist.

**Silent demos:** Omit `text` from all scenes to create a video with no audio track — useful for quick prototype demos with just overlays and camera effects.

### TTS Engine Selection

Argo supports 6 TTS engines via typed factory functions. Set the engine in config:

```javascript
import { defineConfig, engines } from '@argo-video/cli';

export default defineConfig({
  tts: {
    engine: engines.openai({ model: 'gpt-4o-mini-tts', instructions: 'Speak clearly and confidently.' }),
    defaultVoice: 'alloy',
  },
});
```

| Engine | Type | Install | Voices |
|--------|------|---------|--------|
| `engines.kokoro()` | local | built-in | `af_heart`, `am_michael` |
| `engines.openai()` | cloud | `npm i openai` | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `engines.elevenlabs()` | cloud | `npm i @elevenlabs/elevenlabs-js` | ElevenLabs voice IDs |
| `engines.gemini()` | cloud | `npm i @google/genai` | Gemini voice names |
| `engines.sarvam()` | cloud | `npm i sarvamai` | `meera` + Indian language voices |
| `engines.mlxAudio()` | local | `pip install mlx-audio` | model-dependent (Apple Silicon) |
| `engines.transformers()` | local | built-in | any HuggingFace TTS model (speaker embeddings via `voice` field) |

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

Helper scripts (use `$(npm root)/@argo-video/cli/scripts/` for npm installs, or `./scripts/` if cloned from repo):
- `record-voice-ref.sh assets/ref-voice.wav` — record reference clip (macOS)
- `voice-clone-preview.sh --ref-audio ... --voiceover demos/<name>.scenes.json --play` — preview cloned voice

Qwen3-TTS produces the best voice clone quality. CSM is supported but lower quality.

#### mlx-audio Full Options

```javascript
engines.mlxAudio({
  baseUrl: 'http://localhost:8000',  // server URL (default)
  model: 'mlx-community/Spark-TTS-0.5B-bf16',
  refAudio: './ref.wav',        // voice cloning reference
  refText: 'Transcript...',     // required with refAudio
  instruct: 'Speak warmly',    // style/emotion control
  gender: 'male',              // gender hint
  temperature: 0.7,            // sampling temperature
  topP: 0.95,                  // top-p sampling
  topK: 40,                    // top-k sampling
})
```

### Phonetic Spelling for TTS Pronunciation

The voiceover `text` is only spoken, never displayed — overlay text in the demo script is what viewers see. So you can spell words phonetically in the manifest to fix TTS pronunciation without affecting visuals.

**Important:** Phonetic spellings are for spoken narration text only (the `text` field in `.scenes.json`). Overlay text is visible to viewers, so always use normal human-facing spelling there.

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

**Per-engine differences:** Kokoro needs heavy phonetic help (`tee tee ess`, `A.I.`, `M.L.X.`). OpenAI handles most acronyms natively — just write `TTS`, `AI`, `MLX`. Qwen3 (mlx-audio) is similar to Kokoro. When switching engines, review voiceover text for pronunciation.

### Overlays: Manifest vs Inline

Two ways to add overlays — use **one or the other**, not both for the same scene:

- **Manifest** (recommended for most scenes): Define an `overlay` sub-object in the `scenes.json` entry. Argo injects it automatically at recording time. `showOverlay(page, scene, durationMs)` — no inline cue needed.
- **Inline**: `showOverlay(page, scene, cue, durationMs)` / `withOverlay(page, scene, cue, action)` in the demo script with an explicit cue object. Use this when overlays need to interact with camera effects or conditional logic.

The manifest overlay is simpler and keeps cue definitions co-located with voiceover text. Inline is more flexible for advanced orchestration.

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

### 5K Displays and 4K Exports

On a `5K` monitor, a `1080p` or `1440p` export can look soft when viewed fullscreen even if the recording itself is fine. Judge quality at `1:1` size or export a higher-resolution master for flagship demos.

Recommended presets:

- Everyday demos / social clips: `1920x1080` or `2560x1440`
- Landing pages / showcase videos on large Retina displays: `3840x2160`, `deviceScaleFactor: 1`

Example `4K` showcase config:

```javascript
video: {
  width: 3840,
  height: 2160,
  fps: 30,
  browser: 'webkit',
  deviceScaleFactor: 1,
}
```

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

The pipeline auto-trims setup/teardown (before first `narration.mark()`) and writes `<name>.meta.json` alongside the video with TTS engine, voices, resolution, and export settings.

### Validate (dry run, no TTS/recording)
```bash
npx argo validate <name>    # checks scene name consistency across script + manifests
```

### Individual steps (for debugging)
```bash
# Step 1: TTS — IMPORTANT: takes a FILE PATH, not a bare name
npx argo tts generate demos/<name>.scenes.json

# Step 2: Record — takes a bare demo name
npx argo record <name>
npx argo record <name> --browser webkit --base-url http://localhost:4000

# Step 3+4: Export (align + encode) — takes a bare demo name
npx argo export <name>
```

### Preview (interactive replay viewer)
```bash
npx argo preview <name>              # starts preview server at localhost (open URL in browser)
npx argo preview <name> --port 3333  # custom port
```

Preview lets you iterate on voiceover text, overlay content, and timing without re-recording. It serves a local web page that plays the recorded video.webm alongside aligned audio, renders overlay cues on a DOM layer, and provides:
- Scene timeline with clickable markers
- Editable voiceover text, voice, and speed per scene
- Editable overlay type, zone, and text per scene
- Per-scene TTS regeneration (re-generates just that clip)
- Save button persists changes back to manifests on disk
- Trace viewer link (traces are captured during recording)

**Workflow:** Run `argo pipeline <name>` once, then `argo preview <name>` to iterate on voiceover and overlays. Only re-run `argo pipeline` when the demo script itself changes.

### Scaffold
```bash
npx argo init    # creates example demo, config (.mjs), playwright config
```

### Convert Existing Playwright Test
```bash
npx argo init --from tests/checkout.spec.ts           # auto-derives demo name from filename
npx argo init --from tests/checkout.spec.ts --demo my-demo  # custom demo name
```

This parses the Playwright test and generates:
- `demos/<name>.demo.ts` — fixture swapped to `@argo-video/cli`, `narration.mark()` + `durationFor()` inserted at scene boundaries
- `demos/<name>.scenes.json` — skeleton with `_hint` fields describing what each scene does, and lower-third overlay placeholders per scene

**Scene detection heuristics:** `test.step()` names (strongest signal), `page.goto()` navigations, `// comments`, form fills grouped together, click + assertion pairs.

**Important:** The parser is heuristic-based — generated scripts may need manual fixes, especially for chained Playwright expressions (e.g., `page.locator().filter().click()` may produce orphaned calls). Always review the generated demo script before recording.

**LLM workflow after `init --from`:**

1. **Fill in voiceover text** — open `<name>.scenes.json`. Each entry has a `_hint` field describing what happens in that scene. Write natural narration text for each `text` field using the hint as context. Remove `_hint` fields when done.
2. **Add camera effects** — open `<name>.demo.ts`. Add `spotlight()`, `focusRing()`, `dimAround()` calls at key moments. Derive durations from `narration.durationFor()` (e.g., `Math.floor(durationFor('scene') / 3)`).
3. **Refine overlays** — the `overlay` sub-object in each `<name>.scenes.json` entry has basic lower-third placeholders. Upgrade to `headline-card`, `callout`, or `image-card` where appropriate. Add `motion: 'slide-in'` and `autoBackground: true`.
4. **Add `test.setTimeout()`** — if the demo is longer than 30 seconds, add `test.setTimeout(90000)` at the top.
5. **Apply phonetic fixes** — if using Kokoro, spell tricky words phonetically in voiceover text (e.g., "sass" for SaaS). Not needed for OpenAI.
6. **Validate** — run `npx argo validate <name>` to check scene name consistency before recording.
7. **Record** — run `npx argo pipeline <name>` to generate the video.

### Pipeline order
**TTS → Record → Align → Export** (not Record first — TTS must run first so `durationFor()` has clip lengths available during recording).

### Pipeline output
After a successful run, the pipeline produces:
- `videos/<name>.mp4` — the final video with embedded chapter markers
- `videos/<name>.srt` — SRT subtitle file
- `videos/<name>.vtt` — WebVTT subtitle file
- `.argo/<name>/scene-report.json` — scene timing report (durations, overflow)

TTS clips are cached by content hash for faster rebuilds. Subtitles are derived from scenes manifest text + alignment placements.

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
| `tts generate` fails silently | Passed bare name instead of file path | Use `demos/<name>.scenes.json`, not just `<name>` |

---

## Runtime Directory Structure

```
project/
├── demos/
│   ├── <name>.demo.ts           # Demo script
│   ├── <name>.scenes.json       # Unified manifest (voiceover + overlays)
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
