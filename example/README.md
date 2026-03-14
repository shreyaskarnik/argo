# Argo Example

A self-contained example that records a demo video of Argo's own showcase page.

## What's inside

```
example/
├── app.html                          # Argo showcase page (the thing being demo'd)
├── demos/hello-world.demo.ts         # Playwright script with narration + overlays
├── demos/hello-world.voiceover.json  # Voiceover text for each scene
├── argo.config.mjs                   # Argo configuration
└── package.json                      # Dependencies
```

## Quick start

```bash
# Install dependencies + Playwright browsers
npm install
npx playwright install webkit

# Start the page server (in a separate terminal)
npm run serve

# Validate scene names match (optional dry run)
npm run demo:validate

# Record the demo video
npm run demo
```

The finished video will be in `videos/hello-world.mp4`.

## What happens

1. **Brewing** — Kokoro generates voiceover clips from `hello-world.voiceover.json`
2. **Rolling** — Playwright opens the showcase page, scrolls through sections, shows overlays
3. **Mixing** — Voiceover clips are placed at each scene's recorded timestamp
4. **Cutting** — ffmpeg merges the screen recording + narration into an MP4

## Anatomy of a demo

**Demo script** (`demos/hello-world.demo.ts`):
- Imports `test` from `@argo-video/cli` (not `@playwright/test`)
- Uses `narration.mark('scene-name')` to define scene boundaries
- Uses `narration.durationFor('scene-name')` for timing based on voiceover length
- Uses `showOverlay()` / `withOverlay()` for on-screen annotations
- Uses `showConfetti()` for the mic-drop moment

**Voiceover manifest** (`demos/hello-world.voiceover.json`):
- Each `scene` must exactly match a `narration.mark()` call
- `text` is spoken only (never displayed) — use phonetic spelling for tricky words
- `voice`: `af_heart` (female, default) or `am_michael` (male)
- `speed`: 0.9-1.0 works well for narration

**Config** (`argo.config.mjs`):
- Uses `defineConfig()` for type-safe defaults
- `webkit` browser for best video quality on macOS
- `autoBackground: true` for contrast-aware overlays
