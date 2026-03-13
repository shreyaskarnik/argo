# Enhancement Proposal: Editorial Overlay System

## Summary

Argo's current caption system renders a single bottom-centered text pill. That's enough for narration subtitles but not for editorial demo videos where text feels composed into the frame — headline cards with kicker/title/body hierarchy, callout annotations, image-backed panels at different screen positions.

This proposal evolves `src/captions.ts` from a single-style caption helper into a zone-based overlay system with pluggable templates.

## Goals

- Make captions feel designed, not appended.
- Support editorial overlays: headline cards, callouts, image-backed panels.
- Keep narration timing and overlay visuals separate so demos stay easy to author.
- Preserve the simple default path — `showCaption` and `withCaption` continue to work unchanged.

## Current System

```
captions.ts
├── OVERLAY_ID = 'argo-caption-overlay'     ← single element, replaced on each call
├── CAPTION_STYLES = { ... }                ← one hardcoded style object
├── injectOverlay(page, text)               ← creates div, sets textContent + styles
├── showCaption(page, scene, text, dur)     ← inject → wait → remove
├── withCaption(page, scene, text, action)  ← inject → action → remove (try/finally)
└── hideCaption(page)                       ← remove by ID
```

Limitations:
- One overlay type, one placement, one visual treatment.
- Single DOM element — showing a new caption removes the previous one globally.
- No support for images, rich cards, or animation.
- No way to have two overlays visible simultaneously (e.g., subtitle + headline card).

## Design Decisions

### Zone-based coexistence

Overlays are placed into **zones**. Each zone is a screen region that holds at most one overlay at a time. Showing an overlay in a zone automatically replaces any existing overlay in that zone, but overlays in different zones coexist independently.

Zones:
- `bottom-center` (default — current caption position)
- `top-left`
- `top-right`
- `bottom-left`
- `bottom-right`
- `center`

DOM IDs become `argo-overlay-{zone}` instead of the current single `argo-caption-overlay`.

This gives editorial power (subtitle + headline card visible simultaneously) without requiring manual dismissal of every overlay.

### Asset injection via local server

Image overlays (`image-card`) reference local files like `assets/diagram.png`. These need to be accessible inside the Playwright browser context.

**Approach: local asset server.** A tiny HTTP server (same pattern as the E2E fake server) serves files from the project's asset directory during recording. It starts automatically before `record` and stops after.

Why not base64 data URIs: a 2MB screenshot becomes ~2.7MB of serialized DOM, slowing `page.evaluate`. Asset server keeps the DOM clean and scales to many images.

### Templates, not a theme system

v1 ships with hardcoded visual presets per template — no theme tokens. Each template has one opinionated look that works well on dark and light backgrounds. Theme customization (typography, colors, spacing tokens) is a future enhancement once real usage patterns emerge.

### Motion: two presets only

CSS animations during Playwright recording are frame-rate dependent. v1 supports two safe presets:
- `fade-in` — opacity 0→1 over 300ms
- `slide-in` — translateX + opacity over 400ms

Staggered multi-element reveals (kicker, then title, then body) are deferred to v2 — they require careful timing coordination that's hard to get right at variable recording FPS.

## Overlay Templates

### `lower-third` (default)

The current caption style, refined. Bottom-center translucent pill with text.

```
┌─────────────────────────────────────────┐
│                                         │
│                                         │
│                                         │
│    ┌─────────────────────────────┐      │
│    │  Caption text here          │      │
│    └─────────────────────────────┘      │
└─────────────────────────────────────────┘
```

Fields: `text`

### `headline-card`

A card with optional kicker (small caps label), title (large), and body (smaller). Backdrop blur + translucent background.

```
┌─────────────────────────────────────────┐
│  ┌──────────────────────┐               │
│  │  KICKER LABEL        │               │
│  │  Title text here     │               │
│  │  Body text here      │               │
│  └──────────────────────┘               │
│                                         │
└─────────────────────────────────────────┘
```

Fields: `kicker?`, `title`, `body?`

### `callout`

A compact annotation bubble for pointing out UI elements. Meant for short text.

Fields: `text`

### `image-card`

An image with optional title and body caption below it. Image loaded from the asset server.

```
┌─────────────────────────────────────────┐
│               ┌─────────────────┐       │
│               │  ┌───────────┐  │       │
│               │  │   image   │  │       │
│               │  └───────────┘  │       │
│               │  Title          │       │
│               │  Body text      │       │
│               └─────────────────┘       │
└─────────────────────────────────────────┘
```

Fields: `src`, `title?`, `body?`

## Authoring Model

### Overlay manifest (`demos/example.overlays.json`)

A new file, separate from the voiceover manifest. Maps scenes to overlay cues.

```json
[
  {
    "scene": "intro",
    "type": "lower-third",
    "text": "Hacker News — the front page of the internet"
  },
  {
    "scene": "browse",
    "type": "headline-card",
    "placement": "top-left",
    "kicker": "LOCAL EXECUTION",
    "title": "WebGPU + Transformers.js",
    "body": "Models cache after first load.",
    "motion": "slide-in"
  },
  {
    "scene": "rerank",
    "type": "image-card",
    "placement": "top-right",
    "src": "assets/rerank-diagram.png",
    "title": "Cross-encoder reranking"
  }
]
```

Rules:
- `scene` links to `narration.mark()` calls in the demo script.
- `type` selects the template. Default: `lower-third`.
- `placement` selects the zone. Default: `bottom-center`.
- `motion` selects the entrance animation. Default: none (instant appear).
- Template-specific fields (`kicker`, `title`, `body`, `src`, `text`) vary by type.

### Programmatic API

The existing `showCaption`/`withCaption` API stays unchanged as sugar for `lower-third` overlays. New overlays are shown via a new function:

```ts
import { showOverlay, hideOverlay, withOverlay } from 'argo';

// Show a headline card in the top-left zone
await showOverlay(page, 'browse', {
  type: 'headline-card',
  placement: 'top-left',
  kicker: 'LOCAL EXECUTION',
  title: 'WebGPU + Transformers.js',
  motion: 'slide-in',
}, 4000);

// Hide a specific zone
await hideOverlay(page, 'top-left');

// Overlay around an action
await withOverlay(page, 'rerank', {
  type: 'image-card',
  placement: 'top-right',
  src: 'assets/diagram.png',
  title: 'Reranking pipeline',
}, async () => {
  await page.click('.rerank-button');
});
```

Backward compatibility: `showCaption(page, scene, text, dur)` becomes equivalent to `showOverlay(page, scene, { type: 'lower-third', text }, dur)`.

### Auto-overlay from manifest

When a `<demo>.overlays.json` file exists alongside the voiceover manifest, the recording fixture automatically injects overlays at their matching `narration.mark()` timestamps. This means users can define overlays purely in JSON without touching the demo script — the programmatic API is for advanced use only.

## Implementation Plan

### Phase 1: Zone-based overlay renderer

1. Refactor `src/captions.ts` → `src/overlays.ts`
   - Replace single `OVERLAY_ID` with `argo-overlay-{zone}` scheme
   - Extract template rendering into a `renderTemplate(type, fields)` → HTML+styles function
   - Implement `lower-third` template (current caption style, now zone-aware)
   - Implement `showOverlay`, `hideOverlay`, `withOverlay`
   - Re-export `showCaption`, `withCaption`, `hideCaption` as thin wrappers

2. Add CSS animation injection for `fade-in` and `slide-in` presets

3. Update `src/index.ts` exports

### Phase 2: Editorial templates

4. Implement `headline-card` template (kicker + title + body, backdrop blur)
5. Implement `callout` template
6. Implement `image-card` template

### Phase 3: Asset server + image support

7. Extract `tests/e2e/fake-server.ts` pattern into `src/asset-server.ts`
   - Serves files from a configurable asset directory
   - Auto-starts before recording, auto-stops after
   - Only starts if an overlay manifest references image assets

8. Wire asset server URL into `image-card` template `src` resolution

### Phase 4: Manifest-driven overlays

9. Define overlay manifest schema and loader in `src/overlays/manifest.ts`
10. Wire manifest loading into the recording fixture
    - If `<demo>.overlays.json` exists, auto-inject overlays at matching scene marks

### Phase 5: Polish

11. Update `argo init` templates with overlay examples
12. Update README with overlay documentation
13. Add tests for each template, zone management, and manifest loading

## Migration

- `showCaption`, `withCaption`, `hideCaption` remain exported and unchanged.
- Existing demos work without modification.
- The overlay manifest is optional — demos without one behave exactly as before.
- `src/captions.ts` is replaced by `src/overlays.ts` but all original exports are preserved.

## Out of Scope (v1)

- Theme tokens / custom styling
- Staggered multi-element animation
- Overlay transitions (exit animations)
- Overlay positioning relative to DOM elements (e.g., "anchor to this button")
- Video-time overlays via ffmpeg (all overlays render in-browser during recording)
