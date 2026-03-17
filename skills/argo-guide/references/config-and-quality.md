# Configuration & Video Quality Reference

## Config File

File: `argo.config.mjs` (use `.mjs` to avoid ESM warnings in non-module projects).

```javascript
import { defineConfig } from '@argo-video/cli';

export default defineConfig({
  baseURL: 'http://localhost:3000',
  demosDir: 'demos',
  outputDir: 'videos',
  tts: { defaultVoice: 'af_heart', defaultSpeed: 1.0 },
  video: {
    width: 1920,
    height: 1080,
    fps: 30,
    browser: 'webkit',        // webkit > firefox > chromium on macOS
    // deviceScaleFactor: 2,  // 2x capture (known issue with webkit)
  },
  export: {
    preset: 'slow',           // ffmpeg preset: slower = smaller file
    crf: 16,                  // quality: 16-28 (lower = higher quality)
    thumbnailPath: 'assets/logo-thumb.png',  // optional MP4 cover art
  },
  overlays: {
    autoBackground: true,     // auto-detect dark/light for overlay contrast
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

Video capture quality varies by engine: **webkit > firefox > chromium**. Chromium has a known capture quality issue ([playwright#31424](https://github.com/microsoft/playwright/issues/31424)). Use `--browser webkit` or `video.browser: 'webkit'` for best results.

## High-DPI Recording

`video.deviceScaleFactor: 2` captures at 2x resolution; export downscales with lanczos for sharper output.

**Known issue**: `deviceScaleFactor: 2` causes rendering issues with webkit (viewport at 1/4 of frame). Stick to `deviceScaleFactor: 1` until fixed.

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

## Pipeline Output

After a successful run:

- `videos/<name>.mp4` — final video with embedded chapter markers
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
