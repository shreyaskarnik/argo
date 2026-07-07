# Argo × HyperFrames Integration — Design

**Date:** 2026-07-06
**Status:** Approved
**Scope:** Four sequential tracks adopting HyperFrames capabilities in Argo, culminating in a showcase demo video.

## Background

[HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0) is HeyGen's "write HTML, render video" framework. Both tools converged on the same primitive — a GSAP timeline scoped under a `data-*` attribute root — which makes their content interoperable: HyperFrames *seeks* a paused timeline deterministically; Argo can *play* the same timeline live, or seek it in a pre-render pass.

Its registry catalog holds **142 items** (109 blocks, 25 components, 8 examples) at
`https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry/registry.json`.

- **Block** — standalone HTML composition (fixed canvas, typically 1920×1080; fixed duration) with scoped styles and a script that builds a **paused** GSAP timeline registered on `window.__timelines[<id>]`. Typed params exposed as CSS custom properties, declared in `registry-item.json`.
- **Component** — HTML + scoped CSS snippet (`pointer-events: none`), params via CSS custom properties, optional GSAP timeline-integration hints in comments.

All 12 of Argo's existing blocks have HyperFrames counterparts; the catalog's remaining ~130 items are the payoff.

## Goals

1. Expand Argo's shader transition library from 5 to ~18 (Track 1).
2. Let users install and use HyperFrames catalog items with one command (Track 2).
3. Composite full HyperFrames blocks into exported videos, frame-exact (Track 3).
4. Ship a demo video proving the combo: **"Argo + HyperFrames — better together"** (Track 4).

## Non-Goals

- Caption components (`caption-*`, 18 items) — blocked on the word-level STT roadmap item (v0.38 candidate). Explicitly deferred.
- An Argo-native registry server. The registry URL is configurable; v1 points at the HyperFrames GitHub raw registry only.
- Converting HyperFrames items to Argo `BlockDefinition` format. Items are stored native and adapted at use time.
- Per-boundary shader selection (pre-existing limitation, unchanged).

---

## Track 1 — Shader transitions port

**Source:** `packages/shader-transitions/src/shaders/registry.ts` (fragment shaders as minified JS strings) + `common.ts` (`H` header/varyings, `NQ` noise helpers).
**Target:** self-contained, formatted, commented `.glsl` files in `src/transitions/shaders/`, matching the existing five.

- Port all non-duplicates (~13): `domain-warp`, `ridged-burn`, `whip-pan`, `sdf-iris`, `gravitational-lens`, `cinematic-zoom`, `chromatic-radial-split`, `glitch`, `swirl-vortex`, `thermal-distortion`, `flash-through-white`, and others. Final list determined by diffing against the existing five (`cross-warp-morph` ≈ `crosswarp`; `light-leak` exists; `ripple-waves` vs `ripple` and `swirl-vortex` vs `swirl` compared visually before inclusion).
- **Uniform shim at port time** (not runtime): `u_from`/`u_to`/`u_progress`/`v_uv` → `from`/`to`/`progress`/`vUv`. Noise helpers inlined per file so each shader stays self-contained.
- **Accent uniforms:** shaders that use `u_accent`/`u_accent_dark`/`u_accent_bright` keep them as `accent`/`accentDark`/`accentBright`. New config `export.transition.accent: '#hex'` (default `#0ea5e9`). The render harness parses the hex, derives dark (luminance-scaled) and bright (mixed toward white) variants, and supplies the three uniforms **only when the shader source declares them** — existing shaders are unaffected.
- Each file carries an attribution header: adapted from heygen-com/hyperframes, Apache-2.0.
- Build step already copies `.glsl` → `dist/`; shader cache keys already hash shader source, so new shaders cache correctly with no changes.
- Update: README shader list, `argo validate` shader-name validation, `skills/argo-guide` references.

**Testing:** extend `tests/transitions/shader-render.test.ts` — every registered shader compiles and renders a frame in headless Chromium (the existing test pattern); accent-derivation unit tests.

---

## Track 2 — `argo add` + registry compatibility

### Command

```
argo add <name>          # install a block or component
argo add --list          # browse the catalog (name, type, tags, description)
argo add --list --json   # machine-readable
```

- Registry URL from `registry.url` in `argo.config.*`; default `https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry`.
- Item names validated with the same `[a-zA-Z0-9][a-zA-Z0-9_-]*` pattern as demo names before any `path.join()` (security invariant).
- Flow: fetch `registry.json` → locate item → fetch its `registry-item.json` → download declared files → write verbatim to `blocks/<name>/` (project-local, git-tracked; dir configurable via `blocksDir` in config). The `registry-item.json` is stored alongside for params metadata. Examples (`hyperframes:example`) are not installable — clear error pointing at the HyperFrames CLI.

### Use-time adapter (Tier 1: components, 25 items)

- New overlay cue variant: `{ type: 'hf-component', name: string, params?: Record<string, string> }` in `.scenes.json`, plus a script-side API `applyComponent(page, name, params?)` exported from fixtures (fire-and-forget-safe; error handling mirrors `showConfetti` — swallow disposal errors, warn otherwise).
- Loader reads `blocks/<name>/<name>.html`, extracts snippet HTML and `<style>` content, injects full-viewport (components are full-frame effects, not zone-positioned) via `page.evaluate` behind the existing injection fence.
- `params` map onto CSS custom properties on the injected root. Values validated against a conservative CSS-value pattern (no `;`, `}`, `url(`, `expression(`) before interpolation; component HTML itself is trusted-at-install (user-chosen, git-reviewable — same trust posture as config files).
- Env bridge: `ARGO_BLOCKS_DIR` (config → Playwright subprocess), added at **both** `src/pipeline.ts` call sites (primary + variants), per the established bridging rule.
- `argo validate` checks that every referenced `hf-component`/`hf-block` name exists in the blocks dir.

**Testing:** registry fetch with a local fixture registry (no network in unit tests); name-validation rejection cases; component extraction + param-substitution units; an integration test injecting `vignette` into a test page.

---

## Track 3 — Block pre-render adapter

New module `src/hf/block-render.ts`, generalizing the `shader-render.ts` pattern.

1. **Cue:** `overlay: { type: 'hf-block', name, params?, fit?: 'cover' | { x, y, scale } }` — rides normal scene/placement timing from the manifest. Default `fit: 'cover'` (full-frame cutaway).
2. **Render pre-pass (export time):** launch headless Chromium (same `--use-gl=angle --use-angle=swiftshader` flags as shader-render), load the installed block HTML, apply `params` as CSS custom properties, wait for `document.fonts.ready` + `window.__timelines[<id>]`, then for each of `N = durationMs × fps / 1000` frames: `tl.pause(); tl.seek(t)` → PNG screenshot (`omitBackground: true` so transparent block roots produce alpha).
3. **Duration mapping:** requested duration ≠ block native duration → linear retime (`seek(t × D_block / D_requested)`); opt-in `holdLastFrame: true` to pin the final frame instead when the requested window is longer.
4. **Cache:** `sha256(blockHtml, params, durationMs, fps, width, height)` → `.argo/<demo>/hf-blocks/<hash>/`. Unchanged blocks re-export with no browser launch (same behavior as shader cache).
5. **Composite:** ffmpeg `overlay` (PNG sequence input) gated by `enable='between(t,start,end)'`, scaled per `fit`. Position in the filter chain: **after** transitions and camera moves, **before** frame effect and watermark — deliberately *cutaway semantics*: compositing never changes timeline length, so chapters, subtitles, and speed-ramp placements need zero adjustment (unlike freeze).
6. Wired through **all four export paths**: pipeline, CLI `argo export`, preview Export, viewport variants.

**Testing:** filter-graph construction units (mirroring freeze/camera-move tests); cache-key stability; an e2e rendering `logo-outro` frames and asserting frame count + alpha channel presence.

---

## Track 4 — Showcase demo: "Better Together"

`demos/hyperframes-showcase.demo.ts` + `demos/hyperframes-showcase.scenes.json`. Hybrid recording: purpose-built local story page (served like the existing showcase via `python3 -m http.server`) interleaved with the **live** hyperframes catalog site.

**Narrative spine (user-mandated): Argo + HyperFrames is better together.**

| Scene | On screen | Dogfoods |
|---|---|---|
| 1. Hook | Story page: "Product demos, but cinematic." | TTS, overlays |
| 2. Meet HyperFrames | Live catalog site, camera zooms on block cards | `zoomTo` post-export moves |
| 3. Meet Argo | Story page: records your real product, AI voiceover, one command | overlays, blocks |
| 4. Better together | `argo add` results applied live: `vignette` + `grain-overlay` grade the footage on screen | Track 2 |
| 5. Outro | Pre-rendered `logo-outro` block, full-frame | Track 3 |

Every scene boundary uses a Track-1 shader (`ridged-burn` / `domain-warp`), accent-tinted to match the story page's brand color. Kokoro voiceover (phonetic spellings per engine rules). Live-site scenes need network; if the site is flaky at record time, fall back to full-page screenshots embedded in the story page.

---

## Implementation order & dependencies

```
Track 1 (shaders)  →  Track 2 (argo add)  →  Track 3 (block pre-render)  →  Track 4 (demo)
```

Track 1 is standalone. Track 3 renders content that Track 2 installs. Track 4 requires all three. Each track lands as its own PR with tests green; README/skill updates ride the track that changes the surface.

## Risks

- **Upstream registry drift:** item schema or URL changes break `argo add`. Mitigation: registry URL configurable; adapter validates `registry-item.json` shape and fails with a clear error.
- **Block HTML assumptions:** the adapter depends on the `window.__timelines[<id>]` convention. Mitigation: probe for the timeline after load; if absent, fail the pre-pass with an actionable message naming the block.
- **Google Fonts CDN in blocks:** recording/pre-render needs network for fonts. Mitigation: `document.fonts.ready` wait + graceful degradation to fallback fonts; document the offline caveat.
- **GSAP version skew:** blocks pin gsap@3.14 CDN; Argo bundles ~3.15 UMD. Pre-render loads the block's own HTML (its own GSAP tag) so no conflict; live component injection uses Argo's GSAP only.
