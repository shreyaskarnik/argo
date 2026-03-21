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

- ~~Audio ducking and background music.~~ **SHIPPED** (constant-volume mixing). True sidechain ducking is future work.
- AI-generated background music. Use `Xenova/musicgen-small` (Transformers.js) to generate background music from a text prompt — fully local, no API keys. Config: `export.audio.musicPrompt: 'lofi chill ambient with soft piano'`. Pipeline generates a ~30s clip, content-addressed cached, looped via `-stream_loop -1`. Model is ~1.8GB (first run downloads). Reference: [MusicGen Web](https://huggingface.co/spaces/Xenova/musicgen-web).
- ~~Cursor smoothing and highlighting.~~ **SHIPPED** — `cursorHighlight(page)` with pulse animation and click ripple effects.
- ~~Watermark and branding strip.~~ **SHIPPED** — `export.watermark: { src, position, opacity, margin }` overlays PNG at any corner.
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
- Background music mixing — `export.audio.music` with constant-volume mixing, loop, fade-out
- Freeze-frame holds — `post: [{ type: 'freeze', atMs, durationMs }]` in scenes manifest
- Watermark overlay — `export.watermark: { src, position, opacity, margin }`
- Live recording progress — per-scene status via JSONL progress file

## New Feature Ideas

### Playwright / Recording

- **Click-to-zoom**. Auto-detect click targets during recording and generate `zoomTo({ narration })` calls. The click target's bounding box is captured at the moment of `page.click()` — no manual `zoomTo` needed. Config: `video.autoZoomOnClick: true`.
- **Mouse trail / gesture overlay**. Record actual mouse movement path during Playwright session and render as a smooth bezier trail during export (ffmpeg `drawbox` with time expressions or SVG burn-in). Shows viewers where the cursor went.
- **A/B scene variants**. Record the same demo with different scenes.json manifests to produce variant videos (different copy, different overlays) from a single script. `argo pipeline demo --variant=launch` loads `demo.scenes.launch.json`.
- **Accessibility audit overlay**. During recording, run `@axe-core/playwright` on each scene and inject a11y violation badges as overlay annotations. Turns demo videos into accessibility review artifacts.
- **Network throttle presets**. Add `network: 'slow-3g'` to config — Playwright applies `page.route()` throttling so loading spinners and skeleton screens appear naturally in the recording.
- **Scroll-triggered marks**. Auto-insert `narration.mark()` calls when the page scrolls past configurable thresholds. For long-page demos (landing pages, docs sites) where manual marks are tedious.

### AI / LLM

- **Auto-script from URL**. Give Argo a URL → it crawls the page, identifies key features, and generates a complete `.demo.ts` + `.scenes.json`. Uses an LLM to plan the demo narrative. `argo generate --url http://localhost:3000`.
- **Voice emotion tags**. Add `emotion: 'excited' | 'calm' | 'serious'` per scene in manifest. Engines that support it (OpenAI `gpt-4o-mini-tts` via `instructions`, mlx-audio via prompt) adjust delivery. Others ignore gracefully.
- **Auto-caption styling**. LLM analyzes voiceover text and suggests word-level emphasis (bold key terms, color brand names) for burned-in captions. Output is a styled SRT with inline formatting tags.
- **Demo review agent**. After pipeline completes, an LLM reviews the scene report (durations, pacing, overflow) and suggests improvements: "Scene 3 is 8.2s — consider splitting", "Intro has no overlay — add a lower-third".
- **Manifest generation from transcript**. Paste a transcript → LLM generates a `.scenes.json` with scene boundaries, overlay suggestions, and voice assignments. `argo manifest --from transcript.txt`.
- **Smart silence detection**. Analyze the recorded audio to detect unintentional long silences (keyboard pauses, slow page loads) and auto-insert speed ramp segments. No manual `speedRamp` config needed.

### FFmpeg / Export

- **Burned-in animated captions**. Word-level subtitle burn-in with highlight animation (current word bolds/colors as it's spoken). Requires word-level timestamps from TTS engines that support it (OpenAI returns word timing, Kokoro could approximate via phoneme timing).
- **Intro/outro bumper cards**. Auto-generate a title card (product name + tagline) and end card (CTA + URL) as video segments prepended/appended to the export. Config-driven, uses ffmpeg `drawtext` + `color` source. `export.intro: { title: 'Acme Inc', tagline: 'Ship faster' }`.
- **Ken Burns for static scenes**. When a scene has no DOM changes (static page), auto-apply a slow drift/zoom (Ken Burns effect) to keep the video alive. Detect static frames via ffmpeg `mpdecimate` or scene change detection.
- **Picture-in-picture webcam**. Overlay a webcam feed (or pre-recorded video) in a corner during specific scenes. `post: [{ type: 'pip', src: 'assets/webcam.mp4', position: 'bottom-right', width: 320 }]`.
- **Animated progress bar**. Thin bar at top/bottom showing overall video progress + chapter markers. Config: `export.progressBar: { position: 'bottom', color: '#3b82f6', height: 4 }`. Uses ffmpeg `drawbox` with time expressions.
- **Color grading presets**. Apply LUT-based color grades for different moods: `warm`, `cool`, `cinematic`, `high-contrast`. Config: `export.colorGrade: 'cinematic'`. Ships 4-5 .cube LUT files.
- **Audio ducking (sidechain)**. True sidechain compression — BGM volume dips when narration is active, rises in gaps. Uses ffmpeg `sidechaincompress`. More sophisticated than current constant-volume mixing.
- **Segment-level export**. Export individual scenes as standalone clips with their own intro cards + transitions. For embedding specific features in docs pages. `argo export demo --scene intro --scene features`.
- **Animated thumbnails**. Auto-generate a 3-second looping video thumbnail (like YouTube hover previews) from the most visually active scenes. Uses scene change detection + trim + loop.

### Platform / Distribution

- **`argo publish`**. One command to upload to YouTube/Vimeo/Loom with title, description, and tags from `.meta.json`. Uses official APIs. `argo publish demo --platform youtube --visibility unlisted`.
- **Social package export**. `argo package demo` generates a folder with: MP4, GIF, thumbnail PNG, transcript, SRT, chapter list, and a `RELEASE.md` with embed snippets. Everything needed for a product launch post.
- **Embed snippet generator**. After export, output HTML `<video>` tags with poster, subtitles track, and responsive sizing. Copy-paste into docs/blog.
- **RSS feed for demo series**. `argo feed` generates an RSS/Atom feed from all exported demos. Subscribe to get notified when new demos are published. Good for internal teams.

### Developer Experience

- **Hot reload preview**. `argo preview <demo> --watch` watches `.scenes.json` for changes and auto-refreshes the preview. No manual page reload.
- **`argo benchmark`**. Profile pipeline performance: TTS generation time, recording duration, export encoding speed. Identifies bottlenecks when optimizing for CI.
- **Playwright trace integration**. Link each scene in the preview to its Playwright trace viewer span. Click a scene → opens trace at that timestamp. Already capturing traces (`trace: 'on'`), just need the UI.
- **Config validation with suggestions**. `argo doctor` checks config values against known-good ranges and suggests improvements: "CRF 16 with preset 'slow' produces large files — consider CRF 23 for drafts".
