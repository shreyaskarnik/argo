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

- **TTS** (`src/tts/`): Generates voice clips from `.scenes.json` manifests. Pluggable engine system with 7 built-in adapters in `src/tts/engines/`: Kokoro (default), OpenAI, ElevenLabs, Gemini, Sarvam, mlx-audio, Transformers (generic HuggingFace pipeline). Selected via `engines.*` factory functions in config. Cloud engines lazy-load their SDKs. All audio normalized to mono Float32 24kHz WAV via `convertToWav()` (ffmpeg). Clips are content-addressed cached (SHA256 of scene+text+voice+speed+lang) in `.argo/<demo>/clips/`. Cloud engine API keys are validated lazily at `generate()` time, not constructor — so non-TTS commands like `argo validate` work without keys. Kokoro's ONNX runtime is not safe for concurrent `generate()` calls — clips generate sequentially despite shared init promise.
- **Record** (`src/record.ts`): Runs Playwright demo script, captures video (WebM) and timing marks (`.timing.json`). Generates a dynamic Playwright config on-the-fly.
- **Align** (`src/tts/align.ts`): Places audio clips at scene timestamps from timing data. Prevents overlap with 100ms gaps. Mixes into single WAV (Float32, 24kHz).
- **Export** (`src/export.ts`): Merges video + aligned audio via ffmpeg into final MP4. Supports optional MP4 thumbnail embedding via `export.thumbnailPath` config (ffmpeg attached_pic stream). CRITICAL: `-shortest` must be skipped when thumbnail is present — PNG has 0 duration and truncates the entire output. Embeds chapter markers from scene placements via ffmpeg metadata. Input indices are dynamic based on presence of chapters/thumbnail. Silent mode: when no `narration-aligned.wav` exists, exports video-only (no audio input, no `-c:a`, no `-shortest`). Shows a progress bar during encoding when total duration is known (uses ffmpeg's `-progress pipe:1`). Supports multi-format export: `1:1` (square crop), `9:16` (vertical crop), and `gif` (two-pass palette-optimized animated GIF).
- **Transitions** (`src/transitions.ts`): Scene transitions at scene boundaries. Uses `filter_complex` with `split` → `trim` → `fade` → `concat` for fade-through-black and dissolve (the only approach that supports multiple boundaries — ffmpeg's `fade` filter only works once per stream). Types: `fade-through-black` (full black dip), `dissolve` (shorter dip-to-black, not a true crossfade), `wipe-left`/`wipe-right` (directional drawbox mask). Fade-out ends one frame before the cut (fps-aware) to prevent keyframe flash. Content changes must happen BEFORE `narration.mark()` so the transition fades between old and new content. Use `durationMs: 2000`+ for visible transitions (500ms is too fast). Configured via `export.transition` in config.
- **Speed Ramp** (`src/speed-ramp.ts`): Timeline-first speed ramp — planned before export so chapters, subtitles, and extra formats reflect ramped timing. Configured via `export.speedRamp: { gapSpeed, minGapMs }`. Uses `setpts` (video) and `atempo` (audio) filters.
- **Progress** (`src/progress.ts`): Wraps ffmpeg execution with `-progress pipe:1` to parse `out_time_us` and render a terminal progress bar showing encoding percentage. Used by the pipeline when `totalDurationMs` is known.
- **Subtitles** (`src/subtitles.ts`): Generates `.srt` and `.vtt` files from alignment placements + scenes manifest text. Best-effort — won't fail the pipeline.
- **Chapters** (`src/chapters.ts`): Generates ffmpeg metadata format (`TIMEBASE=1/1000`) for MP4 chapter markers from scene placements.
- **Report** (`src/report.ts`): Builds scene timing report (JSON + formatted console output) with per-scene durations, overflow, and output path.

Pipeline orchestration: `src/pipeline.ts` → CLI entry: `src/cli.ts` (Commander.js)

### Overlays (`src/overlays/`)

Injected into the browser during recording via `page.evaluate()`. Uses a zone-based positioning system (6 fixed positions) with template rendering (lower-third, headline-card, callout, image-card) and CSS motion presets (fade-in, slide-in).

Overlay cues use discriminated unions — each template type has its own TypeScript type with `type` as the discriminant field. `showOverlay`/`withOverlay` resolve overlay content from the `.scenes.json` manifest at runtime via `ARGO_OVERLAYS_PATH` env var. Demo scripts only provide duration/action — overlay content lives in the manifest. Full inline cues are still supported for backward compatibility.

### Effects (`src/effects.ts`)

`showConfetti(page, opts?)` — non-blocking by default (fire-and-forget safe). Injects a canvas-based confetti animation via `page.evaluate()`. Two spread modes: `burst` (Raycast-style, center-top fan) and `rain` (full-width fall). `emoji: '🎃'` or `emoji: ['🎄', '⭐']` renders emoji characters instead of colored rectangles. Set `wait: true` to block until animation completes. Errors from page/context disposal are swallowed; all other errors surface as warnings.

### Camera (`src/camera.ts`)

Four directed recording effects: `spotlight`, `focusRing`, `dimAround`, `zoomTo`, plus `resetCamera`. All accept CSS selector strings or Playwright Locators (resolved via `boundingBox()` before `page.evaluate()`). When a Locator is passed to `dimAround`, it falls back to a spotlight-style clip-path dim. All non-blocking by default (fire-and-forget safe). `zoomTo` uses `transform-origin: 0 0` + `scale() translate()` on `documentElement` to zoom and reframe the viewport onto the target. Note: overlays active during zoom will scale with the page (they're children of `documentElement`). Error handling follows the same pattern as `showConfetti` (filter by disposal errors, warn on others).

### Cursor Highlight (`src/cursor.ts`)

`cursorHighlight(page, opts?)` — persistent cursor highlight that follows the mouse pointer during recording. Injects a styled ring via `page.evaluate()` with optional pulse animation and click ripple effects. Stays active until `resetCursor(page)` is called. Error handling follows the same pattern as `showConfetti` (filter by disposal errors, warn on others). Options: `color` (default `#3b82f6`), `radius` (default 20px), `pulse` (default true), `clickRipple` (default true), `opacity` (default 0.5).

### Playwright Integration (`src/fixtures.ts`)

Custom `test` fixture extends Playwright's `test` with a `narration` fixture that records `Date.now()` timestamps for each `mark()` call, flushed to `.timing.json` after test completion.

## Argo Pipeline

- Order: TTS → Record → Align → Export → (optional: Speed Ramp) (not Record first)
- `argo tts generate` takes a file path (`demos/name.scenes.json`), not a bare demo name
- `argo record/export/pipeline/validate` take bare demo names (e.g., `argo pipeline example`)
- `argo pipeline --all` runs the full pipeline for every demo discovered in `demosDir` (finds all `.scenes.json` files)
- `argo pipeline [demo]` — demo argument is optional when `--all` is used
- `argo validate <demo>` checks scene name consistency between script and scenes manifest, validates overlay fields (no TTS/recording)
- `argo clip <demo> <scene>` extracts a scene clip from an exported MP4 using chapter markers. `--format gif` produces a palette-optimized GIF. Clips go to `videos/clips/`. Useful for release notes and docs.
- `--base-url <url>` flag on `record` and `pipeline` overrides `config.baseURL`
- `--headed` flag on `record` and `pipeline` runs the browser in visible mode
- `--all` flag on `pipeline` runs all demos in batch (sequential execution, continues on failure)
- `argo init --from <test.spec.ts>` converts existing Playwright tests into Argo demos (parses scene boundaries from `test.step()`, `page.goto()`, comments, and action clusters)
- README config/CLI/API snippets must stay in sync with code changes (check after modifying config schema, CLI options, or scaffold templates)
- Demo names are validated at the CLI boundary: only `[a-zA-Z0-9][a-zA-Z0-9_-]*` allowed. This prevents path traversal — maintain this validation if adding new commands that accept demo names.
- `tts generate` derives demoName via `basename()` from the manifest path (strips `.scenes.json` suffix) — do not use `/`-only regex (breaks on Windows paths)
- Pipeline writes `<demo>.meta.json` alongside the video with TTS engine, voices, resolution, and export settings for provenance tracking

## Demo Authoring

- Demo scripts: `demos/<name>.demo.ts`
- Scenes manifest: `demos/<name>.scenes.json` (unified voiceover + overlay data per scene)
- The `effects` array in scenes.json is preview-UI metadata only — it does NOT auto-inject during recording. Effects require explicit script-side calls (`showConfetti()`, `spotlight()`, etc.)
- TTS engine: Kokoro (local, no API keys). Voices: `af_heart` (female default), `am_michael` (male)
- OpenAI engine supports `instructions` option for system-prompt-capable models like `gpt-4o-mini-tts`: `engines.openai({ model: 'gpt-4o-mini-tts', instructions: '...' })`
- Transformers.js engine works with any HuggingFace `text-to-speech` model: `engines.transformers({ model: 'onnx-community/Supertonic-TTS-ONNX' })`. Speaker embeddings map to the `voice` field per scene. Models outputting non-24kHz audio are automatically resampled.
- Transformers engine voice field: only URL/file-path values are used as speaker embeddings. Engine-specific names like `af_heart` (Kokoro) are gracefully ignored with a warning — no crash.
- Transformers engine dtype: defaults to `q8` (quantized). Models that only ship fp32 weights (e.g., Supertonic) need `dtype: 'fp32'`. The error message now suggests this fix.
- Transformers engine `lang` option: models like Supertonic-TTS-2 require language tags (`<en>text</en>`) or they produce garbled audio. Set `lang: 'en'` in engine config. Per-scene `lang` field in manifest overrides this.
- Long voiceover text is automatically chunked at sentence boundaries (80-500 chars) with 300ms silence gaps for Kokoro and Transformers engines. Shared utilities: `splitTextForTTS()` and `concatSamples()` in `src/tts/engine.ts`.
- Long demos need `test.setTimeout()` — Playwright default is 30s
- Showcase demo (`demos/showcase.demo.ts`) requires a local HTTP server serving `demos/`: `python3 -m http.server 8976 --directory demos` then `BASE_URL=http://127.0.0.1:8976 npx tsx bin/argo.js pipeline showcase --browser webkit`
- Browser default is `chromium`. Video quality ranking on macOS: **webkit > firefox > chromium**. Chromium has a known video capture quality issue (see [playwright#31424](https://github.com/microsoft/playwright/issues/31424)). Use `--browser webkit` for best results.
- `deviceScaleFactor: 2` captures at 2x resolution; export downscales with lanczos. Value is rounded to integer (min 1).
- Mobile demos: set `isMobile: true`, `hasTouch: true` in `video` config. These are passed through to the generated Playwright config. `contextOptions` also flows through (for `colorScheme`, `locale`, `geolocation`, `permissions`, etc.).
- `--headed` on macOS shows a gray bar at bottom of video — browser chrome reduces viewport. Use headless (default) for final recordings.
- Voiceover `text` is spoken only, never displayed — spell words phonetically to fix TTS pronunciation (e.g., `"sass"` for SaaS, `"A P I"` for API, `"cube control"` for kubectl). Overlay text is what viewers see. Phonetics differ per engine: Kokoro needs `tee tee ess` / `A.I.` / `M.L.X.`, OpenAI handles acronyms natively. When switching engines, update voiceover text.
- Voice cloning: mlx-audio engine supports `refAudio` + `refText` options for cloning from a 15s reference clip. Qwen3-TTS produces best clone quality (CSM is lower). Scripts: `scripts/record-voice-ref.sh` (macOS mic recording), `scripts/voice-clone-preview.sh` (batch preview with manifest).
- Effect timing pattern: derive beat durations from `durationFor()` minus setup wait, divided by effect count: `const totalMs = narration.durationFor('scene') - setupWaitMs; const beat = Math.floor(totalMs / numberOfEffects);` This keeps camera effects synchronized with voiceover. Hardcoded durations drift.
- When using scene transitions, content changes (page navigation, slide switches) must happen BEFORE `narration.mark()` so the transition fades between old and new content. If content changes after mark(), the transition just pulses the same visual.
- Avoid `test.beforeEach` in demo scripts — it gets recorded into the video. Put setup before the first `narration.mark()` instead.
- Silent demos: omit `text` from scenes manifest entries — TTS is skipped, pipeline exports video-only with no audio track. Useful for quick prototype demos with just overlays and camera effects.
- Auto-trim: pipeline trims video before the first `narration.mark()` (~200ms lead-in) and persists `headTrimMs` in `.meta.json`. Setup code (login, navigation, `beforeEach`) is automatically cut from the final MP4.

## Scene Durations & Dynamic Timing

- `narration.durationFor(scene, opts?)` computes wait times from TTS clip lengths (replaces hardcoded ms values in demo scripts)
- Pipeline writes `.scene-durations.json` after TTS → env var `ARGO_SCENE_DURATIONS_PATH` passes it to Playwright subprocess → fixture loads into `NarrationTimeline`
- Formula: `clipMs * multiplier + leadInMs + leadOutMs`, clamped to [minMs, maxMs] (defaults: 200ms lead-in, 400ms lead-out, 2200–8000ms range, 3000ms fallback)

## Env Vars Bridging Config to Playwright

- `ARGO_SCENE_DURATIONS_PATH` — path to `.scene-durations.json` (loaded by narration fixture)
- `ARGO_OVERLAYS_PATH` — path to `.scenes.json` manifest (loaded by overlay functions for manifest-based resolution)
- `ARGO_AUTO_BACKGROUND` — set to `'1'` when config `overlays.autoBackground` is true
- `ARGO_OUTPUT_DIR` — output directory for timing JSON
- `DEBUG` — when set (e.g., `DEBUG=pw:api`), Playwright debug output is forwarded to stderr even on success

## autoBackground Detection

- Uses `elementsFromPoint()` at zone coordinates, skipping `position: fixed/sticky` elements (e.g., navbars)
- Dark background → light overlay theme; light background → dark overlay theme
- Enable per-cue (`autoBackground: true` on overlay in `.scenes.json`) or globally via `overlays.autoBackground` in config

## Dashboard (`src/dashboard.ts`)

- `argo preview` (no args) starts a multi-demo dashboard server listing all discovered demos
- Shows per-demo status: script exists, manifest exists, video exported, metadata available
- Displays video size, last modified date, resolution, and browser from `.meta.json`
- System dark/light mode via `prefers-color-scheme` CSS media query
- `discoverDemos(demosDir)` finds all `.scenes.json` files and returns sorted demo names

## Preview Server (`src/preview.ts`)

- `argo preview <demo>` starts a local server (does not open browser) — user opens the printed URL
- Prefers exported MP4 over raw WebM for video seeking (WebM from Playwright lacks cue points)
- Serves video with HTTP Range requests (required for browser seeking)
- Overlay edits update the preview layer live but do NOT write to disk until Save is clicked
- Scene cards are collapsible; active scene auto-expands during playback (respects manual collapse)
- `<demo>.meta.json` displayed in the Metadata sidebar tab when available
- IMPORTANT: `bin/argo.js` loads from `dist/`, not source — always run `npm run build` before restarting the preview server after code changes
- The preview HTML/CSS/JS is a single inline template string in `src/preview.ts` (~1600 lines) — `wireOverlayListeners` must be called AFTER `sceneList.appendChild(card)` or DOM queries fail silently
- Export button re-aligns audio + generates chapters/subtitles + exports MP4 without re-recording (for TTS-only changes)
- Re-record and Export both update the served video path so the new MP4 is served immediately without restarting
- Preview reads `headTrimMs` from `.meta.json` to shift timeline — only shifts when metadata confirms trimming was applied (standalone `argo export` produces untrimmed video)
- Preview UI follows system light/dark mode via `prefers-color-scheme` CSS media query

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
- Skill uses progressive disclosure: core SKILL.md (~200 lines) + reference files in `references/` loaded on demand + example templates in `examples/`
- Cross-client discovery: `.agents/skills/argo-guide` symlink follows the Agent Skills spec so non-Claude LLM clients auto-discover the skill

## Known Issues

- ~~`demoType` selector gotcha~~ — FIXED: `demoType(page, selectorOrLocator, text)` now accepts a CSS selector string or a Playwright Locator directly.
- `deviceScaleFactor > 1` is broken with webkit — viewport renders at a fraction of the frame. Affects 2x and 3x equally. Stick to `deviceScaleFactor: 1` until fixed.
- ~~`argo init` ESM warnings~~ — FIXED: now scaffolds `argo.config.mjs` with `defineConfig()`.
- `zoomTo` transforms `documentElement` — overlays active during zoom will scale with the page. Avoid overlapping `withOverlay` and `zoomTo` on the same scene for best results.
- OpenAI engine requests raw PCM (`response_format: 'pcm'`) and converts to Float32 directly — do not use `convertToWav` (ffmpeg pipe introduces 0xFFFFFFFF data size artifacts).
- `convertToWav` (ffmpeg pipe to stdout) writes WAV with `0xFFFFFFFF` data size — `parseWavHeader` falls back to actual buffer length. All engines using `convertToWav` are affected.
- Showcase demo video hosted via GitHub gist comment upload: https://gist.github.com/shreyaskarnik/6a0996942a96528a984010f36de76079
- `tsc` build may silently fail if `tsconfig.json` is missing — verify it exists before trusting `npm run build` output
- `dissolve` transition is a shorter dip-to-black, not a true crossfade blend. A real crossfade would require ffmpeg `xfade` with re-encoded segment pairs — impractical for continuous recordings.
- `9:16` format export center-crops from 16:9 — wide text gets clipped. Works best when key content is centered.
- `speedRamp` + `transitions` cannot be used together — both generate filter_complex graphs with conflicting stream labels. Use one or the other.

## Security Invariants

- Demo names are validated at CLI entry (`src/cli.ts`): `[a-zA-Z0-9][a-zA-Z0-9_-]*` only. Always validate before `path.join()`.
- Overlay text is HTML-escaped via `escapeHtml()` in `src/overlays/templates.ts` before `innerHTML` injection. Never bypass.
- Subprocess calls use `execFile`/`spawnSync` with array args — never shell string interpolation.
- `showConfetti` catch block filters by error message — only swallows page disposal errors, surfaces everything else. Don't broaden.
- `loadConfig` validates the exported value is a plain object. Config files run with full Node.js privileges (same as Vite/Webpack).
