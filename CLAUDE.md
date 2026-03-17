# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About

Argo turns Playwright demo scripts into polished product demo videos with AI voiceover. Users write a Playwright test, add a scenes manifest (`.scenes.json`), and run `argo pipeline` to get an MP4 with screen recording, overlays, and narration — all locally, no cloud services required.

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

- `demos/` directory is no longer gitignored — demo source files are tracked normally
- `videos/` directory is also gitignored — use `git add -f videos/<file>` for tracked video artifacts
- GPG signing may fail in CLI environments — use `git -c commit.gpgsign=false commit` if needed

## Architecture

The system is a 4-step pipeline: **TTS → Record → Align → Export**

- **TTS** (`src/tts/`): Generates voice clips from `.scenes.json` manifests. Pluggable engine system with 6 built-in adapters in `src/tts/engines/`: Kokoro (default), OpenAI, ElevenLabs, Gemini, Sarvam, mlx-audio. Selected via `engines.*` factory functions in config. Cloud engines lazy-load their SDKs. All audio normalized to mono Float32 24kHz WAV via `convertToWav()` (ffmpeg). Clips are content-addressed cached (SHA256 of scene+text+voice+speed+lang) in `.argo/<demo>/clips/`. Cloud engine API keys are validated lazily at `generate()` time, not constructor — so non-TTS commands like `argo validate` work without keys. Kokoro's ONNX runtime is not safe for concurrent `generate()` calls — clips generate sequentially despite shared init promise.
- **Record** (`src/record.ts`): Runs Playwright demo script, captures video (WebM) and timing marks (`.timing.json`). Generates a dynamic Playwright config on-the-fly.
- **Align** (`src/tts/align.ts`): Places audio clips at scene timestamps from timing data. Prevents overlap with 100ms gaps. Mixes into single WAV (Float32, 24kHz).
- **Export** (`src/export.ts`): Merges video + aligned audio via ffmpeg into final MP4. Supports optional MP4 thumbnail embedding via `export.thumbnailPath` config (ffmpeg attached_pic stream). CRITICAL: `-shortest` must be skipped when thumbnail is present — PNG has 0 duration and truncates the entire output. Embeds chapter markers from scene placements via ffmpeg metadata. Input indices are dynamic based on presence of chapters/thumbnail.
- **Subtitles** (`src/subtitles.ts`): Generates `.srt` and `.vtt` files from alignment placements + scenes manifest text. Best-effort — won't fail the pipeline.
- **Chapters** (`src/chapters.ts`): Generates ffmpeg metadata format (`TIMEBASE=1/1000`) for MP4 chapter markers from scene placements.
- **Report** (`src/report.ts`): Builds scene timing report (JSON + formatted console output) with per-scene durations, overflow, and output path.

Pipeline orchestration: `src/pipeline.ts` → CLI entry: `src/cli.ts` (Commander.js)

### Overlays (`src/overlays/`)

Injected into the browser during recording via `page.evaluate()`. Uses a zone-based positioning system (6 fixed positions) with template rendering (lower-third, headline-card, callout, image-card) and CSS motion presets (fade-in, slide-in).

Overlay cues use discriminated unions — each template type has its own TypeScript type with `type` as the discriminant field. `showOverlay`/`withOverlay` resolve overlay content from the `.scenes.json` manifest at runtime via `ARGO_OVERLAYS_PATH` env var. Demo scripts only provide duration/action — overlay content lives in the manifest. Full inline cues are still supported for backward compatibility.

### Effects (`src/effects.ts`)

`showConfetti(page, opts?)` — non-blocking by default (fire-and-forget safe). Injects a canvas-based confetti animation via `page.evaluate()`. Two spread modes: `burst` (Raycast-style, center-top fan) and `rain` (full-width fall). Set `wait: true` to block until animation completes. Errors from page/context disposal are swallowed; all other errors surface as warnings.

### Camera (`src/camera.ts`)

Four directed recording effects: `spotlight`, `focusRing`, `dimAround`, `zoomTo`, plus `resetCamera`. All non-blocking by default (fire-and-forget safe). `zoomTo` uses `transform-origin: 0 0` + `scale() translate()` on `documentElement` to zoom and reframe the viewport onto the target. Note: overlays active during zoom will scale with the page (they're children of `documentElement`). Error handling follows the same pattern as `showConfetti` (filter by disposal errors, warn on others).

### Playwright Integration (`src/fixtures.ts`)

Custom `test` fixture extends Playwright's `test` with a `narration` fixture that records `Date.now()` timestamps for each `mark()` call, flushed to `.timing.json` after test completion.

## Argo Pipeline

- Order: TTS → Record → Align → Export (not Record first)
- `argo tts generate` takes a file path (`demos/name.scenes.json`), not a bare demo name
- `argo record/export/pipeline/validate` take bare demo names (e.g., `argo pipeline example`)
- `argo validate <demo>` checks scene name consistency between script and scenes manifest, validates overlay fields (no TTS/recording)
- `--base-url <url>` flag on `record` and `pipeline` overrides `config.baseURL`
- `--headed` flag on `record` and `pipeline` runs the browser in visible mode
- `argo init --from <test.spec.ts>` converts existing Playwright tests into Argo demos (parses scene boundaries from `test.step()`, `page.goto()`, comments, and action clusters)
- README config/CLI/API snippets must stay in sync with code changes (check after modifying config schema, CLI options, or scaffold templates)
- Demo names are validated at the CLI boundary: only `[a-zA-Z0-9][a-zA-Z0-9_-]*` allowed. This prevents path traversal — maintain this validation if adding new commands that accept demo names.
- `tts generate` derives demoName via `basename()` from the manifest path (strips `.scenes.json` suffix) — do not use `/`-only regex (breaks on Windows paths)
- Pipeline writes `<demo>.meta.json` alongside the video with TTS engine, voices, resolution, and export settings for provenance tracking

## Demo Authoring

- Demo scripts: `demos/<name>.demo.ts`
- Scenes manifest: `demos/<name>.scenes.json` (unified voiceover + overlay data per scene)
- TTS engine: Kokoro (local, no API keys). Voices: `af_heart` (female default), `am_michael` (male)
- OpenAI engine supports `instructions` option for system-prompt-capable models like `gpt-4o-mini-tts`: `engines.openai({ model: 'gpt-4o-mini-tts', instructions: '...' })`
- Long demos need `test.setTimeout()` — Playwright default is 30s
- Showcase demo (`demos/showcase.demo.ts`) requires a local HTTP server serving `demos/`: `python3 -m http.server 8976 --directory demos` then `BASE_URL=http://127.0.0.1:8976 npx tsx bin/argo.js pipeline showcase --browser webkit`
- Browser default is `chromium`. Video quality ranking on macOS: **webkit > firefox > chromium**. Chromium has a known video capture quality issue (see [playwright#31424](https://github.com/microsoft/playwright/issues/31424)). Use `--browser webkit` for best results.
- `deviceScaleFactor: 2` captures at 2x resolution; export downscales with lanczos. Value is rounded to integer (min 1).
- Voiceover `text` is spoken only, never displayed — spell words phonetically to fix TTS pronunciation (e.g., `"sass"` for SaaS, `"A P I"` for API, `"cube control"` for kubectl). Overlay text is what viewers see. Phonetics differ per engine: Kokoro needs `tee tee ess` / `A.I.` / `M.L.X.`, OpenAI handles acronyms natively. When switching engines, update voiceover text.
- Voice cloning: mlx-audio engine supports `refAudio` + `refText` options for cloning from a 15s reference clip. Qwen3-TTS produces best clone quality (CSM is lower). Scripts: `scripts/record-voice-ref.sh` (macOS mic recording), `scripts/voice-clone-preview.sh` (batch preview with manifest).
- Camera effect durations should derive from `narration.durationFor()` (e.g., `Math.floor(durationFor('scene') / N)`) so effects track voiceover timing.
- Avoid `test.beforeEach` in demo scripts — it gets recorded into the video. Put setup before the first `narration.mark()` instead.

## Scene Durations & Dynamic Timing

- `narration.durationFor(scene, opts?)` computes wait times from TTS clip lengths (replaces hardcoded ms values in demo scripts)
- Pipeline writes `.scene-durations.json` after TTS → env var `ARGO_SCENE_DURATIONS_PATH` passes it to Playwright subprocess → fixture loads into `NarrationTimeline`
- Formula: `clipMs * multiplier + leadInMs + leadOutMs`, clamped to [minMs, maxMs] (defaults: 200ms lead-in, 400ms lead-out, 2200–8000ms range, 3000ms fallback)

## Env Vars Bridging Config to Playwright

- `ARGO_SCENE_DURATIONS_PATH` — path to `.scene-durations.json` (loaded by narration fixture)
- `ARGO_OVERLAYS_PATH` — path to `.scenes.json` manifest (loaded by overlay functions for manifest-based resolution)
- `ARGO_AUTO_BACKGROUND` — set to `'1'` when config `overlays.autoBackground` is true
- `ARGO_OUTPUT_DIR` — output directory for timing JSON

## autoBackground Detection

- Uses `elementsFromPoint()` at zone coordinates, skipping `position: fixed/sticky` elements (e.g., navbars)
- Dark background → light overlay theme; light background → dark overlay theme
- Enable per-cue (`autoBackground: true` on overlay in `.scenes.json`) or globally via `overlays.autoBackground` in config

## Preview Server (`src/preview.ts`)

- `argo preview <demo>` starts a local server (does not open browser) — user opens the printed URL
- Prefers exported MP4 over raw WebM for video seeking (WebM from Playwright lacks cue points)
- Serves video with HTTP Range requests (required for browser seeking)
- Overlay edits update the preview layer live but do NOT write to disk until Save is clicked
- Scene cards are collapsible; active scene auto-expands during playback (respects manual collapse)
- `<demo>.meta.json` displayed in the Metadata sidebar tab when available
- IMPORTANT: `bin/argo.js` loads from `dist/`, not source — always run `npm run build` before restarting the preview server after code changes
- The preview HTML/CSS/JS is a single inline template string in `src/preview.ts` (~1600 lines) — `wireOverlayListeners` must be called AFTER `sceneList.appendChild(card)` or DOM queries fail silently

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
- Cross-client discovery: `.agents/skills/argo-guide` symlink follows the Agent Skills spec so non-Claude LLM clients auto-discover the skill

## Known Issues

- ~~`demoType` selector gotcha~~ — FIXED: `demoType(page, selectorOrLocator, text)` now accepts a CSS selector string or a Playwright Locator directly.
- `deviceScaleFactor: 2` is broken with webkit — viewport renders at 1/4 of the frame. Stick to `deviceScaleFactor: 1` until fixed.
- ~~`argo init` ESM warnings~~ — FIXED: now scaffolds `argo.config.mjs` with `defineConfig()`.
- `zoomTo` transforms `documentElement` — overlays active during zoom will scale with the page. Avoid overlapping `withOverlay` and `zoomTo` on the same scene for best results.
- OpenAI engine requests raw PCM (`response_format: 'pcm'`) and converts to Float32 directly — do not use `convertToWav` (ffmpeg pipe introduces 0xFFFFFFFF data size artifacts).
- `convertToWav` (ffmpeg pipe to stdout) writes WAV with `0xFFFFFFFF` data size — `parseWavHeader` falls back to actual buffer length. All engines using `convertToWav` are affected.
- Showcase demo video hosted via GitHub gist comment upload: https://gist.github.com/shreyaskarnik/6a0996942a96528a984010f36de76079
- `tsc` build may silently fail if `tsconfig.json` is missing — verify it exists before trusting `npm run build` output

## Security Invariants

- Demo names are validated at CLI entry (`src/cli.ts`): `[a-zA-Z0-9][a-zA-Z0-9_-]*` only. Always validate before `path.join()`.
- Overlay text is HTML-escaped via `escapeHtml()` in `src/overlays/templates.ts` before `innerHTML` injection. Never bypass.
- Subprocess calls use `execFile`/`spawnSync` with array args — never shell string interpolation.
- `showConfetti` catch block filters by error message — only swallows page disposal errors, surfaces everything else. Don't broaden.
- `loadConfig` validates the exported value is a plain object. Config files run with full Node.js privileges (same as Vite/Webpack).
