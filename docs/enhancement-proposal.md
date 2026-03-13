# Enhancement Proposal: Editorial Overlay System

## Summary

Argo's current caption system is functional but limited. It renders a single bottom-centered text block with one visual treatment, which is enough for basic narration subtitles but not enough for editorial demo videos like `/Users/shreyas/Desktop/demo2-x-captioned.mp4`.

That reference video works because the text feels composed into the frame: top-left headline cards, stronger hierarchy, better spacing, and occasional visual overlays that explain the product rather than just transcribe narration.

This proposal is to evolve Argo from a simple caption helper into an overlay system.

## Goals

- Make captions feel designed, not appended.
- Support editorial overlays such as headline cards, callouts, and image-backed panels.
- Keep narration timing and overlay visuals separate so demos stay easy to author.
- Preserve a simple default path for users who only want subtitles.

## Current Limitations

- One overlay type only: a single fixed bottom pill.
- No support for multiple placements.
- No support for images, diagrams, or rich cards.
- No animation presets beyond appearing and disappearing.
- Caption rendering is too tightly shaped around plain text helpers.

## Proposed Enhancements

- Introduce an overlay cue model instead of a single caption style.
- Support initial cue templates:
  - `lower-third`
  - `headline-card`
  - `anchored-callout`
  - `image-card`
- Add placement zones such as `top-left`, `top-right`, `bottom-center`, and `right-rail`.
- Separate timing from presentation:
  - `narration.mark()` remains the timing source.
  - A new manifest maps scenes to overlay cues.
- Add support for local assets:
  - images
  - diagrams
  - screenshots
- Add motion presets:
  - fade-up
  - slide-in
  - staggered kicker/title/body reveal
- Add theme tokens for typography, spacing, color, blur, border radius, and shadow so overlays can match the product being recorded.

## Proposed Authoring Model

```json
[
  {
    "scene": "browse",
    "type": "headline-card",
    "placement": "top-left",
    "kicker": "LOCAL EXECUTION",
    "title": "WebGPU + Transformers.js. No server. No API calls.",
    "body": "Models cache after first load."
  },
  {
    "scene": "rerank",
    "type": "image-card",
    "placement": "right-rail",
    "src": "assets/rerank-diagram.png",
    "title": "Cross-encoder reranking",
    "body": "Final ranking blends retrieval signals with semantic scoring."
  }
]
```

## Implementation Plan

1. Refactor `src/captions.ts` into a reusable overlay renderer with template support.
2. Keep subtitle-style captions as one built-in template instead of the only template.
3. Add a scene-to-overlay manifest and load it during recording.
4. Support asset injection for local images by converting them into safe browser-renderable URLs.
5. Add motion presets and theme variables.
6. Update `init`, `README.md`, and example demos to use the new model.

## Expected Outcome

Argo will be able to produce demo videos that feel closer to motion-designed product explainers, not just screen recordings with subtitles. That should materially improve clarity, perceived quality, and the usefulness of the tool for product launches, demos, and social clips.
