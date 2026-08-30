# HyperFrames Shader Transition Port — Implementation Plan (Track 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand argo's shader transition library from 5 to 16 by porting 11 fragment shaders from hyperframes, with a new configurable accent color that tints edge-glow/burn effects.

**Architecture:** Each shader is a self-contained `.glsl` file in `src/transitions/shaders/`, registered in a compile-time registry (`index.ts`). The WebGL page harness (`shader-page.html.ts`) gains four new optional uniforms (`accent`, `accentDark`, `accentBright` vec3; `resolution` vec2) set only when a shader declares them (WebGL ignores `uniform*` calls with null locations). Accent hex comes from `export.transition.accent` config, is derived into dark/bright variants in Node, and is included in the shader cache key.

**Tech Stack:** TypeScript (strict, ESM, ES2022), vitest, Playwright Chromium (headless WebGL via swiftshader), GLSL ES 1.0.

**Spec:** `docs/superpowers/specs/2026-07-06-hyperframes-integration-design.md` (Track 1 section)

## Global Constraints

- All work on branch `feat/hyperframes-integration` (already exists).
- GPG signing may fail: commit with `git -c commit.gpgsign=false commit ...`.
- Build = `npm run build` (tsc + `copy-assets` which globs `src/transitions/shaders/*.glsl` → `dist/transitions/shaders/` — new `.glsl` files are picked up automatically, no build-script change needed).
- Every ported `.glsl` file MUST carry the 3-line attribution header (hyperframes, Apache-2.0) exactly as shown in the task bodies.
- Default accent color: `#0ea5e9`.
- The GLSL in Tasks 3–5 was mechanically transformed from hyperframes source and **verified to compile and render** in argo's harness on 2026-07-06. Copy it byte-for-byte; do not "improve" it.
- Run single test file: `npx vitest run tests/path/to/test.ts`. Full suite: `npm test`.
- README/skill snippets must stay in sync with code changes (checked in Task 6).

---

### Task 1: Accent color derivation utility

**Files:**
- Create: `src/transitions/accent.ts`
- Test: `tests/transitions/accent.test.ts`

**Interfaces:**
- Consumes: nothing (pure utility).
- Produces: `deriveAccentColors(hex?: string): AccentColors` where `AccentColors = { accent: Vec3; accentDark: Vec3; accentBright: Vec3 }`, `Vec3 = [number, number, number]` (components in `[0,1]`), and `DEFAULT_ACCENT = '#0ea5e9'`. Task 2 imports all three names.

- [ ] **Step 1: Write the failing test**

Create `tests/transitions/accent.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { deriveAccentColors, DEFAULT_ACCENT } from '../../src/transitions/accent.js';

describe('deriveAccentColors', () => {
  it('parses 6-digit hex into normalized rgb', () => {
    const { accent } = deriveAccentColors('#ff8000');
    expect(accent[0]).toBeCloseTo(1.0, 5);
    expect(accent[1]).toBeCloseTo(128 / 255, 5);
    expect(accent[2]).toBeCloseTo(0.0, 5);
  });

  it('accepts hex without leading #', () => {
    expect(deriveAccentColors('0ea5e9').accent).toEqual(deriveAccentColors('#0ea5e9').accent);
  });

  it('defaults to DEFAULT_ACCENT when called without args', () => {
    expect(DEFAULT_ACCENT).toBe('#0ea5e9');
    expect(deriveAccentColors().accent).toEqual(deriveAccentColors(DEFAULT_ACCENT).accent);
  });

  it('derives dark as 0.35x and bright as mix-toward-white 0.65', () => {
    const { accent, accentDark, accentBright } = deriveAccentColors('#0ea5e9');
    for (let i = 0; i < 3; i++) {
      expect(accentDark[i]).toBeCloseTo(accent[i] * 0.35, 5);
      expect(accentBright[i]).toBeCloseTo(accent[i] + (1 - accent[i]) * 0.65, 5);
    }
  });

  it('throws a clear error on malformed input', () => {
    expect(() => deriveAccentColors('#12')).toThrow(/Invalid accent color/);
    expect(() => deriveAccentColors('red')).toThrow(/Invalid accent color/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transitions/accent.test.ts`
Expected: FAIL — `Cannot find module '../../src/transitions/accent.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transitions/accent.ts`:

```typescript
/** RGB triple with components normalized to [0, 1]. */
export type Vec3 = [number, number, number];

export interface AccentColors {
  accent: Vec3;
  accentDark: Vec3;
  accentBright: Vec3;
}

/** Default accent used when `export.transition.accent` is not configured. */
export const DEFAULT_ACCENT = '#0ea5e9';

/**
 * Parse a 6-digit hex color and derive the dark/bright variants the ported
 * hyperframes shaders expect (edge glow, burn tinting). Dark is a simple
 * luminance scale; bright mixes toward white.
 */
export function deriveAccentColors(hex: string = DEFAULT_ACCENT): AccentColors {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) {
    throw new Error(`Invalid accent color "${hex}" — expected a 6-digit hex like #0ea5e9`);
  }
  const n = parseInt(m[1], 16);
  const accent: Vec3 = [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  const accentDark = accent.map((v) => v * 0.35) as Vec3;
  const accentBright = accent.map((v) => v + (1 - v) * 0.65) as Vec3;
  return { accent, accentDark, accentBright };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transitions/accent.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/transitions/accent.ts tests/transitions/accent.test.ts
git -c commit.gpgsign=false commit -m "feat(transitions): accent color derivation for shader uniforms"
```

---

### Task 2: Accent + resolution uniform plumbing (harness, cache key, config, call sites)

**Files:**
- Modify: `src/transitions/shader-page.html.ts` (signature + uniform setup)
- Modify: `src/transitions/shader-render.ts` (`computeShaderHash`, `RenderShaderFramesOptions`, `renderShaderFrames`, `renderShaderTransitions`)
- Modify: `src/config.ts:97-101` (`ShaderTransitionConfig`)
- Modify: `src/pipeline.ts:434-442` and `src/pipeline.ts:643-651` (add `accent` to both `renderShaderTransitions` calls)
- Modify: `src/cli.ts:248-256` (same)
- Modify: `src/preview.ts:1077-1085` (same)
- Test: `tests/transitions/shader-render.test.ts` (extend)

**Interfaces:**
- Consumes: `deriveAccentColors`, `AccentColors`, `DEFAULT_ACCENT` from `src/transitions/accent.ts` (Task 1).
- Produces: `buildShaderPageHtml(width, height, glsl, accent?: AccentColors)`; `computeShaderHash(shader, durationMs, fps, width, height, aPngPath, bPngPath, accentHex?: string)`; `RenderShaderFramesOptions.accent?: string`; `renderShaderTransitions` opts gain `accent?: string`; `ShaderTransitionConfig.accent?: string`. Tasks 3–5 rely on the harness setting `resolution`/`accent*` uniforms.

- [ ] **Step 1: Write the failing tests**

Append to `tests/transitions/shader-render.test.ts` (inside the file, after the existing `computeShaderHash` describe block; reuse its `tmp` fixture pattern):

```typescript
describe('computeShaderHash accent', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-shader-accent-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('different accent produces a different hash', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from([1, 2, 3]));
    writeFileSync(b, Buffer.from([4, 5, 6]));
    const h1 = computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, '#0ea5e9');
    const h2 = computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, '#ff0000');
    expect(h1).not.toBe(h2);
  });

  it('omitted accent equals DEFAULT_ACCENT hash', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const { DEFAULT_ACCENT } = await import('../../src/transitions/accent.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from([1, 2, 3]));
    writeFileSync(b, Buffer.from([4, 5, 6]));
    expect(computeShaderHash('crosswarp', 800, 30, 640, 360, a, b))
      .toBe(computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, DEFAULT_ACCENT));
  });
});

describe('buildShaderPageHtml uniforms', () => {
  it('embeds accent values and resolution setup', async () => {
    const { buildShaderPageHtml } = await import('../../src/transitions/shader-page.html.js');
    const { deriveAccentColors } = await import('../../src/transitions/accent.js');
    const html = buildShaderPageHtml(640, 360, 'void main(){}', deriveAccentColors('#ff8000'));
    expect(html).toContain('accentDark');
    expect(html).toContain('resolution');
    expect(html).toContain('gl.uniform2f');
  });

  it('accepts a shader-variant config with accent at compile time', () => {
    const cfg: TransitionConfig = {
      type: 'shader',
      shader: 'crosswarp',
      durationMs: 800,
      accent: '#ff8000',
    };
    expect(cfg.type).toBe('shader');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transitions/shader-render.test.ts`
Expected: FAIL — accent-hash test (hashes equal, 8th arg ignored), `buildShaderPageHtml` arity/TS error, and `accent` not assignable to `ShaderTransitionConfig`.

- [ ] **Step 3: Implement config + hash + harness + threading**

**3a.** In `src/config.ts`, replace the `ShaderTransitionConfig` interface (lines 97–101) with:

```typescript
export interface ShaderTransitionConfig {
  type: 'shader';
  shader: ShaderName;
  durationMs?: number;
  /** Accent hex color tinting edge-glow/burn effects in shaders that use it
   *  (e.g. ridged-burn, domain-warp, sdf-iris). Default '#0ea5e9'. */
  accent?: string;
}
```

**3b.** In `src/transitions/shader-render.ts`:

Add to imports: `import { deriveAccentColors, DEFAULT_ACCENT } from './accent.js';`

Replace `computeShaderHash` with (only the signature line, the `parts` line, and the JSDoc change — body otherwise identical):

```typescript
export function computeShaderHash(
  shader: string,
  durationMs: number,
  fps: number,
  width: number,
  height: number,
  aPngPath: string,
  bPngPath: string,
  accentHex: string = DEFAULT_ACCENT,
): string {
  const aHash = createHash('sha256').update(readFileSync(aPngPath)).digest('hex');
  const bHash = createHash('sha256').update(readFileSync(bPngPath)).digest('hex');
  const parts = [shader, durationMs, fps, width, height, aHash, bHash, accentHex].join('|');
  return createHash('sha256').update(parts).digest('hex').slice(0, 16);
}
```

Add `accent?: string;` to `RenderShaderFramesOptions` (with JSDoc `/** Accent hex for shaders using accent uniforms. Default DEFAULT_ACCENT. */`).

In `renderShaderFrames`, change the `buildShaderPageHtml` call to:

```typescript
const html = buildShaderPageHtml(
  opts.width,
  opts.height,
  SHADERS[opts.shader],
  deriveAccentColors(opts.accent),
);
```

Add `accent?: string;` to the `renderShaderTransitions` opts type, and inside it pass `accent: opts.accent` in the `renderShaderFrames` call and `opts.accent ?? DEFAULT_ACCENT` as the 8th arg to its `computeShaderHash` call.

**3c.** In `src/transitions/shader-page.html.ts`, change the signature to:

```typescript
import type { AccentColors } from './accent.js';

export function buildShaderPageHtml(
  width: number,
  height: number,
  fragmentShaderGlsl: string,
  accent?: AccentColors,
): string {
```

and insert immediately after the `gl.useProgram(prog);` line in the template (before the buffer setup):

```javascript
  // Optional uniforms — WebGL silently ignores uniform* calls with a null
  // location, so shaders that don't declare these are unaffected.
  const accentColors = ${JSON.stringify(accent ?? null)};
  if (accentColors) {
    const set3 = (name, v) => gl.uniform3f(gl.getUniformLocation(prog, name), v[0], v[1], v[2]);
    set3('accent', accentColors.accent);
    set3('accentDark', accentColors.accentDark);
    set3('accentBright', accentColors.accentBright);
  }
  gl.uniform2f(gl.getUniformLocation(prog, 'resolution'), ${width}, ${height});
```

**3d.** At each of the four call sites — `src/pipeline.ts:434`, `src/pipeline.ts:643`, `src/cli.ts:248`, `src/preview.ts:1077` — add one line to the `renderShaderTransitions({...})` object (all four use the local variable `shaderTransition`):

```typescript
          accent: shaderTransition.accent,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transitions/shader-render.test.ts && npx vitest run tests/transitions/accent.test.ts`
Expected: PASS (all, including pre-existing tests)

- [ ] **Step 5: Build to catch TS errors at call sites**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/transitions/shader-page.html.ts src/transitions/shader-render.ts src/config.ts src/pipeline.ts src/cli.ts src/preview.ts tests/transitions/shader-render.test.ts
git -c commit.gpgsign=false commit -m "feat(transitions): accent + resolution uniforms threaded through shader pipeline"
```

---

### Task 3: Port batch A — noise-based shaders + data-driven compile test

**Files:**
- Create: `src/transitions/shaders/domain-warp.glsl`
- Create: `src/transitions/shaders/ridged-burn.glsl`
- Create: `src/transitions/shaders/thermal-distortion.glsl`
- Create: `src/transitions/shaders/swirl-vortex.glsl`
- Modify: `src/transitions/shaders/index.ts` (register 4 names)
- Test: `tests/transitions/shader-render.test.ts` (update registry test; add data-driven compile smoke)

**Interfaces:**
- Consumes: harness from Task 2 (accent uniforms available).
- Produces: `SHADER_NAMES` grows to 9; the data-driven compile-smoke test Tasks 4–5 extend for free (it iterates `SHADER_NAMES`).

- [ ] **Step 1: Update the registry test to the new list and add the compile smoke (failing first)**

In `tests/transitions/shader-render.test.ts`, replace the `ships exactly the v1 five shaders` test with:

```typescript
  it('ships the v1 five plus the hyperframes ports', () => {
    expect(SHADER_NAMES).toEqual([
      'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
      'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
    ]);
  });
```

Append a new describe block at the end of the file:

```typescript
describe('every registered shader compiles and renders', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-shader-smoke-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it.skipIf(!hasFfmpeg)('renders one frame per shader without GL errors', async () => {
    const { renderShaderFrames } = await import('../../src/transitions/shader-render.js');
    const { chromium } = await import('playwright');
    // two tiny solid-color PNG fixtures via ffmpeg
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=red:s=64x36', '-frames:v', '1', a]);
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=blue:s=64x36', '-frames:v', '1', b]);
    const browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blacklist'],
    });
    try {
      for (const shader of SHADER_NAMES) {
        const outDir = join(tmp, shader);
        const n = await renderShaderFrames({
          shader, aPng: a, bPng: b, width: 64, height: 36,
          fps: 30, durationMs: 66, outputDir: outDir, browser,
        });
        expect(n, shader).toBeGreaterThanOrEqual(1);
        expect(existsSync(join(outDir, 'frame_0000.png')), shader).toBe(true);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/transitions/shader-render.test.ts`
Expected: FAIL — registry list mismatch (new names not yet registered).

- [ ] **Step 3: Create the four `.glsl` files**

Create `src/transitions/shaders/domain-warp.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "domain-warp"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

float hash(vec2 p){
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float vnoise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.,a=.5;
  mat2 R=mat2(.8,.6,-.6,.8);
  for(int i=0; i<5; i++){
    v+=a*vnoise(p);
    p=R*p*2.02;
    a*=.5;
  }
  return v;
}
void main(){
  vec2 q=vec2(fbm(vUv*3.),fbm(vUv*3.+vec2(5.2,1.3)));
  vec2 r=vec2(fbm(vUv*3.+q*4.+vec2(1.7,9.2)),fbm(vUv*3.+q*4.+vec2(8.3,2.8)));
  float n=fbm(vUv*3.+r*2.);
  vec2 warpDir=(q-.5)*.4;
  vec4 A=texture2D(from,clamp(vUv+warpDir*progress,0.,1.));
  vec4 B=texture2D(to,clamp(vUv-warpDir*(1.-progress),0.,1.));
  float e=smoothstep(progress-.08,progress+.08,n);
  float ed=abs(n-progress);
  float em=smoothstep(.1,0.,ed)*(1.-step(1.,progress));
  vec3 ec=mix(accentDark,accentBright,smoothstep(0.,.1,ed));
  gl_FragColor=vec4(mix(B,A,e).rgb+ec*em*2.,1.);
}
```

Create `src/transitions/shaders/ridged-burn.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "ridged-burn"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

float hash(vec2 p){
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float vnoise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.,a=.5;
  mat2 R=mat2(.8,.6,-.6,.8);
  for(int i=0; i<5; i++){
    v+=a*vnoise(p);
    p=R*p*2.02;
    a*=.5;
  }
  return v;
}
float ridged(vec2 p){
  float v=0.,a=.5;
  mat2 R=mat2(.8,.6,-.6,.8);
  for(int i=0; i<5; i++){
    v+=a*abs(vnoise(p)*2.-1.);
    p=R*p*2.02;
    a*=.5;
  }
  return v;
}
void main(){
  vec4 A=texture2D(from,vUv),B=texture2D(to,vUv);
  float n=ridged(vUv*4.);
  float e=smoothstep(progress-.04,progress+.04,n);
  float heat=smoothstep(.12,0.,abs(n-progress))*(1.-step(1.,progress));
  vec3 burn=mix(accentDark,accent,smoothstep(0.,.25,heat));
  burn=mix(burn,accentBright,smoothstep(.25,.5,heat));
  burn=mix(burn,vec3(1),smoothstep(.5,1.,heat));
  float sparks=step(.92,vnoise(vUv*80.))*heat*3.;
  gl_FragColor=vec4(mix(B,A,e).rgb+burn*heat*3.5+accentBright*sparks,1.);
}
```

Create `src/transitions/shaders/thermal-distortion.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "thermal-distortion"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

float hash(vec2 p){
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float vnoise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.,a=.5;
  mat2 R=mat2(.8,.6,-.6,.8);
  for(int i=0; i<5; i++){
    v+=a*vnoise(p);
    p=R*p*2.02;
    a*=.5;
  }
  return v;
}
void main(){
  float heat=progress*1.5;
  float yFade=smoothstep(1.,0.,vUv.y);
  float shimmer=sin(vUv.y*40.+fbm(vUv*6.)*8.)*fbm(vUv*3.+vec2(0.,progress*2.));
  float dispX=shimmer*heat*.03*yFade;
  vec2 fromUv=clamp(vUv+vec2(dispX,0.),0.,1.);
  vec4 A=texture2D(from,fromUv);
  float invShimmer=sin(vUv.y*40.+fbm(vUv*6.+3.)*8.)*fbm(vUv*3.+vec2(3.,progress*2.));
  float dispX2=invShimmer*(1.-progress)*.03*yFade;
  vec2 toUv=clamp(vUv+vec2(dispX2,0.),0.,1.);
  vec4 B=texture2D(to,toUv);
  float haze=heat*yFade*.15*(1.-progress);
  gl_FragColor=vec4(mix(A.rgb,B.rgb,progress)+accentBright*haze,1.);
}
```

Create `src/transitions/shaders/swirl-vortex.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "swirl-vortex"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

float hash(vec2 p){
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float vnoise(vec2 p){
  vec2 i=floor(p),f=fract(p);
  f=f*f*f*(f*(f*6.-15.)+10.);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p){
  float v=0.,a=.5;
  mat2 R=mat2(.8,.6,-.6,.8);
  for(int i=0; i<5; i++){
    v+=a*vnoise(p);
    p=R*p*2.02;
    a*=.5;
  }
  return v;
}
void main(){
  vec2 uv=vUv-.5;
  float dist=length(uv);
  float warp=fbm(vUv*4.)*.5;
  float fromAng=progress*(1.-dist)*10.+warp*progress*3.;
  float fs=sin(fromAng),fc=cos(fromAng);
  vec2 fromUv=clamp(vec2(uv.x*fc-uv.y*fs,uv.x*fs+uv.y*fc)+.5,0.,1.);
  float toAng=-(1.-progress)*(1.-dist)*10.-warp*(1.-progress)*3.;
  float ts=sin(toAng),tc=cos(toAng);
  vec2 toUv=clamp(vec2(uv.x*tc-uv.y*ts,uv.x*ts+uv.y*tc)+.5,0.,1.);
  vec4 A=texture2D(from,fromUv);
  vec4 B=texture2D(to,toUv);
  gl_FragColor=mix(A,B,progress);
}
```

- [ ] **Step 4: Register the four shaders**

In `src/transitions/shaders/index.ts`, replace the `SHADER_NAMES` and `SHADERS` declarations with:

```typescript
export const SHADER_NAMES = [
  'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
  'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
] as const;
export type ShaderName = (typeof SHADER_NAMES)[number];

export const SHADERS: Record<ShaderName, string> = Object.fromEntries(
  SHADER_NAMES.map((name) => [name, loadShader(name)]),
) as Record<ShaderName, string>;
```

(The `Object.fromEntries` form replaces the hand-written literal so Tasks 4–5 only touch `SHADER_NAMES`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transitions/shader-render.test.ts`
Expected: PASS — including the compile-smoke iterating all 9 shaders (needs ffmpeg + Playwright chromium installed; smoke test auto-skips without ffmpeg).

- [ ] **Step 6: Commit**

```bash
git add src/transitions/shaders/ tests/transitions/shader-render.test.ts
git -c commit.gpgsign=false commit -m "feat(transitions): port domain-warp, ridged-burn, thermal-distortion, swirl-vortex shaders from hyperframes"
```

---

### Task 4: Port batch B — geometric shaders

**Files:**
- Create: `src/transitions/shaders/whip-pan.glsl`
- Create: `src/transitions/shaders/gravitational-lens.glsl`
- Create: `src/transitions/shaders/cinematic-zoom.glsl`
- Create: `src/transitions/shaders/chromatic-split.glsl`
- Create: `src/transitions/shaders/flash-through-white.glsl`
- Modify: `src/transitions/shaders/index.ts` (append 5 names to `SHADER_NAMES`)
- Test: `tests/transitions/shader-render.test.ts` (update expected list)

**Interfaces:**
- Consumes: `Object.fromEntries` registry form from Task 3 (only `SHADER_NAMES` changes).
- Produces: `SHADER_NAMES` grows to 14.

- [ ] **Step 1: Update the registry list test (failing first)**

In `tests/transitions/shader-render.test.ts`, replace the expected array in `ships the v1 five plus the hyperframes ports` with:

```typescript
    expect(SHADER_NAMES).toEqual([
      'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
      'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
      'whip-pan', 'gravitational-lens', 'cinematic-zoom', 'chromatic-split', 'flash-through-white',
    ]);
```

Run: `npx vitest run tests/transitions/shader-render.test.ts` — Expected: FAIL (list mismatch).

- [ ] **Step 2: Create the five `.glsl` files**

Create `src/transitions/shaders/whip-pan.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "whip-pan"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  float fromOff=progress*1.5;
  vec3 fromC=vec3(0.);
  for(int i=0; i<10; i++){
    float f=float(i)/10.;
    vec2 fuv=vec2(vUv.x+fromOff+progress*.08*f,vUv.y);
    fromC+=texture2D(from,clamp(fuv,0.,1.)).rgb;
  }
  fromC/=10.;
  float toOff=(1.-progress)*1.5;
  vec3 toC=vec3(0.);
  for(int i=0; i<10; i++){
    float f=float(i)/10.;
    vec2 tuv=vec2(vUv.x-toOff-(1.-progress)*.08*f,vUv.y);
    toC+=texture2D(to,clamp(tuv,0.,1.)).rgb;
  }
  toC/=10.;
  gl_FragColor=vec4(mix(fromC,toC,progress),1.);
}
```

Create `src/transitions/shaders/gravitational-lens.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "gravitational-lens"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  vec4 B=texture2D(to,vUv);
  vec2 uv=vUv-.5;
  float dist=length(uv);
  float pull=progress*2.;
  float warpStr=pull*.3/(dist+.1);
  vec2 warped=clamp(vUv-uv*warpStr,0.,1.);
  vec4 A=texture2D(from,warped);
  float horizon=smoothstep(0.,.3,dist/(1.-progress*.85+.001));
  float shift=pull*.02/(dist+.2);
  float r=texture2D(from,clamp(vUv-uv*(warpStr+shift),0.,1.)).r;
  float b=texture2D(from,clamp(vUv-uv*(warpStr-shift),0.,1.)).b;
  vec3 lensed=vec3(r,A.g,b)*horizon;
  gl_FragColor=vec4(mix(lensed,B.rgb,smoothstep(.3,.9,progress)),1.);
}
```

Create `src/transitions/shaders/cinematic-zoom.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "cinematic-zoom"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  vec2 d=vUv-vec2(.5);
  float fromS=progress*.08;
  float toS=(1.-progress)*.06;
  float fr=0.,fg=0.,fb=0.;
  for(int i=0; i<12; i++){
    float f=float(i)/12.;
    fr+=texture2D(from,vUv-d*(fromS*1.06)*f).r;
    fg+=texture2D(from,vUv-d*fromS*f).g;
    fb+=texture2D(from,vUv-d*(fromS*.94)*f).b;
  }
  vec3 fromBl=vec3(fr,fg,fb)/12.;
  float tr=0.,tg=0.,tb=0.;
  for(int i=0; i<12; i++){
    float f=float(i)/12.;
    tr+=texture2D(to,vUv+d*(toS*1.06)*f).r;
    tg+=texture2D(to,vUv+d*toS*f).g;
    tb+=texture2D(to,vUv+d*(toS*.94)*f).b;
  }
  vec3 toBl=vec3(tr,tg,tb)/12.;
  gl_FragColor=vec4(mix(fromBl,toBl,progress),1.);
}
```

Create `src/transitions/shaders/chromatic-split.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "chromatic-split"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  vec2 c=vUv-.5;
  float fromShift=progress*.06;
  float fr=texture2D(from,clamp(vUv+c*fromShift,0.,1.)).r;
  float fg=texture2D(from,vUv).g;
  float fb=texture2D(from,clamp(vUv-c*fromShift,0.,1.)).b;
  vec3 fromSplit=vec3(fr,fg,fb);
  float toShift=(1.-progress)*.06;
  float tr=texture2D(to,clamp(vUv-c*toShift,0.,1.)).r;
  float tg=texture2D(to,vUv).g;
  float tb=texture2D(to,clamp(vUv+c*toShift,0.,1.)).b;
  vec3 toSplit=vec3(tr,tg,tb);
  gl_FragColor=vec4(mix(fromSplit,toSplit,progress),1.);
}
```

Create `src/transitions/shaders/flash-through-white.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "flash-through-white"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  vec4 A=texture2D(from,vUv),B=texture2D(to,vUv);
  float toWhite=smoothstep(0.,.45,progress);
  vec3 fromC=mix(A.rgb,vec3(1.),toWhite);
  float fromWhite=1.-smoothstep(.5,1.,progress);
  vec3 toC=mix(B.rgb,vec3(1.),fromWhite);
  gl_FragColor=vec4(mix(fromC,toC,smoothstep(.35,.65,progress)),1.);
}
```

- [ ] **Step 3: Append the five names to `SHADER_NAMES`**

In `src/transitions/shaders/index.ts`:

```typescript
export const SHADER_NAMES = [
  'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
  'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
  'whip-pan', 'gravitational-lens', 'cinematic-zoom', 'chromatic-split', 'flash-through-white',
] as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transitions/shader-render.test.ts`
Expected: PASS — compile smoke now covers 14 shaders.

- [ ] **Step 5: Commit**

```bash
git add src/transitions/shaders/ tests/transitions/shader-render.test.ts
git -c commit.gpgsign=false commit -m "feat(transitions): port whip-pan, gravitational-lens, cinematic-zoom, chromatic-split, flash-through-white shaders"
```

---

### Task 5: Port batch C — resolution/accent shaders

**Files:**
- Create: `src/transitions/shaders/sdf-iris.glsl`
- Create: `src/transitions/shaders/ripple-waves.glsl`
- Modify: `src/transitions/shaders/index.ts` (append 2 names)
- Test: `tests/transitions/shader-render.test.ts` (update expected list)

**Interfaces:**
- Consumes: `resolution` uniform from Task 2 (sdf-iris is the only shader that reads it — aspect-ratio-corrected iris circle).
- Produces: final `SHADER_NAMES` of 16.

- [ ] **Step 1: Update the registry list test (failing first)**

Replace the expected array with the final list:

```typescript
    expect(SHADER_NAMES).toEqual([
      'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
      'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
      'whip-pan', 'gravitational-lens', 'cinematic-zoom', 'chromatic-split', 'flash-through-white',
      'sdf-iris', 'ripple-waves',
    ]);
```

Run: `npx vitest run tests/transitions/shader-render.test.ts` — Expected: FAIL.

- [ ] **Step 2: Create the two `.glsl` files**

Create `src/transitions/shaders/sdf-iris.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "sdf-iris"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  vec4 A=texture2D(from,vUv),B=texture2D(to,vUv);
  vec2 uv=(vUv-.5)*vec2(resolution.x/resolution.y,1.);
  float d=length(uv);
  float radius=progress*1.2;
  float fw=.003;
  float edge=smoothstep(radius+fw,radius-fw,d);
  float ring1=exp(-abs(d-radius)*25.);
  float ring2=exp(-abs(d-radius+.04)*20.)*.5;
  float ring3=exp(-abs(d-radius+.08)*15.)*.25;
  float glow=(ring1+ring2+ring3)*progress*(1.-progress)*4.;
  gl_FragColor=vec4(mix(A,B,edge).rgb+accentBright*glow*.6,1.);
}
```

Create `src/transitions/shaders/ripple-waves.glsl` with exactly:

```glsl
// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "ripple-waves"
// License: Apache-2.0
precision mediump float;
uniform sampler2D from;
uniform sampler2D to;
uniform float progress;
uniform vec2 resolution;
uniform vec3 accent;
uniform vec3 accentDark;
uniform vec3 accentBright;
varying vec2 vUv;

void main(){
  vec2 uv=vUv-.5;
  float dist=length(uv);
  vec2 dir=normalize(uv+.001);
  float fromAmp=progress*.04;
  float fw1=exp(sin(dist*25.-progress*12.)-1.);
  float fw2=exp(sin(dist*50.-progress*18.)-1.)*.5;
  vec2 fromUv=clamp(vUv+dir*(fw1+fw2)*fromAmp,0.,1.);
  float toAmp=(1.-progress)*.04;
  float tw1=exp(sin(dist*25.+progress*12.)-1.);
  float tw2=exp(sin(dist*50.+progress*18.)-1.)*.5;
  vec2 toUv=clamp(vUv-dir*(tw1+tw2)*toAmp,0.,1.);
  vec4 A=texture2D(from,fromUv);
  vec4 B=texture2D(to,toUv);
  float peak=fw1*progress;
  vec3 tint=accentBright*peak*.1;
  gl_FragColor=vec4(mix(A.rgb+tint,B.rgb,progress),1.);
}
```

- [ ] **Step 3: Append the two names to `SHADER_NAMES`** (same pattern as Task 4 Step 3, final list as in Step 1's test).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transitions/shader-render.test.ts`
Expected: PASS — compile smoke covers all 16.

- [ ] **Step 5: Commit**

```bash
git add src/transitions/shaders/ tests/transitions/shader-render.test.ts
git -c commit.gpgsign=false commit -m "feat(transitions): port sdf-iris and ripple-waves shaders from hyperframes"
```

---

### Task 6: Docs sync + full verification

**Files:**
- Modify: `README.md` (shader transition list + `accent` config option — find the section documenting `export.transition`)
- Modify: `CLAUDE.md` (Shader Transitions section: "v1 ships: crosswarp, swirl, ripple, luma-mask, light-leak" → add "plus 11 hyperframes ports (Apache-2.0): domain-warp, ridged-burn, thermal-distortion, swirl-vortex, whip-pan, gravitational-lens, cinematic-zoom, chromatic-split, flash-through-white, sdf-iris, ripple-waves. `export.transition.accent` tints accent-aware shaders.")
- Modify: `skills/argo-guide/` — grep for shader names (`grep -rn "crosswarp\|luma-mask" skills/`) and update any list that enumerates available shaders + document `accent`.

**Interfaces:**
- Consumes: final 16-shader registry from Task 5.
- Produces: nothing downstream — this closes Track 1.

- [ ] **Step 1: Update README**

Find the transition config docs: `grep -n "shader" README.md`. Add the 11 new names to any shader enumeration and document the new option with this snippet style:

```js
export default defineConfig({
  export: {
    transition: {
      type: 'shader',
      shader: 'ridged-burn',
      durationMs: 2000,
      accent: '#0ea5e9', // tints edge glow/burn in accent-aware shaders
    },
  },
});
```

- [ ] **Step 2: Update CLAUDE.md and the argo-guide skill** as listed under Files. For the skill, check `skills/argo-guide/SKILL.md` and `skills/argo-guide/references/` for shader enumerations.

- [ ] **Step 3: Full verification**

Run: `npm run build && npm test`
Expected: build exit 0; all tests pass. Then verify dist copy picked up the new files:

Run: `ls dist/transitions/shaders/*.glsl | wc -l`
Expected: `16`

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md skills/
git -c commit.gpgsign=false commit -m "docs: document 11 new shader transitions and accent config"
```

---

## Self-Review Notes

- **Spec coverage:** accent config (Task 1–2), uniform shim + attribution + self-contained GLSL (Tasks 3–5), README/validate/skill sync (Task 6; shader-name validation is type-driven via `ShaderName` so no separate validate change is needed), cache-key correctness (Task 2 — accent added to hash, a spec-implied requirement since different accents produce different frames).
- **Duplicates skipped per spec:** `cross-warp-morph` (≈ existing `crosswarp`), `light-leak` (name collision with existing).
- **Type consistency:** `AccentColors`/`deriveAccentColors`/`DEFAULT_ACCENT` names match across Tasks 1–2; `SHADER_NAMES` list is stated in full in each task that changes it.
