# Argo: npm Rename, Agent Skill, and Showcase Video

**Date:** 2026-03-13
**Status:** Approved

## Overview

Three deliverables that prepare Argo for public distribution and AI-agent usage:

1. Rename npm package to `@argo-video/cli`
2. Create a Claude Code skill for agents to use Argo
3. Build a self-referential showcase demo video

## 1. npm Package: `@argo-video/cli`

### Changes

- `package.json` `name` field → `@argo-video/cli`
- `bin.argo` remains unchanged (CLI command stays `argo`)
- Users install: `npm i -D @argo-video/cli`
- Users import: `import { test } from '@argo-video/cli'`

### Files to update

- `package.json` — name field
- `src/init.ts` — scaffolded `example.demo.ts` template uses `@argo-video/cli` in imports
- `tests/init.test.ts` — update assertions to match new import path
- Any docs or README references to the package name

### Future namespace

The `@argo-video` org allows future packages: `@argo-video/core`, `@argo-video/skill`, etc.

## 2. Skill: `argo-demo-creator`

### Purpose

Teaches Claude Code agents how to use Argo — from installation through finished video.

### Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Autonomous** | "Create a demo video for this app" | Agent installs Argo, writes demo script, overlay/voiceover manifests, configures, runs pipeline |
| **Assistive** | "How do I..." / help with existing scripts | Agent provides guidance, fixes scripts, explains config |

### Skill sections

1. **Prerequisites check** — Is `@argo-video/cli` installed? Is there `argo.config.js`? If not, run `argo init`.
2. **App context** — Requires a running app with a known `baseURL`. Agent asks user for URL.
3. **Script authoring** — How to write `.demo.ts` files: Playwright actions + `narration.mark()` for scene boundaries.
4. **Overlays** — `showOverlay`/`withOverlay` API, template types (`lower-third`, `headline-card`, `callout`, `image-card`), zones, motion presets. Overlay manifest format (`.overlays.json`).
5. **Voiceover** — Voiceover manifest format (`.voiceover.json`): `scene`, `text`, optional `voice`/`speed`.
6. **Config reference** — `argo.config.js` fields: `baseURL`, `demosDir`, `outputDir`, `tts`, `video`, `export`.
7. **Pipeline execution** — `argo record <demo>` → `argo tts generate <manifest>` → `argo export <demo>`, or `argo pipeline <demo>` for all-in-one.
8. **Troubleshooting** — Common errors: no video found (check Playwright video config), no timing file (need `narration.mark()` calls), ffmpeg not installed.

### Autonomous workflow

```
1. Check if @argo-video/cli is installed → install if not
2. Check if argo.config.js exists → run `argo init` if not
3. Ask user for baseURL of their running app
4. Explore the app (optionally navigate it to understand routes/features)
5. Write <demo>.demo.ts with Playwright actions + narration marks
6. Write <demo>.voiceover.json with scene narration text
7. Write <demo>.overlays.json with overlay cues (optional)
8. Run `npx argo pipeline <demo>`
9. Report output video path
```

## 3. Showcase Video

### Concept

Self-referential: Argo creates a demo video of Argo. Records against a static HTML landing page for Argo itself.

### Files

- `demos/showcase.html` — Static landing page for Argo. Clean, modern design. Sections: hero ("Turn Playwright scripts into polished demo videos"), features (overlays, voiceover, pipeline), code example, CTA.
- `demos/showcase.demo.ts` — Demo script that navigates the landing page, scrolls through sections, clicks interactive elements.
- `demos/showcase.voiceover.json` — Narration explaining what Argo does at each scene.
- `demos/showcase.overlays.json` — Overlay cues demonstrating multiple template types:
  - `lower-third` with fade-in on the hero section
  - `headline-card` with slide-in for the features section
  - `callout` for highlighting a specific UI element
- `demos/assets/` — Any images needed for the showcase page

### Showcase page design

Simple, single-page HTML with inline CSS. Sections:
1. **Hero** — "Argo" title, tagline, terminal-style animation showing the pipeline command
2. **How it works** — Three-step flow: Write → Record → Export
3. **Features** — Cards for overlays, voiceover, config
4. **Code example** — Syntax-highlighted demo script snippet

### Pipeline

The showcase runs against a local file server (or `file://` protocol). Config sets `baseURL` to the local server serving `demos/showcase.html`.

## Execution Order

1. **npm rename** — Update package name, imports, templates, tests
2. **Showcase demo** — Create landing page + demo files, run pipeline to produce video
3. **Skill creation** — Write the skill referencing correct package name and real examples
