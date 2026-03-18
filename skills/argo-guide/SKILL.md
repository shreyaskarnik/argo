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
| `zoomTo(page, target, opts?)` | Scale viewport centered on target. Note: active overlays scale with the page. |
| `resetCamera(page)` | Clear all active camera effects |
| `showConfetti(page, opts?)` | Confetti burst. `spread: 'burst'` (center-top fan) or `'rain'` (full-width fall). `emoji: '🎃'` or `emoji: ['🎃', '👻']` renders emoji instead of colored rectangles. |
| `cursorHighlight(page, opts?)` | Persistent ring following cursor. Remove with `resetCursor(page)`. |

Derive camera durations from `narration.durationFor()` so effects track voiceover timing:
```typescript
const stepDur = Math.floor(narration.durationFor('feature') / 3);
spotlight(page, '#target', { duration: stepDur });
```

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

### Manifest vs Inline Overlays

Use **one or the other** per scene:
- **Manifest** (recommended): overlay object in `.scenes.json`. `showOverlay(page, scene, durationMs)` — no inline cue.
- **Inline**: `showOverlay(page, scene, cue, durationMs)` with explicit cue in the script. Use for camera effect coordination or conditional logic.

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
  formats: ['gif', '9:16', '1:1'],                                // additional export formats
}
```

- **Transitions:** `fade-through-black` | `dissolve` | `wipe-left` | `wipe-right` — applied at scene boundaries during export. Use `durationMs: 2000` or higher for transitions that are clearly visible with voiceover (500ms is too fast to notice).
- **Speed ramp:** Compresses inter-scene gaps (navigation, page loads) to keep demos tight. `gapSpeed: 2.0` = 2× speed for gaps. Only gaps > `minGapMs` (default 500ms) are affected.
- **Formats:** `1:1` (square center-crop), `9:16` (vertical center-crop), `gif` (palette-optimized animated GIF for docs/READMEs). Note: `9:16` center-crops from 16:9 — works best when key content is centered. Wide text may be clipped.
- **Progress bar:** Export shows encoding progress automatically when duration is known

### Preview Iteration Workflow

Run `argo pipeline` once, then `argo preview` to iterate on voiceover and overlays without re-recording. Preview provides editable text/voice/speed per scene, per-scene TTS regeneration, overlay editing, and a Save button that persists to manifests. Only re-run `pipeline` when the demo script changes.

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
| Overlays scale weirdly | `zoomTo` transforms documentElement | Avoid overlapping `withOverlay` and `zoomTo` on same scene |
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
