# npm Rename, Showcase Video, and Agent Skill — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename package to `@argo-video/cli`, create a self-referential showcase demo video, and build a Claude Code skill for AI agents to use Argo.

**Architecture:** Three sequential deliverables. The npm rename updates package identity and all internal references. The showcase creates a static landing page + demo script + overlays + voiceover that runs through Argo's own pipeline. The skill is a markdown file teaching agents the full Argo workflow.

**Tech Stack:** Node.js, TypeScript, Playwright, Vitest, HTML/CSS (showcase page)

---

## Chunk 1: npm Rename

### Task 1: Rename package in package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package name**

Change `name` from `"argo"` to `"@argo-video/cli"` in `package.json`.

```json
"name": "@argo-video/cli",
```

- [ ] **Step 2: Verify build still works**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: rename package to @argo-video/cli"
```

### Task 2: Update init template imports

**Files:**
- Modify: `src/init.ts:19-36` (the `EXAMPLE_DEMO` constant)
- Modify: `tests/init.test.ts:28-29` (assertions checking import paths)
- Modify: `demos/example.demo.ts:1-2` (existing demo file)

- [ ] **Step 1: Update test assertions**

In `tests/init.test.ts`, update the two assertions that check for `'argo'` imports:

```typescript
// Change these two lines:
expect(content).toContain("import { test } from 'argo'");
expect(content).toContain("import { showCaption, withCaption } from 'argo'");

// To:
expect(content).toContain("import { test } from '@argo-video/cli'");
expect(content).toContain("import { showCaption, withCaption } from '@argo-video/cli'");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/init.test.ts`
Expected: FAIL — the template still uses `'argo'`

- [ ] **Step 3: Update EXAMPLE_DEMO in src/init.ts**

Use a targeted string replacement on the `EXAMPLE_DEMO` template string. Replace ONLY the `from 'argo'` import specifiers — do NOT replace or truncate the rest of the template body (lines 22–36 must remain unchanged):

```
Edit: replace `from 'argo'` with `from '@argo-video/cli'` (replace_all: true) in src/init.ts
```

This changes lines 19–20 from:
```typescript
import { test } from 'argo';
import { showCaption, withCaption } from 'argo';
```
to:
```typescript
import { test } from '@argo-video/cli';
import { showCaption, withCaption } from '@argo-video/cli';
```

The rest of the template (the test body with page.goto, narration.mark, showCaption calls) stays exactly as-is.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/init.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Update existing demos/example.demo.ts**

Change the imports in the existing demo file:

```typescript
import { test } from '@argo-video/cli';
import { showCaption, withCaption } from '@argo-video/cli';
```

- [ ] **Step 6: Verify no remaining old imports**

Run: `grep -r "from 'argo'" demos/ src/init.ts`
Expected: No matches

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/init.ts tests/init.test.ts demos/example.demo.ts
git commit -m "chore: update all import paths from 'argo' to '@argo-video/cli'"
```

## Chunk 2: Showcase Demo Video

### Task 3: Create the showcase landing page

**Files:**
- Create: `demos/showcase.html`

- [ ] **Step 1: Create the HTML page**

Create `demos/showcase.html` — a single-page, self-contained HTML file with inline CSS. Design should be clean and modern (dark theme, monospace accents). Sections:

1. **Hero** — "Argo" title in large type. Tagline: "Turn Playwright scripts into polished demo videos with AI voiceover." A terminal-style box showing: `npx argo pipeline my-demo`
2. **How it works** — Three columns: "Write" (demo script icon), "Record" (browser icon), "Export" (video icon). Each with a short description.
3. **Features** — Cards for: Overlays (lower-third, headline cards), Voiceover (AI-generated TTS), Pipeline (one command, end-to-end).
4. **Code example** — A `<pre>` block showing a simplified demo script snippet with syntax coloring via inline styles.

Design constraints:
- All CSS inline in `<style>` tag (no external dependencies)
- Responsive but optimized for 1920x1080 viewport (that's what Argo records at)
- Smooth scroll behavior enabled
- Interactive elements: a "Get Started" button that scrolls to features, a tab switcher on the code example
- Sections should have `id` attributes for anchor navigation (used by the demo script)

- [ ] **Step 2: Verify page renders**

Open `demos/showcase.html` in a browser manually and verify it looks correct at 1920x1080.

- [ ] **Step 3: Commit**

```bash
git add demos/showcase.html
git commit -m "feat: add showcase landing page for Argo demo video"
```

### Task 4: Create showcase demo script

**Files:**
- Create: `demos/showcase.demo.ts`

- [ ] **Step 1: Write the demo script**

The script navigates the showcase landing page, pausing at each section. Uses `narration.mark()` for scene boundaries and `showOverlay`/`withOverlay` for visual annotations.

```typescript
import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('showcase', async ({ page, narration }) => {
  await page.goto('/showcase.html');
  await page.waitForTimeout(1000);

  // Scene 1: Hero section
  narration.mark('hero');
  await showOverlay(page, 'hero', {
    type: 'lower-third',
    text: 'Argo — Demo videos, automated',
    motion: 'fade-in',
  }, 4000);

  // Scene 2: Scroll to How it Works
  narration.mark('how-it-works');
  await page.locator('#how-it-works').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await withOverlay(page, 'how-it-works', {
    type: 'headline-card',
    title: 'Three Simple Steps',
    body: 'Write a script. Record the browser. Export the video.',
    placement: 'top-right',
    motion: 'slide-in',
  }, async () => {
    await page.waitForTimeout(4000);
  });

  // Scene 3: Features section
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await showOverlay(page, 'features', {
    type: 'callout',
    text: 'Overlays, voiceover, and more',
    placement: 'bottom-left',
    motion: 'fade-in',
  }, 4000);

  // Scene 4: Code example
  narration.mark('code');
  await page.locator('#code-example').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await showOverlay(page, 'code', {
    type: 'lower-third',
    text: 'Familiar Playwright API — nothing new to learn',
    motion: 'fade-in',
  }, 4000);

  // Scene 5: Closing
  narration.mark('closing');
  await page.locator('#hero').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    title: 'Get Started',
    body: 'npm i -D @argo-video/cli && npx argo init',
    placement: 'center',
    motion: 'fade-in',
  }, 3000);
});
```

- [ ] **Step 2: Commit**

```bash
git add demos/showcase.demo.ts
git commit -m "feat: add showcase demo script with overlay annotations"
```

### Task 5: Create showcase voiceover manifest

**Files:**
- Create: `demos/showcase.voiceover.json`

- [ ] **Step 1: Write the voiceover manifest**

```json
[
  {
    "scene": "hero",
    "text": "Meet Argo — the tool that turns Playwright scripts into polished product demo videos, complete with AI voiceover."
  },
  {
    "scene": "how-it-works",
    "text": "The workflow is simple. Write a demo script using the Playwright API you already know. Argo records the browser, then exports a finished video."
  },
  {
    "scene": "features",
    "text": "Add overlays like lower-thirds and headline cards. Argo generates voiceover narration from a simple JSON manifest."
  },
  {
    "scene": "code",
    "text": "Your demo scripts are just Playwright tests with a few extra helpers. If you know Playwright, you already know Argo."
  },
  {
    "scene": "closing",
    "text": "Install Argo, initialize your project, and ship your first demo video in minutes."
  }
]
```

- [ ] **Step 2: Commit**

```bash
git add demos/showcase.voiceover.json
git commit -m "feat: add showcase voiceover narration manifest"
```

### Task 6: Create showcase overlay manifest

**Files:**
- Create: `demos/showcase.overlays.json`

- [ ] **Step 1: Write the overlay manifest**

```json
[
  {
    "scene": "hero",
    "type": "lower-third",
    "text": "Argo — Demo videos, automated",
    "motion": "fade-in"
  },
  {
    "scene": "how-it-works",
    "type": "headline-card",
    "title": "Three Simple Steps",
    "body": "Write a script. Record the browser. Export the video.",
    "placement": "top-right",
    "motion": "slide-in"
  },
  {
    "scene": "features",
    "type": "callout",
    "text": "Overlays, voiceover, and more",
    "placement": "bottom-left",
    "motion": "fade-in"
  },
  {
    "scene": "code",
    "type": "lower-third",
    "text": "Familiar Playwright API — nothing new to learn",
    "motion": "fade-in"
  },
  {
    "scene": "closing",
    "type": "headline-card",
    "title": "Get Started",
    "body": "npm i -D @argo-video/cli && npx argo init",
    "placement": "center",
    "motion": "fade-in"
  }
]
```

- [ ] **Step 2: Commit**

```bash
git add demos/showcase.overlays.json
git commit -m "feat: add showcase overlay cues manifest"
```

### Task 7: Run the showcase pipeline

**Files:**
- No new files — this task runs the pipeline and verifies output

**Prerequisites:** A local HTTP server serving `demos/` and ffmpeg installed.

- [ ] **Step 1: Start a local server**

In a separate terminal:
```bash
npx serve demos/ -l 3000
```

- [ ] **Step 2: Update argo.config.js baseURL if needed**

Ensure `argo.config.js` has `baseURL: 'http://localhost:3000'` (this is the default from init).

- [ ] **Step 3: Run the pipeline**

```bash
npx argo pipeline showcase
```

Expected output:
```
Step 1/4: Generating TTS clips...
Step 2/4: Recording browser demo...
Step 3/4: Aligning narration with video...
Step 4/4: Exporting final video...
Done! Video saved to: videos/showcase.mp4
```

- [ ] **Step 4: Verify the output**

Check that `videos/showcase.mp4` exists and plays correctly with overlays and voiceover.

- [ ] **Step 5: Commit output artifacts**

Note: If `videos/` is in `.gitignore`, use `git add -f` to force-add the showcase video. This is an intentional binary artifact for the repo showcase.

```bash
git add -f videos/showcase.mp4
git commit -m "feat: add showcase demo video"
```

## Chunk 3: Agent Skill

### Task 8: Create the argo-demo-creator skill

**Files:**
- Create: `skills/argo-demo-creator.md`

- [ ] **Step 1: Write the skill file**

Create `skills/argo-demo-creator.md` with the following structure:

```markdown
---
name: argo-demo-creator
description: Create polished product demo videos using Argo. Handles the full workflow from installation through finished video with AI voiceover and overlays.
---

# Argo Demo Creator

[Full skill content — see spec Section 2 for all sections:
prerequisites, app context, script authoring, overlays, voiceover, config, pipeline, troubleshooting.
Include the autonomous workflow steps.
Include API reference with code examples.
Include the overlay template types and their fields.
Include the voiceover manifest format.
Include common troubleshooting scenarios.]
```

The skill should include:

**Prerequisites section:**
- Check for `@argo-video/cli` in `package.json` devDependencies
- Check for `argo.config.js` in project root
- If missing: `npm i -D @argo-video/cli && npx argo init`

**Script authoring section:**
- Demo files use `.demo.ts` extension, live in `demos/` directory
- Import `test` from `@argo-video/cli` (NOT from `@playwright/test`)
- The `test` fixture provides `page` (Playwright Page) and `narration` (NarrationTimeline)
- Use `narration.mark('scene-name')` to define scene boundaries
- Use `page.waitForTimeout()` for pacing

**Overlay API section:**
- `showOverlay(page, scene, cue, durationMs)` — show overlay for fixed duration
- `withOverlay(page, scene, cue, action)` — show overlay during action, hide after
- `hideOverlay(page, zone?)` — manually hide overlay
- Template types with all fields:
  - `lower-third`: `{ type, text, placement?, motion? }`
  - `headline-card`: `{ type, title, kicker?, body?, placement?, motion? }`
  - `callout`: `{ type, text, placement?, motion? }`
  - `image-card`: `{ type, src, title?, body?, placement?, motion? }`
- Zones: `bottom-center` (default), `top-left`, `top-right`, `bottom-left`, `bottom-right`, `center`
- Motion presets: `none` (default), `fade-in`, `slide-in`

**Voiceover section:**
- Manifest file: `<demo>.voiceover.json` in demos directory
- Format: JSON array of `{ scene, text, voice?, speed? }`
- `scene` must match a `narration.mark()` call in the demo script
- Default voice: `af_heart`, default speed: `1.0`

**Config section:**
- `argo.config.js` fields with defaults:
  - `baseURL` (required, no default)
  - `demosDir` (default: `'demos'`)
  - `outputDir` (default: `'videos'`)
  - `tts`: `{ defaultVoice: 'af_heart', defaultSpeed: 1.0 }`
  - `video`: `{ width: 1920, height: 1080, fps: 30 }`
  - `export`: `{ preset: 'slow', crf: 16 }`

**Pipeline section:**
- Correct order: TTS → record → align → export
- Standalone commands:
  - `npx argo tts generate demos/<name>.voiceover.json` — **WARNING: this takes a file path (e.g., `demos/showcase.voiceover.json`), NOT a bare demo name like `showcase`. Passing a bare name will fail silently (file not found).**
  - `npx argo record <name>` — takes a bare demo name
  - `npx argo export <name>` — takes a bare demo name
- All-in-one: `npx argo pipeline <name>` — takes a bare demo name
- The `pipeline` command handles alignment internally

**Autonomous workflow section:**
```
1. Check if @argo-video/cli is installed → install if not
2. Check if argo.config.js exists → run `npx argo init` if not
3. Ask user for baseURL of their running app
4. Explore the app (navigate to understand routes/features)
5. Write <name>.demo.ts with Playwright actions + narration marks
6. Write <name>.voiceover.json with scene narration text
7. Optionally write <name>.overlays.json with overlay cues
8. Run `npx argo pipeline <name>`
9. Report output video path
```

**Troubleshooting section:**
- "No video recording found": Ensure Playwright config has `video: 'on'`
- "No timing file found": Demo must use `import { test } from '@argo-video/cli'` (not `@playwright/test`) and call `narration.mark()`
- "ffmpeg/ffprobe not found": Install ffmpeg (`brew install ffmpeg` on macOS)
- "Playwright recording failed": Check that `baseURL` points to a running app
- "No TTS clips generated": Check that voiceover manifest scene names match `narration.mark()` calls

- [ ] **Step 2: Commit**

```bash
git add skills/argo-demo-creator.md
git commit -m "feat: add argo-demo-creator skill for AI agents"
```

### Task 9: Full integration verification

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Push all changes**

```bash
git push
```
