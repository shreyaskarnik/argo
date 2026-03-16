# Unified Scenes Manifest

**Date:** 2026-03-16
**Status:** Draft

## Problem

Overlay content lives in two places: inline in `.demo.ts` (baked into video pixels) and in `.overlays.json` (editable in preview). The preview can only edit the manifest copy, so changes don't affect the actual recording. Additionally, having separate `.voiceover.json` and `.overlays.json` per demo is unnecessary — both are scene-keyed.

## Design

### Single Manifest: `demos/<name>.scenes.json`

Replaces both `.voiceover.json` and `.overlays.json` with one file:

```json
[
  {
    "scene": "hero",
    "text": "Meet Argo. One command turns a Playwright script into a launch-ready product video.",
    "voice": "af_heart",
    "speed": 0.9,
    "_hint": "Main introduction",
    "overlay": {
      "type": "headline-card",
      "title": "One command. Full demo.",
      "kicker": "PLAYWRIGHT TO VIDEO",
      "body": "AI voiceover and camera direction included.",
      "placement": "top-right",
      "motion": "slide-in",
      "autoBackground": true
    }
  },
  {
    "scene": "tts",
    "text": "Pick your voice. Six engines from local to cloud.",
    "speed": 1.0
  }
]
```

- Voiceover fields (`text`, `voice`, `speed`, `lang`, `_hint`) at root level
- Overlay as nested object (omitted for scenes without overlays)
- `motion` and `autoBackground` move from demo script to manifest

### Manifest-Based Overlay API

`showOverlay` and `withOverlay` resolve overlay content from the manifest at runtime. Demo scripts provide only runtime behavior (duration, action callbacks).

**New signatures (backward compatible):**

```ts
// Manifest-only (new)
await showOverlay(page, 'hero', durationMs);
await withOverlay(page, 'hero', async () => { ... });

// Manifest + runtime overrides (new)
await showOverlay(page, 'hero', { motion: 'slide-in' }, durationMs);

// Full inline cue (existing — backward compat)
await showOverlay(page, 'hero', { type: 'headline-card', title: '...' }, durationMs);
```

**Detection logic:**
- `showOverlay`: 3rd arg is `number` → manifest-only. 3rd arg is object → cue/overrides (merged with manifest if entry exists).
- `withOverlay`: 3rd arg is `function` → manifest-only. 3rd arg is object → cue/overrides, 4th arg is action.

**Manifest loading:**
- Env var `ARGO_OVERLAYS_PATH` set by `src/record.ts`, pointing to `demos/<name>.scenes.json`
- Lazy-loaded on first `showOverlay`/`withOverlay` call, cached at module level
- If no manifest or no entry for scene and no inline cue → throw error

### Demo Script Simplification

```ts
// Before
await showOverlay(page, 'hero', {
  type: 'headline-card',
  kicker: 'PLAYWRIGHT TO VIDEO',
  title: 'One command. Full demo.',
  body: 'AI voiceover and camera direction included.',
  placement: 'top-right',
  motion: 'slide-in',
  autoBackground: true,
}, narration.durationFor('hero', { maxMs: 8000 }));

// After
await showOverlay(page, 'hero', narration.durationFor('hero', { maxMs: 8000 }));
```

## Files to Change

### Core Pipeline

| File | Change |
|------|--------|
| `src/overlays/index.ts` | Add manifest loading, overloaded signatures for showOverlay/withOverlay |
| `src/overlays/types.ts` | Add `SceneEntry` type (unified manifest entry with optional `overlay`) |
| `src/record.ts` | Pass `ARGO_OVERLAYS_PATH` env var pointing to `.scenes.json` |
| `src/pipeline.ts` | Update manifest path references from `.voiceover.json` to `.scenes.json` |
| `src/tts/cache.ts` | Update if it references manifest format |

### Validation & Scaffolding

| File | Change |
|------|--------|
| `src/validate.ts` | Load single `.scenes.json`, validate both voiceover and overlay fields |
| `src/init.ts` | Scaffold `example.scenes.json` instead of two separate files |
| `src/parse-playwright.ts` | `generateScenesSkeleton()` replaces separate voiceover/overlay generators |

### Preview

| File | Change |
|------|--------|
| `src/preview.ts` | Load/save single `.scenes.json`, add motion field to sidebar, split into voiceover array + overlay array internally |

### CLI

| File | Change |
|------|--------|
| `src/cli.ts` | `tts generate` takes `.scenes.json` path, update help text |

### Demos

| File | Change |
|------|--------|
| `demos/showcase.scenes.json` | New unified manifest (replaces `.voiceover.json` + `.overlays.json`) |
| `demos/showcase.demo.ts` | Simplify to manifest-based overlay calls |
| Remove `demos/showcase.voiceover.json` | Replaced |
| Remove `demos/showcase.overlays.json` | Replaced |

### Tests

Update tests for: overlay index (manifest resolution), validate, init, preview, pipeline.

## Migration

Clean break — no legacy `.voiceover.json` / `.overlays.json` support. `argo init` scaffolds the new `.scenes.json` format.

## Non-Goals

- File watching in preview (edit in IDE → auto-reload)
- Demo script editor panel in preview
- Timeline overlay thumbnails
