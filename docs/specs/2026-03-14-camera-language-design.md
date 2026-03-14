# Camera Language Design

**Date**: 2026-03-14
**Status**: Approved

## Summary

Add a camera language system to Argo — `spotlight`, `focusRing`, `dimAround`, `zoomTo`, and `resetCamera` — that makes demo recordings feel directed rather than just recorded. All functions follow the standalone pattern (`showConfetti`, `showOverlay`) and use `page.evaluate()` for DOM injection.

## API

```typescript
spotlight(page, selector, opts?)    // dark overlay with hole around target
focusRing(page, selector, opts?)    // pulsing glow border on target
dimAround(page, selector, opts?)    // fade siblings to 30% opacity
zoomTo(page, selector, opts?)       // CSS transform scale + center
resetCamera(page)                   // clear all camera effects
```

All non-blocking by default (fire-and-forget safe). `wait: true` to block. Errors from page disposal swallowed, other errors surfaced as warnings.

## Options

- `duration`: ms before auto-cleanup (default: 3000)
- `fadeIn` / `fadeOut`: transition ms (default: 400)
- `wait`: block until done (default: false)
- `spotlight.opacity`: backdrop darkness (default: 0.7)
- `spotlight.padding`: px around target (default: 12)
- `focusRing.color`: ring color (default: '#3b82f6')
- `focusRing.pulse`: animate (default: true)
- `dimAround.dimOpacity`: sibling opacity (default: 0.3)
- `zoomTo.scale`: zoom level (default: 1.5)

## Implementation

- New file: `src/camera.ts`
- Each effect injects via `page.evaluate()`, self-cleans via `setTimeout`
- Spotlight: `clip-path: polygon()` on full-page overlay
- Focus ring: positioned div matching target bounds with `box-shadow`
- Dim around: iterate siblings, apply opacity + transition
- Zoom to: CSS transform on `document.documentElement`
- All elements use `data-argo-camera` attribute for `resetCamera` cleanup
