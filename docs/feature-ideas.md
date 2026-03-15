# Feature Ideas

This is a lightweight roadmap note for future Argo work. It is intentionally practical: each item is here because it would improve authoring speed, output quality, or reliability.

## Near Term

- ~~Manifest-driven overlays.~~ **SHIPPED** — `.overlays.json` is a first-class authoring path.
- `argo doctor`. Check `ffmpeg`, Playwright browsers, quality settings, missing assets, broken config, and common environment issues before a run.
- ~~`argo lint`.~~ **SHIPPED** as `argo validate` — checks scene name consistency between demo script, voiceover manifest, and overlay manifest.
- ~~Subtitle export.~~ **SHIPPED** — `.srt` and `.vtt` generated alongside the MP4.
- ~~Scene report.~~ **SHIPPED** — JSON + formatted console output with per-scene durations, overflow, and output path.

## High-Leverage Product Features

- ~~Camera language.~~ **SHIPPED** — `spotlight`, `focusRing`, `dimAround`, `zoomTo`, `resetCamera` helpers for directed demo recordings.
- Multi-format export. Support `16:9`, `1:1`, and `9:16` from the same source demo, with overlay reflow and safe areas.
- Resumable pipeline. Cache per-step artifacts so changing one voice line or one scene does not force a full rerun.
- Per-scene transitions. Add fades, wipes, hold-freezes, and section bumpers so the final result feels more editorial.
- Theme packs for overlays. Provide reusable visual styles like `terminal`, `product-keynote`, `minimal-docs`, and `launch-trailer`.

## Developer Experience

- `argo preview`. Hot-reload mode that watches `.demo.ts`, `.overlays.json`, and `.voiceover.json` for changes and re-runs only affected pipeline steps. Massive iteration speed win.
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
- Cursor smoothing and highlighting. Smooth jittery Playwright mouse paths and add click-ripple effects to make interactions more visible.
- Watermark and branding strip. Config-driven persistent logo or "DEMO" watermark overlay for draft vs. final renders.
- ~~Chapter markers.~~ **SHIPPED** — MP4 chapter metadata embedded from scene marks via ffmpeg.
- Burned-in captions. Render voiceover text as styled subtitles directly into the video frame, not just `.srt` sidecar files. Many social platforms ignore external subtitle tracks.

## Content & Accessibility

- i18n and multi-language support. Support locale variants of voiceover manifests (`showcase.voiceover.en.json`, `showcase.voiceover.ja.json`) and batch-render localized versions from the same demo script.

## Pipeline Robustness

- Artifact manifest. Write a `pipeline-manifest.json` after each run with hashes of all inputs and outputs. Enables incremental rebuilds and CI caching.
- ~~Parallel TTS generation.~~ **SHIPPED** — shared Kokoro init promise prevents duplicate model downloads. Generation is sequential (Kokoro ONNX runtime has mutex issues with concurrent calls).
- `argo ci`. Opinionated CI mode: lint → pipeline → assert duration bounds → upload artifact. One command for GitHub Actions integration.

## Distribution

- GIF export. Auto-generate a looping GIF snippet (first N seconds or a specific scene range) for embedding in READMEs and PRs.
- Thumbnail auto-generation. Auto-capture a frame at a configurable timestamp as the video thumbnail instead of requiring a manual PNG.

## Longer Horizon

- Timeline preview UI. A lightweight local viewer showing scenes, overlays, and narration lengths before rendering.
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

## Suggested Priority

Next up from what's remaining:

1. Multi-format export (16:9, 1:1, 9:16)
2. `argo preview` (hot-reload)
3. `argo doctor`
