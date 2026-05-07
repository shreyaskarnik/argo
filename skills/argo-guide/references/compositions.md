# Compositions — when to mix authored motion into a demo

Argo records the real running app. That's its superpower. But some moments in a demo communicate better as **authored motion graphics** — visualizations the product can't physically show on its own. `renderComposition` brings those into Argo's pipeline as scenes, alongside the recorded ones.

This reference goes deeper than the SKILL.md summary. Read it when you're authoring a demo that needs more than a recording can give.

---

## When to reach for a composition

Default to recording. Only swap to a composition when you have a clear answer to: **"what is this scene communicating that a real recording can't?"**

| Use a composition for | Why a recording fails |
| --- | --- |
| **Abstract/conceptual framing** (wedge thesis, "old way vs new way", workflow diagrams) | The product UI doesn't visualize the *idea*. A recording would be forced metaphor. |
| **Title cards / brand intros / kinetic outros** | Argo's overlays handle simple text cards. Compositions handle the polished marketing-grade ones with typography, easing, layered motion. |
| **Side-by-side comparisons** ("code editor vs screen recorder", before/after, A/B) | A real recording can only show one thing at a time. |
| **Animated stats and data viz** ($0→$10K counters, charts that ramp, before/after metrics) | Hard to capture from the live app and re-time correctly. |
| **Hypothetical or future-state UI** (roadmap features, "what if", concept demos) | The product can't show what it doesn't yet do. |
| **Schematic explainers** (architecture diagrams, data flow, system maps) | UI screens don't visualize internals. |

Stick with recording when:

- The content IS the product UI in normal use
- The interaction is the point ("watch this drag work", "see the search live-update")
- The credibility comes from being demonstrably real, not idealized
- A composition would feel like cheating ("they couldn't actually demo this")

The mistake to avoid: don't use compositions to *replace* the product. Use them to **frame** it.

---

## Anatomy of a composition

A composition is a self-contained HTML file under `compositions/` that follows a small contract — the same shape as a Hyperframes block. The contract is intentionally minimal so you can hand-roll one in 30 lines or import a polished one from the Hyperframes catalog (`npx hyperframes add <block-name>`).

### The required pieces

```html
<!doctype html>
<html><head><style>/* visual styles */</style></head>
<body>
  <!-- Root element with composition metadata -->
  <div data-composition-id="my-scene"
       data-width="1920"
       data-height="1080"
       data-duration="5">
    <!-- Visible content — build the END state here, animate INTO it -->
    <h1 class="title">Hello</h1>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    // PAUSED master timeline — Argo plays it after the readiness gate
    const tl = gsap.timeline({ paused: true });
    tl.from('.title', { y: 80, opacity: 0, duration: 0.8, ease: 'power3.out' }, 0.3);
    tl.to('.title', { opacity: 0, duration: 0.4, ease: 'power2.in' }, 4.4);

    // Register so renderComposition can find + play it
    window.__timelines = window.__timelines || {};
    window.__timelines['my-scene'] = tl;

    // Optional: signal asset readiness (default Promise.resolve())
    window.__compositionReady = Promise.resolve();
  </script>
</body></html>
```

### The contract in detail

| Required | What | Why |
| --- | --- | --- |
| `data-composition-id="<name>"` | Identifies the composition root | `renderComposition` looks up the timeline by this id |
| `data-duration="<seconds>"` | Declared duration | Used as the scene hold time when `opts.durationMs` is omitted |
| `data-width` / `data-height` | Frame size | Documentation; Argo records at the project's `video.width`/`height` |
| **Paused** GSAP master timeline | `gsap.timeline({ paused: true })` | If unpaused, the timeline plays before recording starts and you miss the opening |
| Timeline registered at `window.__timelines["<name>"]` | After timeline construction | Argo's polling looks here to play it after the readiness gate |
| Optional: `window.__compositionReady` | Promise that resolves when fonts/GLTF/textures finish loading | `renderComposition` awaits this before marking the scene |

### Determinism

Compositions are rendered every time the demo runs. They must produce the same output every time:

- **No `Math.random()`** — use a seeded PRNG if you need pseudo-random values
- **No `Date.now()` / `performance.now()` for content** — only for the GSAP timeline driver, which Argo plays deterministically
- **No `setTimeout` / `requestAnimationFrame` for content state** — let GSAP drive the timeline and the frame timing follows
- **No infinite repeats (`repeat: -1`)** — calculate the exact repeat count from `data-duration`

If a composition produces different output between runs, Argo's deterministic export breaks down.

---

## Layout: end state first, animate into it

Position every element at its **most-visible moment** with static CSS first. Then add `gsap.from()` to animate FROM offscreen/invisible TO that resting position. This is the same pattern Hyperframes uses, and the reason matters: if you position elements at their animated *start* state and tween to where you think they should land, you're guessing the final layout. Overlaps don't show up until render time.

```css
/* Static end state — what the viewer sees at the most-visible frame */
.title { font-size: 144px; font-weight: 800; }
.subtitle { font-size: 32px; opacity: 0.7; margin-top: 24px; }
```

```js
// Animate FROM offscreen/invisible TO the CSS resting position
tl.from('.title', { y: 80, opacity: 0, duration: 0.8, ease: 'power3.out' }, 0.3);
tl.from('.subtitle', { y: 40, opacity: 0, duration: 0.6, ease: 'power2.out' }, 0.6);
```

---

## Hand-roll vs import: choosing wisely

For each composition scene, ask: **is this generic polish, or specific to my product?**

- **Generic polish** — animated logo reveals, kinetic title cards, lower-thirds, follow cards, 3D device frames around a recording. The Hyperframes catalog has these battle-tested. Importing wins on: motion design quality, accessibility/contrast already validated, brand-tunable through their props/CSS variables, version-pinned by their CLI. **Hand-rolling these is almost never the right call** — you'll spend hours re-authoring what's already shipped, and the result will look worse than the catalog block at a similar effort budget.
- **Specific to your product** — the wedge thesis, before/after framing of *your* particular workflow, schematic explainers of *your* architecture, custom comparisons with named competitors. The catalog can't have these — they're unique to your story. Hand-roll a minimal composition (30-60 lines of HTML+GSAP) following the contract above.

When in doubt: search the catalog first. If a block is close enough, import it and tune. Only hand-roll when no block fits the *concept* you're trying to communicate.

## Importing Hyperframes blocks

Hyperframes ships a catalog of blocks compatible with the exact same contract:

```bash
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx hyperframes add <block-name>
```

This drops the composition + assets into `compositions/` and `assets/` (or `models/` for 3D blocks). Most catalog blocks work on **stable chromium**:

| Block | Type | Renders on |
| --- | --- | --- |
| `apple-money-count` | GSAP counter | stable chromium |
| `blue-sweater-intro-video` | AI creator intro | stable chromium |
| `logo-outro` | 3D logo reveal | needs Canary + html-in-canvas flag |
| `vfx-iphone-device` | 3D iPhone with screen content | needs Canary + html-in-canvas flag |
| `data-chart` | Animated chart | stable chromium |
| `north-korea-locked-down` | Map zoom + popup | stable chromium |

For the **3D / WebGL / html-in-canvas** subset:

```js
// argo.config.mjs
video: {
  browser: 'chromium',
  experimentalCanvasDrawElement: true,   // --enable-features=CanvasDrawElement
  browserChannel: 'chrome-canary',       // requires `brew install --cask google-chrome@canary`
}
```

The full catalog is at <https://hyperframes.heygen.com/catalog/>.

---

## Mixed demos — composition + recording in one timeline

The flagship pattern: hyperframes-grade compositions bookend (or interleave with) Argo recordings of the real app. Each scene is one or the other.

```typescript
import { test } from '@argo-video/cli';
import { renderComposition, spotlight, focusRing } from '@argo-video/cli';

test('product-launch', async ({ page, narration }) => {
  test.setTimeout(180_000);

  // 1. Brand intro — composition (4s)
  await renderComposition(page, narration, 'compositions/intro.html', { scene: 'intro' });

  // 2. Real product hero — recording (8s)
  await page.goto('/');
  await page.waitForTimeout(400);
  narration.mark('hero');
  spotlight(page, '#hero-cta', { duration: 5000 });
  await page.waitForTimeout(7000);

  // 3. The wedge thesis — concept that the recording can't show.
  //    Side-by-side "code-as-source vs screen-recorder" mockup.
  await renderComposition(page, narration, 'compositions/wedge.html', { scene: 'wedge' });

  // 4. Real preview UI — recording (10s)
  await page.goto('/preview');
  narration.mark('preview');
  await page.waitForTimeout(10000);

  // 5. Brand outro — composition (3s)
  await renderComposition(page, narration, 'compositions/outro.html', { scene: 'outro' });
});
```

`renderComposition` calls `narration.startRecording(page)` automatically if the demo hasn't started recording yet — so the recording clock anchors at the FIRST animated frame, not at browser launch. Subsequent recorded scenes pick up the same recording.

---

## Audio in compositions

Compositions can embed `<audio>` elements (sound effects, intro stings, background music). Argo auto-detects them, writes a sidecar manifest at `.argo/<demo>/.composition-audio.jsonl`, and ffmpeg mixes each track into the final mp4 at its scene-relative start time alongside Argo's TTS narration.

```html
<audio src="assets/intro-sting.wav" preload="auto"></audio>
```

The audio plays automatically when GSAP starts the timeline (compositions usually have an `audio.play()` call in their script). You don't need to register the audio with Argo — the sidecar happens automatically inside `renderComposition`.

For dedicated background music across an entire demo (independent of any composition), use `export.audio.music` in the config — both mechanisms can coexist.

---

## Common pitfalls

- **Forgetting `paused: true`** — the timeline plays at page load before Argo can record it. Always pause.
- **Animating from the wrong reference state** — if your CSS positions the element offscreen and your tween animates onscreen, you're guessing the layout. CSS positions the END state; tweens describe the journey.
- **`Math.random()` in the composition** — non-deterministic. Use a seeded PRNG or remove the randomness.
- **Async timeline construction** — building tweens inside `await` or `setTimeout` means the timeline isn't registered when Argo polls. Keep timeline construction synchronous.
- **Composition duration drift** — if `data-duration` says 4 but the GSAP timeline runs 5.5 seconds, Argo cuts at 4 and you lose the tail. Match them.
- **Asset paths broken** — compositions are served via Argo's composition HTTP server with `<base href="/">` injected, so use project-relative paths (`models/iphone.glb`, not `../models/iphone.glb`).

---

## Reference: when this pays off

Three real patterns from existing Argo work:

- **Brand intros and outros via the catalog**: instead of writing your own animated Argo logo, `npx hyperframes add logo-outro` gets you a polished animated logo reveal in 5 seconds. The block is generic enough to brand-tune, polished enough to put at the start of a launch video. This is the most leveraged use of the catalog — every demo benefits from a stronger first/last impression, and hand-rolling that level of polish is rarely worth it.
- **Argo's existing showcase** records the real product across 11 capability clusters (~3 min). The hand-rolled `#hero` HTML and `#cta` HTML *visualize* the brand framing. Replacing those two scenes with imported catalog blocks (or composition scenes following the same contract) while keeping the recorded middle is the canonical "Plan B" demo — the recorded app dressed up for launch.
- **The wedge thesis** ("your demo is a Playwright script, your launch video shouldn't be a screen recording") is fundamentally a *concept* specific to Argo's positioning. The catalog can't have this; you hand-roll a small composition with side-by-side mockups. 4 seconds of authored motion conveys the idea more cleanly than any recording could.

Don't over-rotate. The recording IS the demo. Compositions just frame it. The catalog is your shortcut to brand-grade frames.
