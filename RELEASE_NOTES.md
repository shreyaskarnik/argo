# v0.10.0

## Unified Scenes Manifest

Separate `.voiceover.json` and `.overlays.json` files are replaced by a single **`.scenes.json`** manifest per demo. Each entry has voiceover text at the root level and an optional `overlay` sub-object:

```json
{
  "scene": "hero",
  "text": "Meet Argo.",
  "voice": "nova",
  "overlay": {
    "type": "headline-card",
    "title": "One command. Full demo.",
    "placement": "top-right",
    "motion": "slide-in"
  }
}
```

`showOverlay` and `withOverlay` now resolve overlay content from the manifest at runtime — demo scripts only provide duration and action callbacks:

```ts
// Before: inline overlay objects in every call
await showOverlay(page, 'hero', { type: 'headline-card', title: '...' }, duration);

// After: content comes from .scenes.json
await showOverlay(page, 'hero', duration);
```

Full inline cues are still supported for backward compatibility.

## Preview UI Redesign

The `argo preview` browser-based editor has been rebuilt with a clean instrument panel aesthetic:

- **Collapsible scene cards** — scenes start collapsed, expand on click, auto-expand during playback
- **Conditional overlay fields** — only shows fields relevant to the current overlay type
- **Live overlay preview** — edits update the video overlay layer in real time without saving to disk
- **Dirty state indicator** — Save button turns amber when you have unsaved changes
- **Per-scene undo** — revert any scene to its last saved state
- **Re-record button** — run the full pipeline from preview with one click
- **Scene transport** — play/pause icons, -250ms/+250ms nudge, scene scrub slider
- **Toggle switches** — audio and overlay visibility with styled toggle switches
- **Click-to-pause** — click the video to pause/resume
- **Timeline playhead** — moving vertical line tracks playback position
- **Scenes/Metadata tabs** — sidebar tabs for scene editing and pipeline metadata
- **PREVIEW badge** — distinguishes editable overlay layer from baked-in video overlays

## Video Seeking Fix

Preview now serves the exported MP4 (with H.264 keyframes) instead of the raw Playwright WebM, and supports HTTP Range requests. This fixes video seeking which was previously broken (browser couldn't seek in keyframe-less WebM without byte-range support).

## Pipeline Metadata

Each pipeline run now writes a `<demo>.meta.json` sidecar alongside the video:

```json
{
  "demo": "showcase",
  "createdAt": "2026-03-16T15:30:00Z",
  "tts": { "engine": "openai", "model": "gpt-4o-mini-tts", "instructions": "..." },
  "video": { "width": 3840, "height": 2160, "browser": "webkit" },
  "scenes": [{ "scene": "hero", "voice": "nova", "speed": 0.9, "durationMs": 9550 }]
}
```

The preview Metadata tab displays this information so you can track which voices, engines, and settings produced each video.

## OpenAI TTS Improvements

- `model` field now accepts any string (supports `gpt-4o-mini-tts` and future models)
- New `instructions` option for system-prompt-capable models

```ts
engines.openai({
  model: 'gpt-4o-mini-tts',
  instructions: 'Speak clearly and confidently.'
})
```

## Other Changes

- `argo init` scaffolds `.scenes.json` instead of separate manifests
- `argo validate` checks the unified manifest
- `argo tts generate` accepts `.scenes.json` paths
- All demo scripts (showcase, preview-demo, voice-clone) migrated to manifest-based overlays
- Overlay visibility scoped to scene bounds (no bleeding into next scene)
- Historical design docs cleaned up

## Demo Videos

- [Preview demo (4K, OpenAI nova voice)](videos/preview-demo.mp4) — showcases the redesigned preview UI

## Breaking Changes

- `.voiceover.json` and `.overlays.json` files are no longer supported — migrate to `.scenes.json`
- `argo tts generate` expects `.scenes.json` format
