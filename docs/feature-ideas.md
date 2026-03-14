# Feature Ideas

This is a lightweight roadmap note for future Argo work. It is intentionally practical: each item is here because it would improve authoring speed, output quality, or reliability.

## Near Term

- Manifest-driven overlays. Make `.overlays.json` a first-class authoring path so non-code visual edits are possible.
- `argo doctor`. Check `ffmpeg`, Playwright browsers, quality settings, missing assets, broken config, and common environment issues before a run.
- `argo lint`. Validate `voiceover.json`, `overlays.json`, `narration.mark()` coverage, duplicate scenes, missing scenes, and likely sync problems.
- Subtitle export. Generate `.srt` and `.vtt` alongside the MP4, not just burned-in captions.
- Scene report. After `pipeline`, emit a small JSON or HTML report with scene durations, waits, overflows, and final output timings.

## High-Leverage Product Features

- Camera language. Add zoom-to-element, pan, focus ring, blur-outside-target, and spotlight helpers so demos feel directed, not just recorded.
- Multi-format export. Support `16:9`, `1:1`, and `9:16` from the same source demo, with overlay reflow and safe areas.
- Resumable pipeline. Cache per-step artifacts so changing one voice line or one scene does not force a full rerun.
- Per-scene transitions. Add fades, wipes, hold-freezes, and section bumpers so the final result feels more editorial.
- Theme packs for overlays. Provide reusable visual styles like `terminal`, `product-keynote`, `minimal-docs`, and `launch-trailer`.

## Longer Horizon

- Timeline preview UI. A lightweight local viewer showing scenes, overlays, and narration lengths before rendering.
- AI assist for demo polish. Suggest shorter copy, better scene splits, improved pacing, and stronger overlay placement.
- Auto social package. Export MP4 plus thumbnail, transcript, title ideas, subtitle variants, and aspect-ratio cuts in one command.

## Suggested Priority

If only a few items move forward soon, the strongest sequence is:

1. `argo lint`
2. Manifest-driven overlays
3. Multi-format export

That order keeps the roadmap grounded in Argo's current strengths: reliable demo pipelines, better authoring ergonomics, and more useful outputs from the same source material.
