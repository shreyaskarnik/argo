# Feature Ideas

This is a lightweight roadmap note for future Argo work. It is intentionally practical: each item is here because it would improve authoring speed, output quality, or reliability.

## Near Term

- ~~Manifest-driven overlays.~~ **SHIPPED** — overlays defined in `.scenes.json` manifest, resolved at runtime by `showOverlay`/`withOverlay`.
- ~~`argo doctor`.~~ **SHIPPED** — checks ffmpeg, ffprobe, Playwright browsers, config, baseURL, demosDir, thumbnail, video settings, and DPI issues.
- ~~`argo lint`.~~ **SHIPPED** as `argo validate` — checks scene name consistency between demo script and scenes manifest.
- ~~Subtitle export.~~ **SHIPPED** — `.srt` and `.vtt` generated alongside the MP4.
- ~~Scene report.~~ **SHIPPED** — JSON + formatted console output with per-scene durations, overflow, and output path.

## High-Leverage Product Features

- ~~Camera language.~~ **SHIPPED** — `spotlight`, `focusRing`, `dimAround`, `zoomTo`, `resetCamera` helpers for directed demo recordings.
- ~~Multi-format export.~~ **SHIPPED** — `export.formats: ['1:1', '9:16']` with blur-fill background. Next step: **viewport-native variants** — re-record at target viewport (`1080x1920` for 9:16) so CSS handles layout. TTS runs once, record+export per variant. `export.variants: [{ name: '9x16', video: { width: 1080, height: 1920 } }]`.
- Resumable pipeline. Cache per-step artifacts so changing one voice line or one scene does not force a full rerun.
- ~~Per-scene transitions.~~ **SHIPPED** — `fade-through-black`, `dissolve`, `wipe-left`, `wipe-right` via `export.transition` config. ffmpeg filter expressions generated at scene boundaries.
- Theme packs for overlays. Provide reusable visual styles like `terminal`, `product-keynote`, `minimal-docs`, and `launch-trailer`.

## Developer Experience

- ~~`argo preview`.~~ **SHIPPED** — browser-based editor for voiceover, overlays, and timing. Edit `.scenes.json` inline, regen TTS per scene, preview without re-recording.
- `argo diff <demo>`. Compare two pipeline runs side-by-side: timing deltas, overlay changes, duration drift. Catches regressions when editing demos.
- ~~Dry-run mode (`--dry-run`).~~ **SHIPPED** as `argo validate` — validates without running TTS or recording.
- `argo tts preview`. Play back generated TTS clips in the terminal without running the full pipeline. Quick way to iterate on script copy and voice selection.

## Dynamic Overlay Content

- Keyframed text mutations. Allow overlay cues to define timed mutations within a single cue's lifetime — bold a word, reveal a phrase, swap text, change color — synchronized to the voiceover. Today overlays are static HTML injected once; this adds a `keyframes` array to any cue that schedules DOM patches at relative offsets. Example in `.overlays.json`:
  ```json
  {
    "scene": "hero",
    "type": "lower-third",
    "text": "Introducing {Argo}",
    "keyframes": [
      { "at": 1200, "selector": ".argo-highlight", "style": { "fontWeight": "bold", "color": "#4F8EF7" } },
      { "at": 2500, "selector": ".argo-highlight", "class": "revealed" }
    ]
  }
  ```
  `{Argo}` would be wrapped in a `<span class="argo-highlight">` during template rendering. At 1200ms into the cue, the span gains bold + color; at 2500ms it gets the `revealed` class (author-defined CSS). This keeps the manifest declarative while enabling rich choreography.
- Built-in text effects. Ship a small library of reusable effects: `typewriter` (reveal characters one-by-one), `word-reveal` (fade in words sequentially), `emphasis` (bold/scale pulse on a marked phrase), `strikethrough-replace` (cross out old text, reveal new). Effects would be referenced by name in the manifest and driven by CSS animations + a lightweight JS scheduler injected alongside the overlay.
- Programmatic mutations via `withOverlay`. For complex sequences, expose a `mutateOverlay(page, zone, patch)` helper in demo scripts. Authors can drive arbitrary DOM changes mid-cue from Playwright — e.g., update a stat counter, swap an image, toggle a class — while `withOverlay` keeps the overlay lifecycle managed. This complements the declarative keyframes path for cases that need full control.

## Production Quality

- Audio ducking and background music. Mix in a background track with automatic volume ducking under voiceover clips.
- ~~Cursor smoothing and highlighting.~~ **SHIPPED** — `cursorHighlight(page)` with pulse animation and click ripple effects.
- Watermark and branding strip. Config-driven persistent logo or "DEMO" watermark overlay for draft vs. final renders.
- ~~Chapter markers.~~ **SHIPPED** — MP4 chapter metadata embedded from scene marks via ffmpeg.
- Burned-in captions. Render voiceover text as styled subtitles directly into the video frame, not just `.srt` sidecar files. Many social platforms ignore external subtitle tracks.

## Content & Accessibility

- i18n and multi-language support. Support locale variants of scenes manifests (`showcase.scenes.en.json`, `showcase.scenes.ja.json`) and batch-render localized versions from the same demo script.

## Pipeline Robustness

- Artifact manifest. Write a `pipeline-manifest.json` after each run with hashes of all inputs and outputs. Enables incremental rebuilds and CI caching.
- ~~Parallel TTS generation.~~ **SHIPPED** — shared Kokoro init promise prevents duplicate model downloads. Generation is sequential (Kokoro ONNX runtime has mutex issues with concurrent calls).
- `argo ci`. Opinionated CI mode: lint → pipeline → assert duration bounds → upload artifact. One command for GitHub Actions integration.

## Distribution

- ~~GIF export.~~ **SHIPPED** — `export.formats: ['gif']` produces two-pass palette-optimized animated GIFs.
- Thumbnail auto-generation. Auto-capture a frame at a configurable timestamp as the video thumbnail instead of requiring a manual PNG.

## Desktop App Recording (Tauri / Electron)

- **Tauri apps** — Record demos of Tauri desktop apps. Two approaches:
  - **Mock approach (works today):** Inject `__TAURI_INTERNALS__` stubs via `page.addInitScript()` before navigating to the Vite dev server. The React UI renders fully with overlays, camera effects, and voiceover — but no backend functionality (no kernel execution, no file I/O). Good for UI walkthroughs. See `~/work/rnd/tauri-exp/nteract.demo.ts` for a working example with nteract.
  - **`tauri-plugin-localhost` (ideal, needs app changes):** The app author adds `tauri-plugin-localhost` which serves the frontend on `http://localhost:<port>` with the full Tauri runtime active. Argo points at that URL — no mocking, real backend, real kernel execution. Requires changing window creation to `WebviewUrl::External(url)`. Kyle (nteract) is adding this.
  - **What doesn't work:** `WEBKIT_INSPECTOR_SERVER` (wry doesn't pass it to WebKit on macOS), `tauri-driver` (Linux-only, WebKitGTK), plain Vite dev server without mocks (`@tauri-apps/api` crashes).

- **Electron apps** — Playwright has first-class Electron support via `electron.launch()`. This gives page objects for each `BrowserWindow`. Argo would need:
  - A new fixture mode that accepts an Electron app path instead of a browser URL
  - The `narration` fixture wired into `electron.launch()` context
  - Video capture from the Electron window (Playwright supports this natively)
  - This is a deeper integration than Tauri mocking but Playwright already does the heavy lifting.

- **Generic screen recording fallback** — For any desktop app (native, Qt, SwiftUI, etc.), bypass Playwright entirely and use macOS screen recording (`screencapture` or `ffmpeg -f avfoundation`). Argo would handle just TTS + overlays (injected as a transparent overlay window) + export. The recording source changes but the rest of the pipeline stays the same.

## Longer Horizon

- Timeline preview UI. Visual overlay representations on the `argo preview` timeline bar (like a video editor's track view).
- AI assist for demo polish. Suggest shorter copy, better scene splits, improved pacing, and stronger overlay placement.
- Auto social package. Export MP4 plus thumbnail, transcript, title ideas, subtitle variants, and aspect-ratio cuts in one command.

## Also Shipped (not on original list)

- Extensible TTS — 6 built-in engines (Kokoro, OpenAI, ElevenLabs, Gemini, Sarvam, mlx-audio) via `engines.*` factories
- `--base-url` and `--headed` CLI flags
- `demoType` accepts Playwright Locator
- `argo init` scaffolds `.mjs` with `defineConfig()`
- `showConfetti` effects (burst + rain)
- `overlays.defaultPlacement` config
- Demo name validation at CLI boundary (security hardening)
- Error hardening: zero-clip detection, thumbnail warnings, timing parse context, asset server streams
- Self-contained `example/` directory
- LLM skill (`skills/argo-guide/`) + Agent Skills cross-client support (`.agents/skills/`)
- `argo validate` command
- `argo preview` — browser-based editor with per-scene TTS regen, live overlay preview, motion dropdown
- Unified `.scenes.json` manifest (replaces separate `.voiceover.json` + `.overlays.json`)
- Manifest-based `showOverlay`/`withOverlay` — overlay content resolved from manifest at runtime
- Voice cloning with mlx-audio (`refAudio` + `refText`)
- Scene transitions — `fade-through-black`, `dissolve`, `wipe-left`, `wipe-right`
- Speed ramp — compress inter-scene gaps at configurable speed (`export.speedRamp`)
- GIF export — two-pass palette-optimized animated GIFs via `export.formats: ['gif']`
- Batch pipeline — `argo pipeline --all` runs every demo sequentially, continues on failure
- Multi-demo dashboard — `argo preview` (no args) lists all demos with build status, sizes, metadata
- Export progress bar — real-time ffmpeg encoding progress via `-progress pipe:1`
- `cursorHighlight` / `resetCursor` — persistent cursor ring with pulse and click ripple
- Emoji confetti — `showConfetti(page, { emoji: '🎉' })` renders emoji instead of rectangles
- Transformers.js engine — generic HuggingFace `text-to-speech` adapter with auto-resampling
- Text chunking — long voiceover auto-split at sentence boundaries for Kokoro and Transformers
- Mobile demos — `isMobile`, `hasTouch`, `contextOptions` passthrough to Playwright config
- Auto-trim — trims video before first `narration.mark()`, persists `headTrimMs` in `.meta.json`
- Preview light/dark mode — follows system `prefers-color-scheme`
- `argo clip` — extract individual scene clips (MP4 or GIF) from exported videos using chapter markers
- `argo release-prep` — generate markdown release notes with scene table, durations, and clip links
- Audio loudness normalization — `loudnorm` option in export config
- Blur-fill for cropped formats — `9:16` and `1:1` use blurred background instead of black bars
- VS Code Playwright integration — `playwright.config.ts` + fixture auto-discovery for running demos from the editor
- Plan-then-render pipeline — compute placements/chapters/subtitles before export for consistent timing
- Shared timeline module — extracted `src/timeline.ts` for placement building, head-trim, duration computation
- Canonical showcase demo — single 10-scene demo covering all Argo capabilities
- Post-export camera moves — `zoomTo(page, target, { narration })` records zoom marks, applied as ffmpeg `zoompan` during export. Overlay-safe, frame-exact.
- Viewport-native variants — `export.variants` re-records at different viewports (TTS shared). Pixel-perfect multi-format without blur-fill artifacts.

## Suggested Priority

Next up from what's remaining:

1. Viewport-native variants — re-record at target viewport (`1080x1920` for 9:16) instead of crop+blur-fill
2. Electron app recording (Playwright has native support, needs fixture integration)
3. Theme packs for overlays (`terminal`, `product-keynote`, `minimal-docs`, `launch-trailer`)
4. Timeline preview UI with overlay thumbnails on the `argo preview` timeline bar
5. Resumable pipeline with per-step artifact caching
6. Burned-in captions (render subtitles into the video frame for social platforms)
7. Audio ducking and background music
8. `argo diff` — compare two pipeline runs side-by-side
9. i18n — locale variants of scenes manifests for multi-language renders
10. `argo ci` — opinionated CI mode (lint → pipeline → assert bounds → upload artifact)
11. Keyframed text mutations in overlays
12. AI assist for demo polish (pacing, copy, overlay placement suggestions)
