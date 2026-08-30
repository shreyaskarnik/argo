# Configuration & Video Quality Reference

## Config File

File: `argo.config.mjs` (use `.mjs` to avoid ESM warnings in non-module projects).

```javascript
import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  blocksDir: 'blocks',        // where `argo add` installs hyperframes registry items (git-tracked)
  // registry: { url: '...' }, // override the hyperframes registry for `argo add`
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'chromium',         // chromium + jpeg-stitch is the highest-quality path (v0.35+)
    captureMode: 'jpeg-stitch',  // CDP-direct paint-time capture; bypasses Playwright's VP8 encoder
    deviceScaleFactor: 2,        // 4K capture → lanczos downscale; auto-clamps to 1 on non-chromium
  },
  export: {
    preset: 'slow',           // ffmpeg preset: slower = smaller file
    crf: 16,                  // quality: 16-28 (lower = higher quality)
    thumbnailPath: 'assets/logo-thumb.png',  // optional MP4 cover art
    transition: { type: 'fade-through-black', durationMs: 400 }, // scene transitions
    speedRamp: { gapSpeed: 2.0, minGapMs: 500 },                // speed up gaps between scenes
    formats: ['gif', '9:16'],                                     // additional export formats
  },
  overlays: {
    autoBackground: true,     // auto-detect dark/light for overlay contrast
    // allowRawGsap: true,    // enable `motion.raw` escape hatch (off by default)
  },
});
```

All fields are optional — `defineConfig()` merges with sensible defaults.

## Dark Mode Recording

Three ways to record in dark mode, depending on scope:

**Per-demo (simplest)** — call `emulateMedia` before navigating:

```typescript
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto('/');
```

**All demos via config** — add `contextOptions` under `video`:

```javascript
video: {
  width: 1920,
  height: 1080,
  contextOptions: {
    colorScheme: 'dark',
  },
},
```

**Per-test directive** — in the demo script:

```typescript
test.use({ colorScheme: 'dark' });
```

The `emulateMedia` approach is best for a single demo. Use `contextOptions` in config when all demos should default to dark mode.

## Playwright Tricks for Better Demos

Argo demo scripts are standard Playwright — all Playwright APIs work. For advanced techniques (device emulation, API mocking, geolocation, network throttling, permissions, etc.), fetch the latest Playwright docs rather than relying on stale examples:

**Useful Playwright capabilities for demos:**

- `page.emulateMedia({ reducedMotion: 'reduce' })` — disable CSS animations that conflict with overlay timing
- `page.route('**/api/data', route => route.fulfill({ json: {...} }))` — mock API responses for consistent demo data
- `page.evaluate(() => window.scrollTo({ top: 500, behavior: 'smooth' }))` — smooth scroll (Playwright's default is instant)
- `test.use({ ...devices['iPhone 15 Pro'] })` — device emulation
- `test.use({ permissions: ['clipboard-read', 'notifications'] })` — pre-grant permissions to avoid popups

**Wait strategies:** Prefer deterministic waits (`waitForLoadState`, `waitForSelector`, `waitForURL`, `waitForResponse`) over `waitForTimeout`. Use `waitForTimeout` only for deliberate pacing pauses between scenes, not for waiting on app state.

For the full API, consult the Playwright docs at <https://playwright.dev/docs/api/class-page>.

## Browser Quality on macOS

**Chromium with `captureMode: 'jpeg-stitch'` is the highest-quality path (v0.35+).** It uses a CDP-direct screencast with paint-time frame timing and bypasses Playwright's VP8 encoder entirely, sidestepping the legacy chromium capture quality issue ([playwright#31424](https://github.com/microsoft/playwright/issues/31424)).

webkit and firefox remain solid for the default `webm` capture. They auto-downgrade `jpeg-stitch → webm` (firefox `onFrame` only sustains ~3fps) and auto-clamp `deviceScaleFactor → 1` (neither honors `--force-device-scale-factor`) with loud warnings — so a chromium-tuned config still runs cleanly on those browsers, just at lower fidelity.

## High-DPI Recording

`video.deviceScaleFactor: 2` captures at 2x resolution; export downscales with lanczos for sharper output. **Chromium-only** in practice — auto-clamped to 1 on webkit/firefox because they don't honor `--force-device-scale-factor` (the page renders at 1x while the screencast captures at the 2x viewport, leaving the right + bottom of every frame as gray padding).

## 5K Displays and 4K Exports

On a 5K monitor, 1080p exports look soft at fullscreen. Judge quality at 1:1 size, or export higher resolution for flagship demos.

Recommended presets:

- Everyday demos / social clips: `1920x1080` or `2560x1440`
- Showcase videos on large Retina displays: `3840x2160`, `deviceScaleFactor: 1`

```javascript
// 4K showcase config
video: {
  width: 3840,
  height: 2160,
  fps: 30,
  browser: 'webkit',
  deviceScaleFactor: 1,
}
```

## Scene Transitions

Add smooth transitions between scenes during export:

| Type | Effect |
|------|--------|
| `fade-through-black` | Fade out to black, then fade in at scene boundary |
| `dissolve` | Quick opacity dip (simulates crossfade on continuous footage) |
| `wipe-left` | Left-to-right directional transition |
| `wipe-right` | Right-to-left directional transition |

```javascript
export: { transition: { type: 'fade-through-black', durationMs: 500 } }
```

## Speed Ramp

Compress gaps between scenes (navigation, page loads) to keep demos tight:

```javascript
export: { speedRamp: { gapSpeed: 2.0, minGapMs: 500 } }
```

- `gapSpeed` — multiplier for inter-scene gap playback (2.0 = 2× faster)
- `minGapMs` — minimum gap duration before speed ramp is applied (default 500ms)
- Both video and audio are sped up together (alignment stays correct within scenes)
- Applied as a post-processing ffmpeg pass after main export

## Multi-Format Export

Export additional formats alongside the main 16:9 MP4:

```javascript
export: { formats: ['1:1', '9:16', 'gif'] }
```

- `1:1` — Square crop (centered horizontally) for Instagram/LinkedIn
- `9:16` — Vertical crop (centered) for TikTok/Reels
- `gif` — Two-pass palette-optimized animated GIF (10fps, 640px wide) for docs/READMEs

## Batch Pipeline

Build all demos in one command:

```bash
npx argo pipeline --all
```

Discovers all `.scenes.json` files in `demosDir`, runs the full pipeline for each sequentially, and reports success/failure counts. Continues on failure — one broken demo won't block the rest.

## Dashboard

View all demos at a glance:

```bash
npx argo preview
```

Opens a multi-demo dashboard listing every discovered demo with:
- Build status (script, manifest, video exported)
- Video file size and last modified date
- Resolution and browser from `.meta.json`
- System dark/light mode support

## Pipeline Output

After a successful run:

- `videos/<name>.mp4` — final video with embedded chapter markers
- `videos/<name>.gif` — animated GIF (if `formats` includes `'gif'`)
- `videos/<name>.1x1.mp4` — square crop (if `formats` includes `'1:1'`)
- `videos/<name>.9x16.mp4` — vertical crop (if `formats` includes `'9:16'`)
- `videos/<name>.srt` — SRT subtitles
- `videos/<name>.vtt` — WebVTT subtitles
- `videos/<name>.meta.json` — provenance (TTS engine, voices, resolution, export settings)
- `.argo/<name>/scene-report.json` — scene timing report

## Gitignore

Add these to `.gitignore`:

```
.argo/
videos/
test-results/
```

## Cleanup

```bash
rm -rf .argo/<name>/         # All artifacts for one demo
rm -rf .argo/<name>/clips/   # Just TTS clips (forces re-generation)
rm -rf .argo/                # Everything
```
