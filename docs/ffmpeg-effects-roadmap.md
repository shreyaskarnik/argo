# FFmpeg Effects Roadmap

This note is about **post-export video craft**, not browser-time capture helpers.

The core distinction:

- **Browser effects** are about what happens during capture.
- **FFmpeg effects** are about how the final video feels.

That matters for Argo because some effects are clunky or brittle in-browser but become much stronger when treated as timeline-aware post work.

## Effect Categories

### Editorial / Motion

- Better transitions: zoom-in, slide, circle reveal, pixelize, blur dissolve, directional pushes
- Freeze frame + hold
- Per-scene slow-in / fast-out
- Motion blur on fast ramps
- Stutter / echo frames

### Camera / Focus

- Post-export zooms and pans
- Spotlight blur
- Background vignette / edge dim
- Magnifier effect
- Split focus

### Compositing

- Picture-in-picture
- Device frames
- Blur-fill or gradient-fill for `9:16` / `1:1`
- Animated image inserts
- Watermark / brand bug

### Text / Graphics

- Title cards and section bumpers
- Kinetic text
- Karaoke-style subtitle highlighting
- Progress chapter bar
- Themeable lower-thirds

### Color / Finish

- LUTs / color grades
- Contrast / saturation shaping
- Glow / bloom
- Film grain / texture
- Sharpening tuned for screen recordings

### Audio

- Background music ducking
- Loudness normalization
- Compression / EQ
- Scene-based audio fades
- Emphasis hits / reverb accents

### Multi-Format

- ~~Smart reframing for `9:16` and `1:1`~~ → **Viewport-native recording** is the better path. Instead of post-processing a 16:9 recording (blur-fill or crop), re-record at the target viewport so CSS handles layout natively. Blur-fill shipped in v0.18.0 as a quick fallback, but content isn't readable at extreme aspect ratios. The real solution:

  ```js
  export: {
    variants: [
      { name: '16x9', video: { width: 1920, height: 1080 } },
      { name: '9x16', video: { width: 1080, height: 1920 } },
      { name: '1x1',  video: { width: 1080, height: 1080 } },
    ]
  }
  ```

  Pipeline runs TTS once, then records + exports per variant. Demo script stays identical.
- Scene-safe title placement by aspect ratio
- Alternate pacing/export presets by destination

## Priority Order

### Already shipped

1. ~~**Post-export camera moves**~~ **SHIPPED** — `zoompan` filter with `in_time` expressions
2. ~~**Loudness normalization**~~ **SHIPPED** — `loudnorm` EBU R128
3. ~~**Blur-fill + viewport variants**~~ **SHIPPED** — blur-fill fallback + viewport-native re-recording
4. ~~**Scene transitions**~~ **SHIPPED** — fade-through-black, dissolve, wipe-left/right (split+trim+fade+concat)

### Validated next priorities

1. **Background music + ducking** — cleanest next win. ffmpeg `sidechaincompress` ducks music under narration. Narration track and export pipeline already exist. Immediately improves perceived production quality.
2. **Freeze-frame holds + title-card beats** — `tpad` for clean hold/freeze behavior. Fits Argo's scene model well. Strong editorial tool for launches, CTAs, section changes.
3. **Real `xfade` scene composition** — unlocks more transitions than dip/wipe, but harder timeline problem (both inputs must match fps, resolution, pixel format, timebase). Worth doing after audio ducking and freeze beats.
4. **Watermark / brand bug / device frame / simple PiP** — natural overlay features. Makes outputs campaign-ready without changing the authoring model.
5. **Spotlight blur / vignette** — post-export `boxblur` + `vignette` for final polish, especially for short social exports.

### Lower priority for now

- **drawtext-heavy features** (kinetic text, chapter bars) — powerful but depends on ffmpeg font library availability, adds environment variability
- **tmix / tblend** (motion blur, stutter) — punchy promo moments but not core to the product wedge yet
- **Color grading / LUTs** — useful later, less important than editorial structure and audio polish for screen demos

## Effort Breakdown

## Easy

- ~~Loudness normalization~~ **SHIPPED** — `export.audio.loudnorm: true` applies EBU R128 (-16 LUFS)
  - FFmpeg primitives: `loudnorm`, `volume`, `acompressor`
  - Suggested API:

    ```js
    export: {
      audio: {
        loudnorm: true,
        compression: 'light',
      }
    }
    ```

- Background music ducking
  - FFmpeg primitives: sidechain compression
  - Suggested API:

    ```js
    export: {
      audio: {
        music: 'assets/bed.mp3',
        ducking: { thresholdDb: -24, ratio: 6 }
      }
    }
    ```

- ~~Blur-fill / gradient-fill for alternate aspect ratios~~ **SHIPPED** — `9:16` and `1:1` use blurred background + scaled-to-fit overlay
  - FFmpeg primitives: scale, blur, overlay
  - Suggested API:

    ```js
    export: {
      formats: [
        { type: '9:16', fill: 'blur' },
        { type: '1:1', fill: 'gradient' }
      ]
    }
    ```

- Watermark / brand bug
  - FFmpeg primitives: overlay
  - Suggested API:

    ```js
    export: {
      watermark: {
        src: 'assets/bug.png',
        position: 'bottom-right',
        opacity: 0.8
      }
    }
    ```

## Medium

- Freeze-frame hold
  - FFmpeg primitives: trim, `tpad`, concat
  - Suggested API:

    ```json
    {
      "scene": "cta",
      "post": [{ "type": "freeze", "atMs": 1800, "durationMs": 1200 }]
    }
    ```

- Title cards / bumpers
  - FFmpeg primitives: color source, drawtext, overlay, concat
  - Suggested API:

    ```json
    {
      "scene": "preview",
      "post": [{ "type": "title-card", "title": "Preview", "body": "Edit without re-recording" }]
    }
    ```

- Spotlight blur / vignette
  - FFmpeg primitives: masked blur, boxblur, geq
  - Suggested API:

    ```json
    {
      "scene": "camera",
      "post": [{ "type": "spotlight-blur", "target": "#primary-cta", "blur": 14 }]
    }
    ```

- Smarter reframing
  - FFmpeg primitives: crop, scale, overlay
  - Suggested API:

    ```js
    export: {
      formats: [
        { type: '9:16', framing: 'smart' }
      ]
    }
    ```

- Progress chapter bar
  - FFmpeg primitives: drawbox, timeline expressions
  - Suggested API:

    ```js
    export: {
      progressBar: { chapters: true, position: 'bottom' }
    }
    ```

## Hard

- ~~Post-export camera moves~~ **SHIPPED** — `zoomTo(page, target, { narration })` + `buildCameraMoveFilter()` in `src/camera-move.ts`
  - FFmpeg primitives: `zoompan` with `in_time` expressions (NOT `crop` — crop w/h are not per-frame)
  - Coordinates captured at record time via `boundingBox()`, shifted for headTrim, scaled for deviceScaleFactor
  - Applied in filter_complex AFTER transitions (zoompan's `in_time` must be continuous across concat output)
  - Driven at source recording fps (`getVideoFrameRate()`) to avoid duration mismatch

- Real segmented `xfade` scene composition
  - FFmpeg primitives: scene splitting, overlap planning, `xfade`, audio crossfades
  - Why hard: timeline planning must stay aligned with subtitles, chapters, and scene report.
  - Suggested API:

    ```js
    export: {
      transition: { type: 'push-left', durationMs: 1400 }
    }
    ```

- Karaoke subtitle highlighting
  - FFmpeg primitives: subtitle burn-in or drawtext timing overlays
  - Why hard: needs word-level timing, not just scene-level timing.
  - Suggested API:

    ```js
    export: {
      captions: {
        burnIn: true,
        mode: 'karaoke'
      }
    }
    ```

- Picture-in-picture / before-after compare
  - FFmpeg primitives: multiple inputs, scale, overlay, masks, timed layout
  - Suggested API:

    ```json
    {
      "scene": "compare",
      "post": [
        {
          "type": "pip",
          "src": "assets/before.mp4",
          "position": "top-right",
          "width": 420
        }
      ]
    }
    ```

## Recommended API Shape

Argo should probably expose FFmpeg-native polish in two layers:

### Global Export Config

For effects that apply to the whole video or output format:

```js
export: {
  transition: { type: 'fade-through-black', durationMs: 2000 },
  speedRamp: { gapSpeed: 2.0, minGapMs: 600 },
  formats: [{ type: '9:16', fill: 'blur', framing: 'smart' }],
  audio: { loudnorm: true, music: 'assets/bed.mp3' },
  watermark: { src: 'assets/bug.png', position: 'bottom-right' }
}
```

### Per-Scene Post Effects

For scene-specific editorial shaping:

```json
{
  "scene": "preview",
  "text": "Edit without re-recording.",
  "post": [
    { "type": "freeze", "atMs": 1700, "durationMs": 1000 },
    { "type": "camera-move", "target": "#preview-export", "move": "push-in", "durationMs": 1200 }
  ]
}
```

That split keeps the product understandable:

- global config for export-wide polish
- scene-level `post` effects for editorial beats

## Recommendation

See "Validated next priorities" in the Priority Order section above.

Sources: [ffmpeg filters docs](https://ffmpeg.org/ffmpeg-filters.html) — zoompan, xfade, loudnorm, sidechaincompress, tpad, overlay, boxblur, vignette, drawtext, tmix, tblend.
