# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About

Argo turns Playwright demo scripts into polished product demo videos with AI voiceover. Users write a Playwright test, add a voiceover JSON manifest, and run `argo pipeline` to get an MP4 with screen recording, overlays, and narration — all locally, no cloud services required.

## Build & Test

- `npm run build` — TypeScript compilation (strict mode, ESM, target ES2022)
- `npm test` — runs vitest (all unit + integration tests)
- `npx vitest run tests/path/to/test.ts` — run a single test file
- E2E tests require Playwright browsers: `npx playwright install chromium`
- No separate lint command currently configured
- Kokoro TTS defaults: model `onnx-community/Kokoro-82M-v1.0-ONNX`, dtype `q8`
- Clear TTS cache if voiceover text changes: `rm -rf .argo/<demo>/clips`

## Publishing

- Package: `@argo-video/cli` (npm org: `@argo-video`)
- Publishing is automated via GitHub Actions OIDC trusted publishing (no NPM_TOKEN needed)
- To release: bump version in package.json, tag, create GitHub release → workflow handles the rest
- IMPORTANT: The `exports` map in package.json must include a `"default"` condition alongside `"import"` — without it, consuming projects that lack `"type": "module"` fail with `No "exports" main defined`

## Git Conventions

- `demos/` directory is gitignored — use `git add -f demos/<file>` for demo source files
- `videos/` directory is also gitignored — use `git add -f videos/<file>` for tracked video artifacts
- GPG signing may fail in CLI environments — use `git -c commit.gpgsign=false commit` if needed

## Architecture

The system is a 4-step pipeline: **TTS → Record → Align → Export**

- **TTS** (`src/tts/`): Generates voice clips from JSON manifests using Kokoro TTS. Clips are content-addressed cached (SHA256 of scene+text+voice+speed) in `.argo/<demo>/clips/`.
- **Record** (`src/record.ts`): Runs Playwright demo script, captures video (WebM) and timing marks (`.timing.json`). Generates a dynamic Playwright config on-the-fly.
- **Align** (`src/tts/align.ts`): Places audio clips at scene timestamps from timing data. Prevents overlap with 100ms gaps. Mixes into single WAV (Float32, 24kHz).
- **Export** (`src/export.ts`): Merges video + aligned audio via ffmpeg into final MP4. Supports optional MP4 thumbnail embedding via `export.thumbnailPath` config (ffmpeg attached_pic stream). CRITICAL: `-shortest` must be skipped when thumbnail is present — PNG has 0 duration and truncates the entire output.

Pipeline orchestration: `src/pipeline.ts` → CLI entry: `src/cli.ts` (Commander.js)

### Overlays (`src/overlays/`)

Injected into the browser during recording via `page.evaluate()`. Uses a zone-based positioning system (6 fixed positions) with template rendering (lower-third, headline-card, callout, image-card) and CSS motion presets (fade-in, slide-in).

Overlay cues use discriminated unions — each template type has its own TypeScript type with `type` as the discriminant field.

### Playwright Integration (`src/fixtures.ts`)

Custom `test` fixture extends Playwright's `test` with a `narration` fixture that records `Date.now()` timestamps for each `mark()` call, flushed to `.timing.json` after test completion.

## Argo Pipeline

- Order: TTS → Record → Align → Export (not Record first)
- `argo tts generate` takes a file path (`demos/name.voiceover.json`), not a bare demo name
- `argo record/export/pipeline` take bare demo names (e.g., `argo pipeline example`)
- README config/CLI/API snippets must stay in sync with code changes (check after modifying config schema, CLI options, or scaffold templates)

## Demo Authoring

- Demo scripts: `demos/<name>.demo.ts`
- Voiceover manifests: `demos/<name>.voiceover.json`
- Overlay manifests: `demos/<name>.overlays.json`
- TTS engine: Kokoro (local, no API keys). Voices: `af_heart` (female default), `am_michael` (male)
- Long demos need `test.setTimeout()` — Playwright default is 30s
- Showcase demo (`demos/showcase.demo.ts`) requires a local HTTP server serving `demos/`: `python3 -m http.server 8976 --directory demos` then `BASE_URL=http://127.0.0.1:8976 npx tsx bin/argo.js pipeline showcase --browser webkit`
- Browser default is `chromium`. Video quality ranking on macOS: **webkit > firefox > chromium**. Chromium has a known video capture quality issue (see [playwright#31424](https://github.com/microsoft/playwright/issues/31424)). Use `--browser webkit` for best results.
- `deviceScaleFactor: 2` captures at 2x resolution; export downscales with lanczos. Value is rounded to integer (min 1).
- Voiceover `text` is spoken only, never displayed — spell words phonetically to fix TTS pronunciation (e.g., `"sass"` for SaaS, `"A P I"` for API, `"cube control"` for kubectl). Overlay text is what viewers see.

## Scene Durations & Dynamic Timing

- `narration.durationFor(scene, opts?)` computes wait times from TTS clip lengths (replaces hardcoded ms values in demo scripts)
- Pipeline writes `.scene-durations.json` after TTS → env var `ARGO_SCENE_DURATIONS_PATH` passes it to Playwright subprocess → fixture loads into `NarrationTimeline`
- Formula: `clipMs * multiplier + leadInMs + leadOutMs`, clamped to [minMs, maxMs] (defaults: 200ms lead-in, 400ms lead-out, 2200–8000ms range, 3000ms fallback)

## Env Vars Bridging Config to Playwright

- `ARGO_SCENE_DURATIONS_PATH` — path to `.scene-durations.json` (loaded by narration fixture)
- `ARGO_AUTO_BACKGROUND` — set to `'1'` when config `overlays.autoBackground` is true
- `ARGO_OUTPUT_DIR` — output directory for timing JSON

## autoBackground Detection

- Uses `elementsFromPoint()` at zone coordinates, skipping `position: fixed/sticky` elements (e.g., navbars)
- Dark background → light overlay theme; light background → dark overlay theme
- Enable per-cue (`autoBackground: true` on overlay options) or globally via `overlays.autoBackground` in config

## Thumbnail

- `export.thumbnailPath` in config points to a PNG embedded as MP4 cover art
- Generator script: `scripts/generate_logo_thumbnail.py` (requires Pillow)
- Source mark: `assets/logo-mark-source.png` — cropped ASCII art only (no text)
- Regenerate: `python3 scripts/generate_logo_thumbnail.py` → writes `assets/logo-thumb.png`

## LLM Skill

- Argo ships as a Claude Code plugin/skill at `skills/argo-guide/SKILL.md`
- Marketplace config: `.claude-plugin/marketplace.json`
- Install via: `/plugin marketplace add shreyaskarnik/argo`
- When modifying CLI commands, config schema, overlay API, or fixture exports, update the skill alongside README
