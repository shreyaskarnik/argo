---
name: argo-guide
description: Guide for using Argo to create polished product demo videos from Playwright scripts with AI voiceover and animated overlays. Use this skill whenever the user mentions Argo, demo videos, product demos, screen recordings with narration, Playwright video demos, voiceover generation, or wants to automate creating marketing/sales/onboarding videos from a web app. Also use when you see imports from '@argo-video/cli', files named '*.demo.ts' or '*.scenes.json', or an 'argo.config.js' in the project. Even if the user just says "record a demo" or "make a video of my app", this skill applies.
---

# Argo — Playwright Demo Videos with AI Voiceover

Argo turns Playwright demo scripts into polished product demo videos with AI voiceover and animated overlays. Runs locally by default with no API keys needed (Kokoro TTS), but also supports cloud TTS engines (OpenAI, ElevenLabs, Gemini, Sarvam) for higher-quality or multilingual voiceover.

## Operating Modes

- **Autonomous**: Drive the full pipeline — install Argo, explore the target app, write demo script + manifests, run the pipeline, deliver a finished MP4.
- **Assistive**: Help a user who already has Argo scripts — answer questions, fix errors, edit manifests, re-run individual pipeline steps.

---

## Prerequisites

1. **`@argo-video/cli`** in `devDependencies` — install with `npm i -D @argo-video/cli` if missing
2. **`argo.config.mjs`** in project root — scaffold with `npx argo init` if missing (use `.mjs` to avoid ESM warnings)
3. **Playwright browsers** — `npx playwright install chromium` (or `webkit` for best macOS quality)
4. **ffmpeg** — `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux)
5. **Gitignore** — add `.argo/`, `videos/`, and `test-results/` to `.gitignore`. These contain large generated artifacts (WAV clips, WebM recordings, MP4 output) that should not be committed.

---

## Quick Start (Autonomous Workflow)

1. Check installation — look for `@argo-video/cli` in `package.json`. Install if absent.
2. Check config — look for `argo.config.mjs`. Run `npx argo init` if absent.
3. Ask the user for the app's base URL (e.g., `http://localhost:3000`). Set as `baseURL` in config.
4. **If the user already has a Playwright test:** Run `npx argo init --from <path>` to auto-generate demo script + skeleton manifest. Then fill in voiceover text (use `_hint` fields as context) and refine overlays. Skip to step 8.
5. Explore the app — navigate routes and features to plan a meaningful demo script.
6. Write `demos/<name>.demo.ts` — see `examples/` directory in this skill for a complete template.
7. Write `demos/<name>.scenes.json` — unified manifest with narration text and optional overlay per scene. Scene names must exactly match `narration.mark()` arguments.
8. Run: `npx argo pipeline <name>`
9. Report output — finished MP4 is in `videos/` (or configured `outputDir`).

---

## Demo Script Essentials

Scripts live in `demos/` with the `.demo.ts` extension. See `examples/basic.demo.ts` in this skill for a complete working example.

**The #1 mistake**: importing `test` from `@playwright/test` instead of `@argo-video/cli`. The Argo fixture provides the `narration` object — using the Playwright import means `narration` is undefined and no timing data is captured. This causes the confusing "No timing file found" error at export time.

```typescript
import { test } from '@argo-video/cli';               // CORRECT
import { showOverlay, withOverlay } from '@argo-video/cli';
// import { test } from '@playwright/test';            // WRONG — narration will be undefined
```

### Core APIs

| API | What it does |
|-----|-------------|
| `narration.mark(scene)` | Record timestamp. Every scene in the manifest needs a matching mark. |
| `narration.durationFor(scene, opts?)` | Compute hold duration from TTS clip length. Use instead of hardcoded `waitForTimeout(ms)`. |
| `showOverlay(page, scene, durationMs)` | Show manifest overlay for N ms, then auto-remove. |
| `withOverlay(page, scene, action)` | Show manifest overlay during an async action, auto-remove when done. |
| `demoType(page, selectorOrLocator, text, delay?)` | Character-by-character typing (60ms default). Accepts CSS selector or Playwright Locator. |

### Camera & Effects

All camera effects are **non-blocking by default** (fire-and-forget safe). All accept CSS selector strings or Playwright Locators.

| API | Effect |
|-----|--------|
| `spotlight(page, target, opts?)` | Dark overlay with hole around target |
| `focusRing(page, target, opts?)` | Pulsing glow border |
| `dimAround(page, target, opts?)` | Fade siblings to highlight target |
| `zoomTo(page, target, opts?)` | Scale viewport centered on target. Pass `{ narration }` for overlay-safe ffmpeg post-export zoom (recommended). Without `narration`, falls back to browser-side CSS transforms (overlays scale with the page). |
| `resetCamera(page)` | Clear all active camera effects |
| `showConfetti(page, opts?)` | Confetti burst. `spread: 'burst'` (center-top fan) or `'rain'` (full-width fall). `emoji: '🎃'` or `emoji: ['🎃', '👻']` renders emoji instead of colored rectangles. |
| `cursorHighlight(page, opts?)` | Persistent ring following cursor. Remove with `resetCursor(page)`. |

Derive camera durations from `narration.durationFor()` so effects track voiceover timing:
**Effect timing pattern**: Derive beat durations from `durationFor()` so effects stay synchronized with voiceover. Subtract any setup wait time before dividing:
```typescript
const totalMs = narration.durationFor('scene') - setupWaitMs;
const beat = Math.floor(totalMs / numberOfEffects);
spotlight(page, '#target1', { duration: beat });
await page.waitForTimeout(beat + 150); // gap between effects
focusRing(page, '#target2', { color: '#3b82f6', duration: beat });
```
Hardcoded durations (e.g., `duration: 1200`) drift from the voiceover as clip lengths change.

**Post-export camera moves (recommended for `zoomTo`)**: Pass `narration` to record as an ffmpeg camera move instead of DOM transforms. Overlay-safe and frame-exact:
```typescript
narration.mark('details');
await zoomTo(page, '#revenue-chart', { narration, scale: 1.5, holdMs: 2000 });
await page.waitForTimeout(narration.durationFor('details'));
```
The zoom is applied during export via ffmpeg `zoompan` (not `crop` — crop w/h are not per-frame). Camera moves are written to `.timing.camera-moves.json` and auto-shifted for head trim + scaled for `deviceScaleFactor`.

### Mobile Demos

For mobile viewport recording, set `isMobile`, `hasTouch`, and `video.size` in the demo script via `test.use()`:

```typescript
test.use({
  viewport: { width: 390, height: 664 },
  isMobile: true,
  hasTouch: true,
  video: { mode: 'on' as const, size: { width: 390, height: 664 } },
});
```

The `video.size` override is essential — without it, the capture canvas defaults to 1920x1080 and the mobile viewport renders in the top-left with gray padding. Use `.tap()` instead of `.click()` for touch interactions.

These options can also be set in `argo.config.mjs` under `video` for all demos:
```javascript
video: { width: 390, height: 664, isMobile: true, hasTouch: true }
```

### Timeouts

Long demos need generous timeouts. Playwright default is 30s, but a 10-scene demo with TTS easily runs 2-3 minutes:

```typescript
test.setTimeout(scenes.length * 15_000); // ~15s per scene as a rule of thumb
```

Or just use a large fixed value: `test.setTimeout(300_000)` for up to 5 minutes.

### Auto-Trim (Off-Camera Setup)

The pipeline trims video to start ~200ms before the first `narration.mark()`. Everything before (login, feature flags, data seeding) and after the last scene is cut from the final MP4. This means setup code never appears in the video — no need for separate test fixtures.

### Dynamic Durations

`durationFor()` formula: `clipMs * multiplier + leadInMs + leadOutMs`, clamped to `[minMs, maxMs]`.

Defaults: `leadInMs: 200`, `leadOutMs: 400`, `minMs: 2200`, `maxMs: 8000`, `fallbackMs: 3000`.

Override per-scene: `narration.durationFor('closing', { maxMs: 14000, leadOutMs: 800 })`.

---

## Scenes Manifest

File: `demos/<name>.scenes.json` — JSON array combining voiceover + overlay definitions per scene.

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

Key fields: `scene` (required, matches `mark()`), `text` (spoken narration — omit for silent scenes), `voice` (default `af_heart`), `speed` (default `1.0`), `overlay` (optional cue object).

**`effects` field**: The `effects` array in scenes.json is **preview-UI metadata only** — it does NOT auto-inject effects during recording. To produce camera effects in the final video, you must call `showConfetti()`, `spotlight()`, etc. explicitly in the demo script. The `effects` field is used by `argo preview` for editing and display purposes.

**Silent demos:** Omit `text` from all scenes — exports video-only with no audio track.

### Overlay Templates

Four types, each with a `type` discriminant. All support `placement`, `motion`, and `autoBackground`.

- **`lower-third`**: `{ type: 'lower-third', text: '...' }` — text banner
- **`headline-card`**: `{ type: 'headline-card', title: '...', kicker: '...', body: '...' }` — large card
- **`callout`**: `{ type: 'callout', text: '...' }` — compact annotation
- **`image-card`**: `{ type: 'image-card', src: 'screenshot.png', title: '...' }` — image with caption (`src` relative to `demos/assets/`)

**Zones:** `bottom-center` (default) | `top-left` | `top-right` | `bottom-left` | `bottom-right` | `center`. One overlay per zone; different zones can show simultaneously. Prefer `top-right`/`bottom-right` for apps with left sidebars.

**Motion:** `none` (instant) | `fade-in` (300ms) | `slide-in` (400ms)

**Auto background:** Set `autoBackground: true` to auto-detect page contrast. Skips fixed/sticky elements (navbars).

### How Overlays Get Triggered

Overlays need **two things** to appear in the video:
1. **Define** the overlay in `.scenes.json` (what to show — template, text, placement)
2. **Trigger** it in the demo script via `showOverlay(page, scene, durationMs)` (when to show it)

The manifest alone does NOT render overlays during recording. You must call `showOverlay()` in the script:

```typescript
narration.mark('intro');
// This triggers the overlay defined in .scenes.json for "intro"
await showOverlay(page, 'intro', narration.durationFor('intro'));
```

**Two call signatures:**
- `showOverlay(page, scene, durationMs)` — reads overlay from manifest (recommended, 90% of cases)
- `showOverlay(page, scene, cueObject, durationMs)` — inline cue, overrides manifest (for conditional/dynamic overlays)

Use `withOverlay(page, scene, async () => { ... })` when you need camera effects during the overlay.

---

## Pipeline Commands

```bash
npx argo pipeline <name>                    # Full pipeline (recommended)
npx argo pipeline --all                     # Run pipeline for ALL demos in demosDir
npx argo pipeline <name> --browser webkit   # Override browser
npx argo pipeline <name> --base-url <url>   # Override baseURL
npx argo validate <name>                    # Dry run — checks scene name consistency
npx argo preview <name>                     # Interactive replay viewer (iterate without re-recording)
npx argo preview                            # Multi-demo dashboard (lists all demos with status)
npx argo clip <name> <scene>                # Extract a scene as MP4 clip
npx argo clip <name> <scene> --format gif   # Extract as GIF (for release notes, docs)
npx argo init                               # Scaffold example demo + config
npx argo init --from tests/spec.ts          # Convert existing Playwright test
```

**Individual steps** (for debugging):
```bash
npx argo tts generate demos/<name>.scenes.json   # Step 1: TTS (takes FILE PATH, not bare name)
npx argo record <name>                            # Step 2: Record (takes bare name)
npx argo export <name>                            # Step 3+4: Align + Export (takes bare name)
```

Pipeline order is **TTS -> Record -> Align -> Export** — TTS runs first so `durationFor()` has clip lengths during recording.

### Scene Transitions, Speed Ramp & Multi-Format Export

Configure in `argo.config.mjs` under `export`:

```javascript
export: {
  preset: 'slow',
  crf: 16,
  transition: { type: 'fade-through-black', durationMs: 2000 },  // scene transitions
  speedRamp: { gapSpeed: 2.0, minGapMs: 500 },                   // speed up gaps between scenes
  audio: {
    loudnorm: true,                                                // EBU R128 loudness normalization
    music: 'assets/bg-music.mp3',                                  // background music track
    musicVolume: 0.15,                                             // music volume (0.0-1.0)
  },
  watermark: {                                                     // brand bug overlay
    src: 'assets/logo.png',
    position: 'bottom-right',
    opacity: 0.16,
  },
  formats: ['gif', '9:16', '1:1'],                                // additional export formats
  variants: [                                                       // viewport-native re-recording
    { name: 'vertical', video: { width: 1080, height: 1920 } },
    { name: 'square',   video: { width: 1080, height: 1080 } },
  ],
}
```

- **Transitions:** `fade-through-black` | `dissolve` | `wipe-left` | `wipe-right` — applied at scene boundaries during export. `dissolve` is a quicker dip-to-black (not a true crossfade blend). Use `durationMs: 2000` or higher for transitions that are clearly visible with voiceover (500ms is too fast to notice). Content changes (page navigation, slide switches) should happen BEFORE `narration.mark()` so the transition fades between old and new content.
- **Speed ramp:** Compresses inter-scene gaps (navigation, page loads) to keep demos tight. `gapSpeed: 2.0` = 2× speed for gaps. Only gaps > `minGapMs` (default 500ms) are affected.
- **Formats:** `1:1` (square), `9:16` (vertical), `gif` (palette-optimized animated GIF). Both `1:1` and `9:16` use **blur-fill** — the source is scaled to fit, overlaid on a blurred version of itself. No more hard crop clipping.
- **Audio:** `audio: { loudnorm: true }` applies EBU R128 loudness normalization (-16 LUFS). Makes voiceover consistent across engines and scenes.
- **Variants:** Re-record at different viewports for pixel-perfect multi-format. TTS runs once, then pipeline records + exports per variant. Output: `videos/<demo>-<variant>.mp4`. Much better than blur-fill for responsive content.
- **Background music:** `audio.music` loops a track under narration at `musicVolume`, with 2-second fade-out. Or generate music from a text prompt in preview (MusicGen + WebGPU).
- **Watermark:** `watermark: { src, position, opacity, margin }` overlays a PNG at any corner. Applied as the last video filter.
- **Progress bar:** Export shows encoding progress automatically when duration is known

### Freeze-Frame Holds

Hold a specific frame for dramatic effect — add `post` array to scene entries in `.scenes.json`:

```json
{
  "scene": "cta",
  "post": [{ "type": "freeze", "atMs": 1800, "durationMs": 1200 }]
}
```

`atMs` is relative to scene start. Timeline (chapters, subtitles) adjusts for inserted duration. Applied before transitions.

### AI Music Generation (Preview)

Generate background music from text prompts directly in `argo preview`:

1. Open the "Background Music" panel in the sidebar
2. Type a prompt or click a preset (lofi chill, corporate upbeat, ambient minimal, cinematic epic, acoustic warm)
3. Click "Generate Music" — MusicGen runs in-browser via WebGPU
4. Audition the clip, then "Use as BGM" to save
5. Click Export — music is mixed under narration automatically

Model (~450MB q4) downloads on first use, cached in browser. No API keys needed.

### Post-Export Camera Moves

`zoomTo` with `narration` option records zoom effects during Playwright recording, then applies them as ffmpeg `zoompan` filters during export. Frame-exact, overlay-safe — no DOM manipulation.

```ts
zoomTo(page, '#code-block', {
  narration,           // pass the narration fixture
  scale: 1.35,         // 135% zoom
  duration: 5000,      // total effect duration
  fadeIn: 1000,        // zoom-in ramp
  holdMs: 3000,        // hold at max zoom
});
```

Camera moves are written to `.timing.camera-moves.json`, shifted for head trim, scaled for deviceScaleFactor, and applied after transitions in the filter graph. Works across pipeline, standalone `argo export`, and preview Export button. Without `narration` option, falls back to browser-side CSS transform (for VS Code preview).

### VS Code Playwright Integration

Argo demos are standard Playwright tests — they show up in VS Code's Playwright test panel automatically. Click play to run a demo directly from the editor:

- Overlays resolve automatically (fixture auto-discovers `demos/<name>.scenes.json`)
- Camera effects, confetti, cursor highlight all work
- Timing uses fallback defaults (3000ms per scene) — for exact TTS timing, run `argo pipeline` first

**Workflow:** Write → click play in VS Code to preview → run `argo pipeline` for the final video.

### Preview Iteration Workflow

Run `argo pipeline` once, then `argo preview` to iterate on voiceover and overlays without re-recording. Preview provides editable text/voice/speed per scene, per-scene TTS regeneration, overlay editing, and a Save button that persists to manifests. Only re-run `pipeline` when the demo script changes.

### `about:blank` + `setContent()` Pattern

For demos without a live app (slideshows, product screenshots):

```typescript
await page.goto('about:blank');
await page.setContent('<div style="...">Your content here</div>');
narration.mark('intro');
```

This is a supported pattern for marketing/product videos that don't need a running web server.

---

## Gotchas

These are the failure modes that come up repeatedly:

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No timing file found" | Import `test` from `@playwright/test` | Change import to `@argo-video/cli` |
| `tts generate` fails silently | Passed bare name instead of file path | Use `demos/<name>.scenes.json`, not just `<name>` |
| Stale voiceover audio | TTS cache not cleared after text edit | `rm -rf .argo/<demo>/clips` |
| Scene names not matching | Case-sensitive mismatch between manifest and `mark()` | Scene names are exact strings — check spelling/case |
| Timeout during recording | Demo exceeds Playwright 30s default | Add `test.setTimeout(90000)` at test start |
| Soft/blurry video on macOS | Using chromium (known capture issue) | Switch to `--browser webkit` |
| `deviceScaleFactor: 2` broken with webkit | Known bug — viewport renders at 1/4 | Stick to `deviceScaleFactor: 1` until fixed |
| ESM warnings from config | Config file is `.js` in non-module project | Rename to `argo.config.mjs` |
| Overlays scale weirdly | Legacy `zoomTo` (without `narration`) transforms DOM | Use `zoomTo(page, target, { narration })` for overlay-safe post-export zoom |
| App looks wrong in recording | App uses system dark/light mode | Use `page.emulateMedia({ colorScheme: 'dark' })` — see `references/config-and-quality.md` |
| Gray bar at bottom of video | Used `--headed` on macOS | Re-run without `--headed`; browser chrome reduces viewport in headed mode. Headless (default) is correct. |

---

## Reference Files

Read these when you need deeper guidance on specific topics:

- **`references/tts-engines.md`** — Engine selection, voice cloning, phonetic spelling per engine, cloud API keys
- **`references/config-and-quality.md`** — Full config options, dark mode recording, Playwright tricks for demos, 4K export, browser quality
- **`references/init-from-conversion.md`** — Converting Playwright tests, post-conversion LLM workflow, scene detection heuristics
- **`examples/basic.demo.ts`** — Complete working demo script template
- **`examples/basic.scenes.json`** — Matching scenes manifest template

## Related Skills

For advanced Playwright automation patterns beyond what's covered here, invoke the `playwright-cli` skill if available.
