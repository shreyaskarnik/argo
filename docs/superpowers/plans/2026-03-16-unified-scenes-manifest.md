# Unified Scenes Manifest Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace separate `.voiceover.json` + `.overlays.json` with a single `.scenes.json` manifest per demo, and make `showOverlay`/`withOverlay` resolve overlay content from the manifest at runtime.

**Architecture:** Add a manifest loader to the overlay module that reads `.scenes.json` via `ARGO_OVERLAYS_PATH` env var. The overlay functions gain overloaded signatures: manifest-only (scene name + duration), or inline cue (backward compat). The TTS pipeline, validation, init scaffolding, and preview server all switch to the unified format. Demo scripts simplify to just runtime behavior (duration, action callbacks).

**Tech Stack:** TypeScript, Node.js, Vitest

---

## Chunk 1: Core — Types, Manifest Loader, API Overloads

### Task 1: Add SceneEntry type and manifest loader

**Files:**
- Modify: `src/overlays/types.ts`
- Create: `src/overlays/manifest-loader.ts`
- Create: `tests/overlays/manifest-loader.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/overlays/manifest-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOverlayFromManifest, resetManifestCache } from '../src/overlays/manifest-loader.js';

describe('manifest-loader', () => {
  let dir: string;
  const originalEnv = process.env.ARGO_OVERLAYS_PATH;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'argo-manifest-'));
    resetManifestCache();
  });

  afterEach(async () => {
    process.env.ARGO_OVERLAYS_PATH = originalEnv;
    resetManifestCache();
    await rm(dir, { recursive: true });
  });

  it('returns overlay cue from scenes.json for a matching scene', async () => {
    const manifest = [
      {
        scene: 'hero',
        text: 'Hello',
        overlay: {
          type: 'headline-card',
          title: 'Hero Title',
          placement: 'top-right',
          motion: 'slide-in',
          autoBackground: true,
        },
      },
    ];
    const manifestPath = join(dir, 'demo.scenes.json');
    await writeFile(manifestPath, JSON.stringify(manifest));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    const cue = loadOverlayFromManifest('hero');
    expect(cue).toEqual({
      type: 'headline-card',
      title: 'Hero Title',
      placement: 'top-right',
      motion: 'slide-in',
      autoBackground: true,
    });
  });

  it('returns undefined for a scene without overlay', () => {
    const manifest = [{ scene: 'hero', text: 'Hello' }];
    const manifestPath = join(dir, 'demo.scenes.json');
    require('node:fs').writeFileSync(manifestPath, JSON.stringify(manifest));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    expect(loadOverlayFromManifest('hero')).toBeUndefined();
  });

  it('returns undefined when env var is not set', () => {
    delete process.env.ARGO_OVERLAYS_PATH;
    expect(loadOverlayFromManifest('hero')).toBeUndefined();
  });

  it('returns undefined for a scene not in the manifest', () => {
    const manifest = [{ scene: 'other', text: 'Hi', overlay: { type: 'callout', text: 'X' } }];
    const manifestPath = join(dir, 'demo.scenes.json');
    require('node:fs').writeFileSync(manifestPath, JSON.stringify(manifest));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    expect(loadOverlayFromManifest('hero')).toBeUndefined();
  });

  it('caches the manifest after first load', () => {
    const manifest = [{ scene: 'a', text: 'Hi', overlay: { type: 'callout', text: 'X' } }];
    const manifestPath = join(dir, 'demo.scenes.json');
    require('node:fs').writeFileSync(manifestPath, JSON.stringify(manifest));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;

    loadOverlayFromManifest('a');
    // Delete the file — should still work from cache
    require('node:fs').unlinkSync(manifestPath);
    expect(loadOverlayFromManifest('a')).toEqual({ type: 'callout', text: 'X' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/overlays/manifest-loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add SceneEntry type to types.ts**

Add to `src/overlays/types.ts`:

```ts
/** A single entry in the unified .scenes.json manifest. */
export interface SceneEntry {
  scene: string;
  text: string;
  voice?: string;
  speed?: number;
  lang?: string;
  _hint?: string;
  overlay?: OverlayCue;
}
```

- [ ] **Step 4: Implement manifest-loader.ts**

```ts
// src/overlays/manifest-loader.ts
import { readFileSync, existsSync } from 'node:fs';
import type { OverlayCue, SceneEntry } from './types.js';

let cachedManifest: SceneEntry[] | null = null;

export function resetManifestCache(): void {
  cachedManifest = null;
}

function getManifest(): SceneEntry[] | null {
  if (cachedManifest !== null) return cachedManifest;
  const manifestPath = process.env.ARGO_OVERLAYS_PATH;
  if (!manifestPath || !existsSync(manifestPath)) return null;
  cachedManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SceneEntry[];
  return cachedManifest;
}

export function loadOverlayFromManifest(scene: string): OverlayCue | undefined {
  const manifest = getManifest();
  if (!manifest) return undefined;
  const entry = manifest.find((e) => e.scene === scene);
  return entry?.overlay;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/overlays/manifest-loader.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/overlays/types.ts src/overlays/manifest-loader.ts tests/overlays/manifest-loader.test.ts
git commit -m "feat: add SceneEntry type and overlay manifest loader"
```

---

### Task 2: Update showOverlay/withOverlay with overloaded signatures

**Files:**
- Modify: `src/overlays/index.ts`
- Modify: `tests/overlays/index.test.ts` (add manifest-based tests)

- [ ] **Step 1: Write failing tests for manifest-based overlay calls**

Add to existing overlay index tests (or create new test file):

```ts
// Test: showOverlay resolves from manifest when given just duration
// Test: withOverlay resolves from manifest when given just action
// Test: showOverlay merges inline overrides with manifest entry
// Test: showOverlay with full inline cue still works (backward compat)
// Test: showOverlay throws when no manifest entry and no inline cue
```

The tests should mock the page object and verify that `renderTemplate` receives the correct resolved cue.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/overlays/index.test.ts`

- [ ] **Step 3: Implement overloaded showOverlay**

In `src/overlays/index.ts`, replace the current `showOverlay` with:

```ts
import { loadOverlayFromManifest } from './manifest-loader.js';

function resolveCue(scene: string, cueOrPartial?: OverlayCue | Partial<OverlayCue>): OverlayCue {
  const manifestCue = loadOverlayFromManifest(scene);
  if (cueOrPartial && 'type' in cueOrPartial && cueOrPartial.type) {
    // Full inline cue provided — merge with manifest if available
    return manifestCue ? { ...manifestCue, ...cueOrPartial } as OverlayCue : cueOrPartial as OverlayCue;
  }
  if (manifestCue) {
    // Manifest cue with optional overrides
    return cueOrPartial ? { ...manifestCue, ...cueOrPartial } as OverlayCue : manifestCue;
  }
  throw new Error(
    `No overlay found for scene "${scene}". ` +
    `Either add an overlay entry in your .scenes.json manifest, or pass an inline cue.`
  );
}

export async function showOverlay(
  page: Page,
  scene: string,
  cueOrDuration: OverlayCue | Partial<OverlayCue> | number,
  maybeDuration?: number,
  options?: { autoBackground?: boolean },
): Promise<void> {
  let cue: OverlayCue;
  let durationMs: number;
  if (typeof cueOrDuration === 'number') {
    cue = resolveCue(scene);
    durationMs = cueOrDuration;
  } else {
    cue = resolveCue(scene, cueOrDuration);
    durationMs = maybeDuration!;
  }
  const zone: Zone = cue.placement ?? getConfigDefaultPlacement() ?? 'bottom-center';
  const motion = cue.motion ?? 'none';
  const theme = await resolveTheme(page, cue, zone, options?.autoBackground);
  const { contentHtml, styles } = renderTemplate(cue, theme);
  const zoneId = ZONE_ID_PREFIX + zone;
  const motionCSS = getMotionCSS(motion, zoneId);
  const motionStyles = getMotionStyles(motion, zoneId);
  await injectIntoZone(page, zone, contentHtml, { ...styles, ...motionStyles }, motionCSS);
  await page.waitForTimeout(durationMs);
  await removeZone(page, zone);
}
```

- [ ] **Step 4: Implement overloaded withOverlay**

```ts
export async function withOverlay(
  page: Page,
  scene: string,
  cueOrAction: OverlayCue | Partial<OverlayCue> | (() => Promise<void>),
  maybeAction?: (() => Promise<void>) | { autoBackground?: boolean },
  options?: { autoBackground?: boolean },
): Promise<void> {
  let cue: OverlayCue;
  let action: () => Promise<void>;
  let opts: { autoBackground?: boolean } | undefined;
  if (typeof cueOrAction === 'function') {
    cue = resolveCue(scene);
    action = cueOrAction;
  } else {
    cue = resolveCue(scene, cueOrAction);
    action = maybeAction as () => Promise<void>;
    opts = options;
  }
  const zone: Zone = cue.placement ?? getConfigDefaultPlacement() ?? 'bottom-center';
  const motion = cue.motion ?? 'none';
  const theme = await resolveTheme(page, cue, zone, opts?.autoBackground);
  const { contentHtml, styles } = renderTemplate(cue, theme);
  const zoneId = ZONE_ID_PREFIX + zone;
  const motionCSS = getMotionCSS(motion, zoneId);
  const motionStyles = getMotionStyles(motion, zoneId);
  await injectIntoZone(page, zone, contentHtml, { ...styles, ...motionStyles }, motionCSS);
  try {
    await action();
  } finally {
    await removeZone(page, zone);
  }
}
```

- [ ] **Step 5: Export new types and functions from index.ts**

Add to exports: `export type { SceneEntry } from './types.js';`
Add to exports: `export { resetManifestCache } from './manifest-loader.js';`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/overlays/`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: PASS (backward compat — existing tests still work)

- [ ] **Step 8: Commit**

```bash
git add src/overlays/index.ts tests/overlays/index.test.ts
git commit -m "feat: showOverlay/withOverlay resolve from .scenes.json manifest"
```

---

### Task 3: Pass ARGO_OVERLAYS_PATH in record.ts

**Files:**
- Modify: `src/record.ts`

- [ ] **Step 1: Update record.ts to pass overlay manifest path**

In `src/record.ts`, in the `execFile` env block (line ~108), add:

```ts
ARGO_OVERLAYS_PATH: path.resolve(path.join(options.demosDir, `${demoName}.scenes.json`)),
```

Also update the overlay manifest path for asset server detection (line ~91):

```ts
const overlayManifestPath = path.join(options.demosDir, `${demoName}.scenes.json`);
```

The asset server check needs to handle the new format — extract `overlay` objects from scene entries that have them.

- [ ] **Step 2: Update loadOverlayManifest call**

The `loadOverlayManifest` in `src/overlays/manifest.ts` needs to handle `.scenes.json` format. Check what it currently does and either update it or inline the logic. The function should:
1. Read `.scenes.json`
2. Extract `entry.overlay` from each scene entry that has one
3. Add `scene` name to each overlay for the existing `OverlayManifestEntry` type
4. Return the array for `hasImageAssets()` check

- [ ] **Step 3: Run existing tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/record.ts src/overlays/manifest.ts
git commit -m "feat: pass ARGO_OVERLAYS_PATH to Playwright subprocess"
```

---

## Chunk 2: Pipeline, TTS, Validation

### Task 4: Update pipeline.ts and tts/generate.ts for .scenes.json

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `src/tts/generate.ts`
- Modify: `tests/tts/generate.test.ts` (if exists, update fixtures)

- [ ] **Step 1: Update pipeline.ts manifest path**

Change line 63:
```ts
// Before
manifestPath: `${config.demosDir}/${demoName}.voiceover.json`,
// After
manifestPath: `${config.demosDir}/${demoName}.scenes.json`,
```

Change line 148 (subtitle text map):
```ts
const manifestPath = `${config.demosDir}/${demoName}.scenes.json`;
```

The subtitle text extraction reads `entry.scene` and `entry.text` which are still at root level — no format change needed.

- [ ] **Step 2: Update tts/generate.ts**

The `generateClips` function reads `scene` and `text` from the manifest. These are still at root level in `.scenes.json`, so the parsing logic is unchanged. Only update the `demoName` derivation in `src/cli.ts`:

In `src/cli.ts` line 77:
```ts
// Before
demoName: basename(manifest).replace(/\.voiceover\.json$/, '').replace(/\.json$/, ''),
// After
demoName: basename(manifest).replace(/\.scenes\.json$/, '').replace(/\.voiceover\.json$/, '').replace(/\.json$/, ''),
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline.ts src/cli.ts
git commit -m "feat: pipeline and CLI use .scenes.json manifest path"
```

---

### Task 5: Rewrite validate.ts for unified manifest

**Files:**
- Modify: `src/validate.ts`
- Modify: `tests/validate.test.ts`

- [ ] **Step 1: Write failing tests for new validation**

Update existing validate tests to use `.scenes.json` format:

```ts
// Test: validates scene+text fields at root level
// Test: validates overlay sub-object fields (type, placement, motion)
// Test: warns on script scenes missing from manifest
// Test: warns on manifest scenes missing narration.mark()
// Test: errors on unknown overlay type/placement/motion
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/validate.test.ts`

- [ ] **Step 3: Rewrite validate.ts**

Load single `${demoName}.scenes.json`. Validate:
- Root: each entry has `scene` (string) and `text` (string)
- Overlay (if present): validate `type`, `placement`, `motion` against allowed values
- Cross-reference with `narration.mark()` calls from script

```ts
// Replace separate voiceover/overlay validation with unified:
const scenesPath = join(demosDir, `${demoName}.scenes.json`);
if (existsSync(scenesPath)) {
  const scenes = JSON.parse(readFileSync(scenesPath, 'utf-8'));
  // ... validate root fields (scene, text)
  // ... validate overlay sub-objects
  // ... cross-reference with script scenes
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts tests/validate.test.ts
git commit -m "feat: validate reads unified .scenes.json manifest"
```

---

### Task 6: Update init.ts and parse-playwright.ts

**Files:**
- Modify: `src/init.ts`
- Modify: `src/parse-playwright.ts`
- Modify: `tests/init.test.ts`

- [ ] **Step 1: Update EXAMPLE templates in init.ts**

Replace `EXAMPLE_VOICEOVER` + `EXAMPLE_OVERLAYS` with single `EXAMPLE_SCENES`:

```ts
const EXAMPLE_SCENES = JSON.stringify(
  [
    {
      scene: 'welcome',
      text: 'Welcome to our app — let me show you around.',
      overlay: { type: 'lower-third', text: 'Welcome to our app', motion: 'fade-in' },
    },
    {
      scene: 'action',
      text: 'It only takes one click to get started.',
      voice: 'af_heart',
      overlay: {
        type: 'headline-card',
        title: 'One-click setup',
        body: 'Just press the button to get started.',
        placement: 'top-left',
        motion: 'slide-in',
      },
    },
    {
      scene: 'done',
      text: "And that's it. You're all set.",
      voice: 'af_heart',
    },
  ],
  null,
  2,
) + '\n';
```

Update `EXAMPLE_DEMO` to use manifest-based overlay calls:

```ts
const EXAMPLE_DEMO = `import { test } from '@argo-video/cli';
import { showOverlay, withOverlay } from '@argo-video/cli';

test('example', async ({ page, narration }) => {
  await page.goto('/');

  narration.mark('welcome');
  await showOverlay(page, 'welcome', narration.durationFor('welcome'));

  narration.mark('action');
  await withOverlay(page, 'action', async () => {
    await page.click('button');
    await page.waitForTimeout(narration.durationFor('action'));
  });

  narration.mark('done');
  await showOverlay(page, 'done', narration.durationFor('done'));
});
`;
```

Update `init()` to write `example.scenes.json` instead of two files:

```ts
await writeIfMissing(join(demosDir, 'example.scenes.json'), EXAMPLE_SCENES);
// Remove the two old writeIfMissing calls
```

Update console output to reference `.scenes.json`.

- [ ] **Step 2: Merge parse-playwright skeleton generators**

Replace `generateVoiceoverSkeleton()` + `generateOverlaysSkeleton()` with:

```ts
export function generateScenesSkeleton(
  parsed: ParsedPlaywrightTest,
): SceneEntry[] {
  return parsed.scenes.map((s) => ({
    scene: s.name,
    text: '',
    _hint: s.hint,
    overlay: {
      type: 'lower-third' as const,
      text: humanize(s.name),
    },
  }));
}
```

Update `initFrom()` to use `generateScenesSkeleton()` and write single file:

```ts
const scenes = generateScenesSkeleton(parsed);
const scenesJson = JSON.stringify(scenes, null, 2) + '\n';
await writeIfMissing(join(demosDir, `${demoName}.scenes.json`), scenesJson);
```

- [ ] **Step 3: Update tests**

Run: `npx vitest run tests/init.test.ts`
Fix any test fixtures that expect separate `.voiceover.json` / `.overlays.json` files.

- [ ] **Step 4: Run full tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/init.ts src/parse-playwright.ts tests/init.test.ts
git commit -m "feat: init scaffolds unified .scenes.json manifest"
```

---

## Chunk 3: Preview Server

### Task 7: Update preview.ts for unified manifest

**Files:**
- Modify: `src/preview.ts`
- Modify: `tests/preview.test.ts`

This is the largest single file change. The preview server currently loads voiceover and overlay data separately and has separate save endpoints.

- [ ] **Step 1: Update loadPreviewData to read .scenes.json**

Replace separate voPath/ovPath reads with single scenesPath:

```ts
const scenesPath = join(demosDir, `${demoName}.scenes.json`);
const scenes = readJsonFile<SceneEntry[]>(scenesPath, []);

// Derive voiceover and overlay arrays from unified entries
const voiceover: PreviewVoiceoverEntry[] = scenes.map((s) => ({
  scene: s.scene,
  text: s.text,
  voice: s.voice,
  speed: s.speed,
  lang: s.lang,
  _hint: s._hint,
}));

const overlays: OverlayManifestEntry[] = scenes
  .filter((s) => s.overlay)
  .map((s) => ({ scene: s.scene, ...s.overlay! }));
```

- [ ] **Step 2: Update save endpoints**

Replace `/api/voiceover` and `/api/overlays` POST handlers to write back to `.scenes.json`:

- Read current `.scenes.json`
- Merge updated voiceover fields or overlay data back into scene entries
- Write single file

The save logic needs to reconstruct `SceneEntry[]` from the edited voiceover/overlay arrays.

- [ ] **Step 3: Update TTS regen path**

The `manifestPath` for TTS regen (line ~316) changes to `.scenes.json`:

```ts
const manifestPath = join(demosDir, `${demoName}.scenes.json`);
```

- [ ] **Step 4: Add motion field to overlay editing UI**

In `renderOverlayFields()`, add a motion dropdown:

```html
<label>Motion</label>
<select data-field="overlay-motion" data-scene="${esc(s.name)}">
  <option value="none" ${(ov?.motion ?? 'none') === 'none' ? 'selected' : ''}>none</option>
  <option value="fade-in" ${ov?.motion === 'fade-in' ? 'selected' : ''}>fade-in</option>
  <option value="slide-in" ${ov?.motion === 'slide-in' ? 'selected' : ''}>slide-in</option>
</select>
```

Update `collectOverlays()` to include `motion` field.

- [ ] **Step 5: Update preview tests**

Update `scaffoldDemo()` helper to create `.scenes.json` instead of separate files. Update all test assertions.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/preview.test.ts`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/preview.ts tests/preview.test.ts
git commit -m "feat: preview server uses unified .scenes.json manifest"
```

---

## Chunk 4: Demo Migration

### Task 8: Migrate showcase demo

**Files:**
- Create: `demos/showcase.scenes.json`
- Modify: `demos/showcase.demo.ts`
- Remove: `demos/showcase.voiceover.json`
- Remove: `demos/showcase.overlays.json`

- [ ] **Step 1: Create unified showcase.scenes.json**

Merge `showcase.voiceover.json` + `showcase.overlays.json` + inline overlay data from `showcase.demo.ts` into a single `.scenes.json`. All 8 scenes: hero, how-it-works, features, tts, camera, code, closing, mic-drop. Include `motion`, `autoBackground`, and full overlay content (kicker, body, etc.) from the demo script.

- [ ] **Step 2: Simplify showcase.demo.ts**

Replace all inline overlay objects with manifest-based calls:

```ts
// Before
await showOverlay(page, 'hero', { type: 'headline-card', kicker: '...', ... }, duration);
// After
await showOverlay(page, 'hero', narration.durationFor('hero', { maxMs: 8000 }));

// Before
await withOverlay(page, 'how-it-works', { type: 'headline-card', ... }, async () => { ... });
// After
await withOverlay(page, 'how-it-works', async () => { ... });
```

- [ ] **Step 3: Remove old manifest files**

```bash
git rm demos/showcase.voiceover.json demos/showcase.overlays.json
```

- [ ] **Step 4: Run validation**

```bash
npx tsx bin/argo.js validate showcase
```
Expected: all checks passed

- [ ] **Step 5: Commit**

```bash
git add demos/showcase.scenes.json demos/showcase.demo.ts
git commit -m "feat: migrate showcase demo to unified .scenes.json"
```

---

### Task 9: Migrate preview-demo and voice-clone demos

**Files:**
- Create: `demos/preview-demo.scenes.json`, `demos/voice-clone.scenes.json`
- Modify: `demos/preview-demo.demo.ts`, `demos/voice-clone.demo.ts`
- Remove: old `.voiceover.json` + `.overlays.json` for both

- [ ] **Step 1: Create unified preview-demo.scenes.json**

Merge voiceover + overlay data for all 9 scenes. Include motion and autoBackground from demo script.

- [ ] **Step 2: Simplify preview-demo.demo.ts**

Replace all inline overlay objects with manifest-based calls.

- [ ] **Step 3: Create unified voice-clone.scenes.json**

Merge voiceover + overlay data for all 9 scenes.

- [ ] **Step 4: Simplify voice-clone.demo.ts**

Replace all inline overlay objects with manifest-based calls.

- [ ] **Step 5: Remove old files**

```bash
git rm demos/preview-demo.voiceover.json demos/preview-demo.overlays.json
git rm demos/voice-clone.voiceover.json demos/voice-clone.overlays.json
```

- [ ] **Step 6: Run validation on both**

```bash
npx tsx bin/argo.js validate preview-demo
npx tsx bin/argo.js validate voice-clone
```

- [ ] **Step 7: Commit**

```bash
git add demos/preview-demo.scenes.json demos/preview-demo.demo.ts
git add demos/voice-clone.scenes.json demos/voice-clone.demo.ts
git commit -m "feat: migrate preview-demo and voice-clone to unified .scenes.json"
```

---

## Chunk 5: Final Verification

### Task 10: Full test suite and build verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 2: Run build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Verify validate works for all demos**

```bash
npx tsx bin/argo.js validate showcase
npx tsx bin/argo.js validate preview-demo
npx tsx bin/argo.js validate voice-clone
```

- [ ] **Step 4: Verify no references to old file patterns remain**

```bash
grep -r '\.voiceover\.json\|\.overlays\.json' src/ --include='*.ts' | grep -v node_modules
```
Expected: No matches (only in test fixtures if they test backward compat)

- [ ] **Step 5: Update CLAUDE.md**

Update all references to `.voiceover.json` and `.overlays.json` to `.scenes.json`. Update the "Demo Authoring" section, pipeline descriptions, and any other references.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for unified .scenes.json manifest"
```
