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

- Smart reframing for `9:16` and `1:1`
- Scene-safe title placement by aspect ratio
- Alternate pacing/export presets by destination

## Priority Order

If Argo only does a few FFmpeg-native upgrades next, these are the best bets:

1. **Post-export camera moves**
   - Why: browser `zoomTo()` is the clearest current example of something better done after capture.
2. **Better transitions**
   - Why: transitions affect the whole polish level and are already part of the product story.
3. **Blur-fill + smarter reframing**
   - Why: multi-format export is already shipped, but current center-crop is blunt.
4. **Audio ducking + loudnorm**
   - Why: immediately improves perceived production quality.
5. **Freeze-frame hold + title-card beats**
   - Why: strong editorial payoff without requiring a full compositor.

## Effort Breakdown

## Easy

- Loudness normalization
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

- Blur-fill / gradient-fill for alternate aspect ratios
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

- Post-export camera moves
  - FFmpeg primitives: crop + scale + motion expressions
  - Why hard: requires stable target coordinates and scene-aware interpolation.
  - Suggested API:
    ```json
    {
      "scene": "camera",
      "post": [
        {
          "type": "camera-move",
          "target": "#effect-focus-ring",
          "move": "push-in",
          "durationMs": 1400,
          "scale": 1.18
        }
      ]
    }
    ```

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

The best immediate next move is:

1. **post-export camera moves**
2. **blur-fill + smart reframing**
3. **audio loudnorm + ducking**

That sequence would improve both:

- Argo’s weakest current polish edges
- Argo’s most visible output quality in showcase videos

It also avoids trying to turn browser-time effects into something they are not.
