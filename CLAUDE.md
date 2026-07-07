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
- **Record** (`src/record.ts`): Runs Playwright demo script under `@playwright/test`. Recording itself is driven by `narration.startRecording(page)` inside the demo (`page.screencast.start` from Playwright 1.59), not by Playwright's auto `recordVideo`. The generated config sets `video: 'off'` and the screencast lands at `.argo/<demo>/video.webm` via `ARGO_SCREENCAST_PATH`. Critical: `trace: 'on'` and `screencast.start()` cannot coexist — both engines pin the page render at trace's snapshot resolution (800×450 on webkit, intermittent white frames on chromium), so the generated config keeps trace off. The `screencast.start()` call passes `onFrame` when either `ARGO_LIVE_FRAME_PATH` (preview live thumbnail) or `ARGO_THUMBS_DIR` (per-scene scrubber JPEGs) is set; `narration.mark()` flips a `_pendingThumbScene` flag that the next `onFrame` consumes to write `<thumbsDir>/<scene>.jpg`. Optional `video.showActions: true | { position, fontSize, duration }` calls `page.screencast.showActions()` immediately after `start()` to auto-annotate every Playwright interaction (clicks/fills) in the recording.
- **Align** (`src/tts/align.ts`): Places audio clips at scene timestamps from timing data. Prevents overlap with 100ms gaps. Mixes into single WAV (Float32, 24kHz).
- **Export** (`src/export.ts`): Merges video + aligned audio via ffmpeg into final MP4. Supports optional MP4 thumbnail embedding via `export.thumbnailPath` config (ffmpeg attached_pic stream). CRITICAL: `-shortest` must be skipped when thumbnail is present — PNG has 0 duration and truncates the entire output. Embeds chapter markers from scene placements via ffmpeg metadata. Input indices are dynamic based on presence of chapters/thumbnail. Silent mode: when no `narration-aligned.wav` exists, exports video-only (no audio input, no `-c:a`, no `-shortest`). Shows a progress bar during encoding when total duration is known (uses ffmpeg's `-progress pipe:1`). Supports multi-format export: `1:1` (square blur-fill), `9:16` (vertical blur-fill), and `gif` (two-pass palette-optimized animated GIF). Audio loudnorm: `export.audio.loudnorm` applies EBU R128 (-16 LUFS) via `-af loudnorm` or inside `filter_complex` when transitions are active. Viewport-native variants: `export.variants` re-records at different viewports (TTS shared, record+export per variant).
### Export Quality (`src/export.ts`, `src/gpu-encoder.ts`)

Every H.264 output is tagged BT.709 color space at container level (`-colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv`) and includes VUI metadata (`colorprim=bt709:transfer=bt709:colormatrix=bt709` inside `-x264-params`). Chrome screenshots output sRGB which maps to BT.709 — tagging prevents Safari/TV color shifts.

libx264 is tuned with `aq-mode=3:aq-strength=0.8:deblock=1,1` — redistributes bits to dark flat regions, kills gradient banding on dark-theme demos.

`scale=in_range=pc:out_range=tv` is appended to the video filter chain — converts Chrome's full-range RGB (0-255) to H.264 TV range (16-235). Prevents crushed blacks on standards-compliant players.

GPU encoder detection via `src/gpu-encoder.ts` probes `ffmpeg -encoders` at export time (cached per-process). Prefers NVENC > VideoToolbox > VAAPI > QSV > libx264. Per-encoder flags:
- NVENC: `-preset {preset} -cq {crf}`
- VideoToolbox: `-q:v {100 - crf*2} -allow_sw 1`
- VAAPI: `-qp {crf}` + `-vaapi_device /dev/dri/renderD128` + `format=nv12,hwupload` filter chain
- QSV: `-preset {preset} -global_quality {crf}`

Opt out via `ARGO_USE_GPU=0` for deterministic CI (libx264 fallback).

`-x264-params` does not apply when using a GPU encoder — container color tags cover those cases since GPU encoders don't have a `-x264-params` equivalent. Quality parity is close but not identical to libx264 at the same CRF — expected trade-off for the speedup.

A fixed 90 kHz timescale (`-video_track_timescale 90000`) is set on all outputs for consistent A/V timing across platforms.

Both the primary export path and blur-fill format variants (1:1, 9:16) are encoder-aware.

- **Transitions** (`src/transitions.ts`): Scene transitions at scene boundaries. Uses `filter_complex` with `split` → `trim` → `fade` → `concat` for fade-through-black and dissolve (the only approach that supports multiple boundaries — ffmpeg's `fade` filter only works once per stream). Types: `fade-through-black` (full black dip), `dissolve` (shorter dip-to-black, not a true crossfade), `wipe-left`/`wipe-right` (directional drawbox mask). Fade-out ends one frame before the cut (fps-aware) to prevent keyframe flash. Content changes must happen BEFORE `narration.mark()` so the transition fades between old and new content. Use `durationMs: 2000`+ for visible transitions (500ms is too fast). Configured via `export.transition` in config.

### Shader Transitions (`src/transitions/shader-render.ts`, `src/transitions/shader-splice.ts`)

Pre-rendered WebGL shader transitions. At export time, a pre-pass extracts two boundary frames per scene boundary (last frame of outgoing, first frame of incoming) via ffmpeg, then Playwright Chromium renders the GLSL shader at each of `N = D × fps` progress values, producing a PNG sequence. `buildShaderSpliceFilter` generates a filter_complex three-segment concat (`scene_a + PNG_seq + scene_b`) that replaces the fade window.

Cache key: `sha256(shader, durationMs, fps, width, height, sha256(aPng), sha256(bPng), accent)`. Cached at `.argo/<demo>/shaders/<hash>/`. Second export with unchanged boundaries hits cache with no browser launch.

Shaders live in `src/transitions/shaders/*.glsl`. Build step copies `.glsl` files to `dist/` (tsc does not). v1 ships: `crosswarp`, `swirl`, `ripple`, `luma-mask`, `light-leak` — adapted from gl-transitions.com (MIT), plus 11 hyperframes ports (Apache-2.0): `domain-warp`, `ridged-burn`, `thermal-distortion`, `swirl-vortex`, `whip-pan`, `gravitational-lens`, `cinematic-zoom`, `chromatic-split`, `flash-through-white`, `sdf-iris`, `ripple-waves`. `export.transition.accent` (default `'#0ea5e9'`) tints accent-aware shaders: `domain-warp`, `ridged-burn`, `thermal-distortion`, `sdf-iris`, `ripple-waves`.

Per-boundary shader selection is NOT supported in v1 — `export.transition.shader` applies to all boundaries. Future work: a sidecar for per-boundary overrides.

Chromium launch uses `--use-gl=angle --use-angle=swiftshader --enable-webgl` for headless WebGL.

Scene-window clamping: `buildShaderSpliceFilter` clamps `sceneEnd` to `cursorSec` and `transitionEnd` to `totalDurationSec` so boundaries near the video start/end don't produce invalid trim windows.

- **Speed Ramp** (`src/speed-ramp.ts`): Timeline-first speed ramp — planned before export so chapters, subtitles, and extra formats reflect ramped timing. Configured via `export.speedRamp: { gapSpeed, minGapMs }`. Uses `setpts` (video) and `atempo` (audio) filters.
- **Progress** (`src/progress.ts`): Wraps ffmpeg execution with `-progress pipe:1` to parse `out_time_us` and render a terminal progress bar showing encoding percentage. Used by the pipeline when `totalDurationMs` is known.
- **Subtitles** (`src/subtitles.ts`): Generates `.srt` and `.vtt` files from alignment placements + scenes manifest text. Best-effort — won't fail the pipeline.
- **Chapters** (`src/chapters.ts`): Generates ffmpeg metadata format (`TIMEBASE=1/1000`) for MP4 chapter markers from scene placements.
- **Report** (`src/report.ts`): Builds scene timing report (JSON + formatted console output) with per-scene durations, overflow, and output path.

Pipeline orchestration: `src/pipeline.ts` → CLI entry: `src/cli.ts` (Commander.js)

### Overlays (`src/overlays/`)

Injected into the browser during recording via `page.evaluate()`. Uses a zone-based positioning system (6 fixed positions) with template rendering (lower-third, headline-card, callout, image-card) and CSS motion presets (fade-in, slide-in).

Overlay cues use discriminated unions — each template type has its own TypeScript type with `type` as the discriminant field. `showOverlay`/`withOverlay` resolve overlay content from the `.scenes.json` manifest at runtime via `ARGO_OVERLAYS_PATH` env var. Demo scripts only provide duration/action — overlay content lives in the manifest. Full inline cues are still supported for backward compatibility.

Overlay injection includes a no-op `page.evaluate(() => {})` fence before injecting to flush pending browser renders. Apps with aggressive DOM updates (like sift's table engine) can remove freshly injected elements if they have a render cycle queued from the same tick as `narration.mark()`. The fence adds one CDP round-trip (~1-5ms) but prevents flashing. Fire-and-forget `showOverlay` calls use instance IDs — `removeZone` only removes if the element's instance matches, preventing a previous scene's cleanup from killing a newer overlay in the same zone.

### GSAP Motion (`src/overlays/gsap-motion.ts`, `src/overlays/gsap-runtime.ts`)

Overlays accept a GSAP-driven `motion` object alongside the CSS presets. `MotionPreset = 'none' | 'fade-in' | 'slide-in' | GsapMotion`. A `GsapMotion` has up to three phases — `in` (entrance), `out` (exit), `loop` (continuous) — each a declarative `GsapTween` (`from` / `to` / `fromTo`, `duration`, `delay`, `ease`, `stagger`, `target`, `repeat`, `yoyo`). `BlockDefinition.defaultMotion` lets a block ship its own entrance; cue-level `motion` overrides. `resolveMotion(cue)` returns cue → block → `'none'`.

Runtime: GSAP's UMD bundle (`node_modules/gsap/dist/gsap.min.js`, ~73KB) is read once per Node process (cached) and injected lazily into each page via `page.addScriptTag({ content })`. A `WeakSet<Page>` tracks injection per page; pages that already expose `window.gsap` are left alone. `showOverlay` times the exit so the visible window lands at the requested `durationMs`: `hold = durationMs - (out.duration + out.delay) * 1000`, then `out` fires, then `removeZone`. `withOverlay` fires `in` (+ `loop` if present) after inject and `out` before remove inside the `finally` block. `motion.ts` returns empty CSS/styles for GsapMotion — GSAP applies its own inline styles.

Security: `GSAP_EASES` and `GSAP_VAR_KEYS` whitelists reject unknown easings and animation props at `argo validate` time. `motion.raw` (a string executed via `new Function('gsap', 'root', raw)`) is gated by `config.overlays.allowRawGsap` — the validator rejects it when false, and the runtime also re-checks `ARGO_ALLOW_RAW_GSAP=1` before executing. Both layers matter: inline cues passed to `showOverlay` never hit the validator.

Env bridge: `config.overlays.allowRawGsap` → `record()` → `ARGO_ALLOW_RAW_GSAP` → Playwright subprocess → `gsap-runtime.ts`. All config-to-Playwright bridges must be added in both `src/pipeline.ts` call sites (primary + variants).

### Blocks (`src/blocks/`)

Curated overlay catalog. Each block is self-contained under `src/blocks/<name>/` with a `block.json` metadata file and a `template.ts` exporting a `BlockDefinition`. `src/blocks/index.ts` is a const-typed barrel — `BlockName` is a literal union derived from `keyof typeof BLOCK_REGISTRY`.

Blocks plug into `renderTemplate()` via the `type: 'block'` cue variant. Props merge over block-level defaults at render time (`{ ...block.defaultProps, ...cue.props }`). HTML escaping uses the shared `src/html-escape.ts` utility — all blocks import from there.

Static v1 blocks: `x-post`, `macos-notification`, `yt-lower-third`, `data-chart`, `spotify-card`.

Animated blocks (ship with `defaultMotion` using GSAP): `instagram-follow` (pulsing Follow button), `tiktok-follow` (rotating avatar ring + side slide), `reddit-post` (upvote card, simple entrance), `logo-outro` (scale-in end-card), `flowchart` (stacked nodes + arrows revealed with stagger), `app-showcase` (hero card with floating icon loop), `ui-3d-reveal` (perspective tilt-to-flat reveal of a screenshot). These use `BlockDefinition.defaultMotion` — a cue-level `motion` still overrides. Inspired by hyperframes blocks of the same names (Apache-2.0); implementations are original. Selector hooks used by motion loops/staggers: `.argo-ig-follow-btn`, `.argo-tt-ring`, `.argo-app-hero`, `.argo-3d-image`, `.argo-flow-node, .argo-flow-arrow`.

Folder format is designed for a future `argo add <block>` command (not shipped yet).

### Effects (`src/effects.ts`)

`showConfetti(page, opts?)` — non-blocking by default (fire-and-forget safe). Injects a canvas-based confetti animation via `page.evaluate()`. Two spread modes: `burst` (Raycast-style, center-top fan) and `rain` (full-width fall). `emoji: '🎃'` or `emoji: ['🎄', '⭐']` renders emoji characters instead of colored rectangles. Set `wait: true` to block until animation completes. Errors from page/context disposal are swallowed; all other errors surface as warnings.

### Camera (`src/camera.ts`) & Post-Export Camera Moves (`src/camera-move.ts`)

Four directed recording effects: `spotlight`, `focusRing`, `dimAround`, `zoomTo`, plus `resetCamera`. All accept CSS selector strings or Playwright Locators (resolved via `boundingBox()` before `page.evaluate()`). When a Locator is passed to `dimAround`, it falls back to a spotlight-style clip-path dim. All non-blocking by default (fire-and-forget safe).

`zoomTo` has two modes:
- **Post-export (recommended)**: Pass `narration` option — records bounding box + timing as a camera move mark. During export, ffmpeg applies `zoompan` with per-frame `in_time` expressions. Frame-exact, overlay-safe, no DOM manipulation. Camera moves are written to `.timing.camera-moves.json` sidecar. CRITICAL: uses `zoompan` not `crop` — ffmpeg's `crop` filter does NOT evaluate `w`/`h` expressions per-frame, making animated crop a no-op. The `zoompan` filter supports per-frame zoom via `in_time`.
- **Legacy browser-side**: Without `narration` option, falls back to CSS `transform-origin: 0 0` + `scale() translate()` on a wrapper div. Overlays scale with the page. Use only for VS Code preview / standalone Playwright runs.

Camera move pipeline flow: `zoomTo(page, target, { narration })` → `NarrationTimeline.recordCameraMove()` → `.timing.camera-moves.json` → pipeline reads + shifts (headTrim) + scales (deviceScaleFactor) → `buildCameraMoveFilter()` → ffmpeg `zoompan` in `filter_complex` (AFTER transitions — `zoompan` uses `in_time` which must be continuous across the concat output). The `zoompan` filter is driven at the source recording fps (from `getVideoFrameRate()`) to avoid duration mismatch (Playwright WebM is typically 25fps, not 30fps).

Error handling follows the same pattern as `showConfetti` (filter by disposal errors, warn on others).

### Freeze-Frame Holds (`src/freeze.ts`)

Per-scene freeze-frame holds via `post: [{ type: 'freeze', atMs, durationMs }]` in the scenes manifest. `resolveFreezes()` converts scene-relative offsets to absolute timeline positions. `buildFreezeFilter()` generates ffmpeg trim+tpad+concat to split, hold, and reassemble. `adjustPlacementsForFreezes()` shifts downstream placements/chapters/subtitles. Applied BEFORE transitions (freezes change the timeline). CRITICAL: `-shortest` must be skipped when freezes are present — video is intentionally longer than audio.

### Background Music (`src/export.ts`)

`export.audio.music` mixes a background track under narration. Music loops via `-stream_loop -1`, mixed at constant `musicVolume` (default 0.15) via `amix`, 2-second fade-out at the end. Music mixing goes inside `filter_complex` when other filters are active. Loudnorm is applied after mixing.

### Watermark (`src/export.ts`)

`export.watermark: { src, position, opacity, margin }` overlays a PNG at any corner via ffmpeg `overlay` filter with `colorchannelmixer` for opacity. Applied as the LAST video filter in the chain (after transitions, camera moves, downscale).

### Frame Effect (`src/frame.ts`)

`export.frame: { padding, borderRadius, shadow, shadowColor, background }` wraps the recording in a styled frame with rounded corners, drop shadow, and configurable background. Creates the "Screen Studio" look. Applied AFTER overlay PNGs and camera moves, BEFORE watermark (same layer priority as CAS sharpening).

Background types: `solid` (hex color), `gradient` (CSS `linear-gradient()` string), `image` (file path), `auto` (probes video edge colors via `probeEdgeColors()` in `src/media.ts` — downscales frame to 16x16, runs 2-means clustering to extract dominant color pair).

Frame effect uses a two-phase approach for fast encoding: `generateFramePng()` pre-renders background + transparent rounded-rect hole as a single PNG (~100ms), then export overlays the video onto it with one simple `overlay` filter. ~12x faster than the old per-frame geq + boxblur approach. Falls back to inline filter if PNG generation fails. The PNG uses ffmpeg `geq` on the alpha channel to punch the hole, with escaped commas (`\\,`) for `-vf` parsing. Pad color uses the gradient's first hex color to avoid black gaps at sub-pixel boundaries.

ffmpeg gotchas discovered during implementation:
- `gradients` source filter rejects negative coordinate values — clamp `x0/y0/x1/y1` to `[0, dimension]`
- `color` and `gradients` sources need `d=1,loop=-1:1:0` to produce infinite frames — without loop, `overlay` stops when background source ends (black strip artifact)
- Rounded corners use `geq` alpha mask with separate straight-edge vs corner-arc logic — naive `hypot` on all edges causes background bleed along straight sides
- Shadow layer must be scaled down (inset) before `boxblur` to prevent blur bleeding past rounded corners
- All `overlay` compositing uses `shortest=1` so output stops when the video stream ends

### Contrast-Adaptive Sharpening (`src/export.ts`)

`export.sharpen: true | { strength: 0.5 }` applies ffmpeg `cas` filter to restore text crispness lost during screen recording encode. Applied as the last video filter after all compositing (after watermark). Single filter append, low complexity.

### Motion Blur (`src/camera-move.ts`)

`export.motionBlur: true | { intensity: 0.5 }` applies `tblend=all_mode=average` during camera move transitions. Time-gated via ffmpeg `enable='between(t,start,end)'` expressions — only activates during zoom-in and zoom-out windows, skips static hold intervals. Each window is padded by ~1 frame to avoid abrupt boundaries. Without time-gating, `tblend` on the full stream has no visible effect (static frames blended with identical frames = no change).

### Per-Scene Playback Speed

`playbackSpeed: 0.5` in `.scenes.json` controls video playback rate per scene (separate from TTS `speed`). Integrated into speed ramp segments via `SceneSpeedMap` in `src/speed-ramp.ts`. Wired through pipeline, CLI export, and preview export paths. Speed applies to the full recording span (mark to next mark), not just the TTS placement window — gaps after a sped-up scene inherit its speed until the next scene starts. This means `playbackSpeed: 25` on a loading scene fast-forwards both the voiceover window and the dead time after it.

### Arrow Overlay Template

`overlay: { type: 'arrow', direction, label, color, size }` — SVG arrow annotation with 8 directions. Arrow labels use **inverted** color logic compared to other templates: arrows have no background panel, so dark pages get white text and light pages get dark text. Other templates (lower-third, headline-card) have opaque backgrounds, so they use the opposite mapping.

### AI Music Generation (`src/music/musicgen.ts` + preview UI)

MusicGen (Xenova/musicgen-small) generates background music from text prompts. Runs in the **browser** preview UI via Web Worker + WebGPU (NOT in the Node.js pipeline). The preview server serves `/musicgen-worker.js` as a same-origin module worker (blob URL workers can't cross-origin import from CDN). Generated WAV is saved to `.argo/<demo>/music/bgm.wav` and picked up by the export pipeline via `audio.music`. CRITICAL: must use `device: 'webgpu'` — WASM fallback is orders of magnitude slower. Use `q4` dtype to reduce model size (~450MB vs 1.8GB fp32).

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
- Live per-scene recording progress via JSONL sidecar: `narration.mark()` appends to `ARGO_PROGRESS_PATH`, `record()` polls and prints scene names
- `post` array in scenes manifest supports `{ type: 'freeze', atMs, durationMs }` for freeze-frame holds — resolved to absolute positions, adjusts placements/chapters/subtitles
- All export features (freeze, camera moves, music, watermark, loudnorm, sharpen, frame, motionBlur) must be wired through ALL export paths: pipeline, CLI `argo export`, preview Export, and viewport variants — missing any path causes silent divergence

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
- Showcase demo (`demos/showcase.demo.ts`) requires a local HTTP server serving `demos/`: `python3 -m http.server 8976 --directory demos` then `BASE_URL=http://127.0.0.1:8976 npx tsx bin/argo.js pipeline showcase`
- Browser default is `chromium`. With `captureMode: 'jpeg-stitch'` (CDP-direct paint-time capture, v0.35+) and `deviceScaleFactor: 2`, **chromium produces the highest-quality output** — 4K JPEGs sampled at paint time, downscaled with lanczos. webkit and firefox remain solid for the default `webm` capture but can't honor `deviceScaleFactor > 1` (auto-clamped to 1 with a warning in `record.ts`) and don't support `jpeg-stitch` (auto-downgraded to `webm` with a warning — firefox `onFrame` only sustains ~3fps). The legacy chromium VP8 quality issue ([playwright#31424](https://github.com/microsoft/playwright/issues/31424)) only applies to the default `webm` mode on chromium — `jpeg-stitch` bypasses Playwright's encoder entirely.
- `deviceScaleFactor: 2` captures at 2x resolution; export downscales with lanczos. Value is rounded to integer (min 1). Auto-clamped to 1 on non-chromium browsers.
- Mobile demos: set `isMobile: true`, `hasTouch: true` in `video` config. These are passed through to the generated Playwright config. `contextOptions` also flows through (for `colorScheme`, `locale`, `geolocation`, `permissions`, etc.).
- `--headed` on macOS shows a gray bar at bottom of video — browser chrome reduces viewport. Use headless (default) for final recordings.
- Voiceover `text` is spoken only, never displayed — spell words phonetically to fix TTS pronunciation (e.g., `"sass"` for SaaS, `"A P I"` for API, `"cube control"` for kubectl). Overlay text is what viewers see. Kokoro via `kokoro-js` uses `phonemizer.js` (eSpeak NG) for G2P — the upstream `[word](/IPA/)` misaki syntax does NOT work. Use phonetic spelling instead. Phonetics differ per engine: Kokoro needs `tee tee ess` / `A.I.` / `M.L.X.`, OpenAI handles acronyms natively. When switching engines, update voiceover text.
- Voice cloning: mlx-audio engine supports `refAudio` + `refText` options for cloning from a 15s reference clip. Qwen3-TTS produces best clone quality (CSM is lower). Scripts: `scripts/record-voice-ref.sh` (macOS mic recording), `scripts/voice-clone-preview.sh` (batch preview with manifest).
- VS Code DX: demos run directly from VS Code's Playwright test panel. The narration fixture auto-discovers `demos/<testTitle>.scenes.json` when `ARGO_OVERLAYS_PATH` is not set. Overlays and effects work; timing uses fallback defaults (3000ms) until `argo pipeline` generates `.scene-durations.json`. Auto-discovery uses `testInfo.file` basename (not `testInfo.title`) so it works regardless of test title. The env var is restored after each test to prevent leaking across tests in the same worker.
- Effect timing pattern: derive beat durations from `durationFor()` minus setup wait, divided by effect count: `const totalMs = narration.durationFor('scene') - setupWaitMs; const beat = Math.floor(totalMs / numberOfEffects);` This keeps camera effects synchronized with voiceover. Hardcoded durations drift.
- When using scene transitions, content changes (page navigation, slide switches) must happen BEFORE `narration.mark()` so the transition fades between old and new content. If content changes after mark(), the transition just pulses the same visual.
- Demos must call `await narration.startRecording(page)` once setup (login, theme prep, navigation) is done and before the first `narration.mark()`. This calls `page.screencast.start()` and re-anchors the timeline so the first mark lands at t=0. Without it, no recording is produced under `argo pipeline` (loud error).
- Avoid `test.beforeEach` in demo scripts — `startRecording()` is the explicit "real demo starts here" anchor; setup code that runs before it is excluded from the video.
- Silent demos: omit `text` from scenes manifest entries — TTS is skipped, pipeline exports video-only with no audio track. Useful for quick prototype demos with just overlays and camera effects.
- Recording start is explicit (no auto-trim heuristic). The legacy `headTrimMs` field on `.meta.json` is still computed by `computeHeadTrimMs(timing)` but naturally returns 0 because the first mark lands at t=0. Old metadata with non-zero `headTrimMs` is still honored on read (preview, clip extraction) so existing recordings keep working.

## Scene Durations & Dynamic Timing

- `narration.durationFor(scene, opts?)` computes wait times from TTS clip lengths (replaces hardcoded ms values in demo scripts)
- Pipeline writes `.scene-durations.json` after TTS → env var `ARGO_SCENE_DURATIONS_PATH` passes it to Playwright subprocess → fixture loads into `NarrationTimeline`
- Formula: `clipMs * multiplier + leadInMs + leadOutMs`, clamped to [minMs, maxMs] (defaults: 200ms lead-in, 400ms lead-out, 2200–30000ms range, 5000ms fallback). Logs a warning on first fallback when no scene durations are loaded.
- `narration.sceneDuration(scene, opts?)` returns the full TTS-based duration without subtracting elapsed time. Use for overlay display durations where a stable, non-decreasing value is needed. `durationFor()` returns remaining time from "now" and can decrease to 0 if called late.

## Env Vars Bridging Config to Playwright

- `ARGO_SCENE_DURATIONS_PATH` — path to `.scene-durations.json` (loaded by narration fixture)
- `ARGO_OVERLAYS_PATH` — path to `.scenes.json` manifest (loaded by overlay functions for manifest-based resolution)
- `ARGO_AUTO_BACKGROUND` — set to `'1'` when config `overlays.autoBackground` is true
- `ARGO_ALLOW_RAW_GSAP` — set to `'1'` when config `overlays.allowRawGsap` is true. Re-checked by the runtime before executing `motion.raw` (defense in depth against inline cues that skip the validator).
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
- Frame & Background panel: collapsible sidebar panel for configuring frame effect (padding, border radius, shadow + color, background type). Supports solid, gradient, auto (probes video edge colors via `/api/probe-auto-bg`), and image backgrounds. Live CSS preview in the video container. Settings persist to `.argo/<demo>/frame-config.json` sidecar (survives server restarts). Sidecar takes priority over `export.frame` in config module for both UI load and export paths. Auto background probe uses raw recording (not exported MP4) to match export behavior.
- Waveform strip above the timeline-bar: `/api/waveform?samples=N` serves downsampled peak amplitudes (normalized to `[0,1]`) computed by `src/preview-waveform.ts` from `narration-aligned.wav`. Cached per-process by file mtime + bucket count, so repeated requests during a session are cheap. The client paints to a `<canvas>` with DPR-aware scaling, repaints on window resize, mirrors the timeline playhead via `#waveform-playhead`, and routes click-to-seek through `scrubFromWaveformX`. Empty state ("No narration audio yet…") shows when the WAV is missing or unparseable.

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
- ~~`zoomTo` transforms `documentElement`~~ — FIXED: post-export camera moves (`narration` option) use ffmpeg `zoompan` — overlays are already burned into the video and unaffected. Legacy browser-side `zoomTo` (without `narration`) still has this issue.
- OpenAI engine requests raw PCM (`response_format: 'pcm'`) and converts to Float32 directly — do not use `convertToWav` (ffmpeg pipe introduces 0xFFFFFFFF data size artifacts).
- `convertToWav` (ffmpeg pipe to stdout) writes WAV with `0xFFFFFFFF` data size — `parseWavHeader` falls back to actual buffer length. All engines using `convertToWav` are affected.
- Showcase demo video hosted via GitHub gist comment upload: https://gist.github.com/shreyaskarnik/6a0996942a96528a984010f36de76079
- `tsc` build may silently fail if `tsconfig.json` is missing — verify it exists before trusting `npm run build` output
- `dissolve` transition is a shorter dip-to-black, not a true crossfade blend. A real crossfade would require ffmpeg `xfade` with re-encoded segment pairs — impractical for continuous recordings.
- ~~`9:16` format export center-crops from 16:9~~ — FIXED: now uses blur-fill (blurred background + scaled-to-fit foreground).
- ~~`speedRamp` + `transitions` cannot be used together~~ — FIXED: speed ramp filter labels are now prefixed with `sr_` to avoid collisions with transition labels.
- ffmpeg `crop` filter does NOT evaluate `w`/`h` per-frame — only `x`/`y` are dynamic. Use `zoompan` for animated zoom effects. This was the root cause of the camera move no-op bug.
- `-af` and `-filter_complex` cannot coexist on the same stream — when transitions produce a `filter_complex`, `loudnorm` must be appended inside the graph, not as `-af`.
- npm version tags: if a tag was already published to npm, you must bump to a new version (can't re-publish the same version even after deleting the tag).
- `-shortest` must be skipped when freeze-frame holds extend the video beyond the audio duration.
- Blob URL Web Workers with `type: 'module'` cannot cross-origin import from CDN — serve the worker script from the same origin instead.
- MusicGen WebGPU dtype: use `q4` (not `fp32`) to avoid ~15GB Chrome RAM usage. `q4` weights are ~450MB total.
- `tblend` motion blur without time-gating has no visible effect — static frames blended with identical static frames produce no change. Always pass camera moves to `buildMotionBlurFilter()` for `enable` expression generation.
- ffmpeg `gradients` source filter rejects negative `x0/y0/x1/y1` values — angle-to-coordinate conversion can produce negatives for certain angles. Always clamp.
- `narration.mark()` does sync `appendFileSync` which can trigger app re-renders on the same event loop tick — overlay injection fence mitigates but apps with very aggressive DOM updates may still need manual `waitForTimeout()` after `mark()`.
- `-shortest` must be skipped when frame PNG overlay is present — PNG has 0 duration and truncates the entire output.

## Security Invariants

- Demo names are validated at CLI entry (`src/cli.ts`): `[a-zA-Z0-9][a-zA-Z0-9_-]*` only. Always validate before `path.join()`.
- Overlay text is HTML-escaped via `escapeHtml()` in `src/overlays/templates.ts` before `innerHTML` injection. Never bypass.
- Subprocess calls use `execFile`/`spawnSync` with array args — never shell string interpolation.
- `showConfetti` catch block filters by error message — only swallows page disposal errors, surfaces everything else. Don't broaden.
- `loadConfig` validates the exported value is a plain object. Config files run with full Node.js privileges (same as Vite/Webpack).
