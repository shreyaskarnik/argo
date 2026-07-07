# Shader Transitions

WebGL fragment shaders used for cinematic scene transitions. Pre-rendered via Playwright Chromium at export time and composited into the output video as a PNG sequence.

## Attribution

The original five shaders are adapted from [gl-transitions.com](https://gl-transitions.com) (MIT) unless otherwise noted. The remaining eleven are adapted from [hyperframes](https://github.com/heygen-com/hyperframes) (`packages/shader-transitions/src/shaders/registry.ts`, Apache-2.0).

| Shader              | Original Author           | License    |
|---------------------|---------------------------|------------|
| crosswarp           | Eke Péter                 | MIT        |
| swirl               | Sergey Kosarevsky         | MIT        |
| ripple              | gre                       | MIT        |
| luma-mask           | adapted from gre          | MIT        |
| light-leak          | Argo original             | MIT        |
| domain-warp         | adapted from hyperframes  | Apache-2.0 |
| ridged-burn         | adapted from hyperframes  | Apache-2.0 |
| thermal-distortion  | adapted from hyperframes  | Apache-2.0 |
| swirl-vortex        | adapted from hyperframes  | Apache-2.0 |
| whip-pan            | adapted from hyperframes  | Apache-2.0 |
| gravitational-lens  | adapted from hyperframes  | Apache-2.0 |
| cinematic-zoom      | adapted from hyperframes  | Apache-2.0 |
| chromatic-split     | adapted from hyperframes  | Apache-2.0 |
| flash-through-white | adapted from hyperframes  | Apache-2.0 |
| sdf-iris            | adapted from hyperframes  | Apache-2.0 |
| ripple-waves        | adapted from hyperframes  | Apache-2.0 |

All shaders use the gl-transitions fragment shader interface:

- `uniform sampler2D from` — outgoing scene last frame
- `uniform sampler2D to` — incoming scene first frame
- `uniform float progress` — 0..1 transition progress
- `varying vec2 vUv` — normalized coord
- Output: `gl_FragColor`

Accent-aware shaders (`domain-warp`, `ridged-burn`, `thermal-distortion`, `sdf-iris`, `ripple-waves`) additionally receive accent uniforms derived from `export.transition.accent` (default `#0ea5e9`):

- `uniform vec3 accent` — configured accent color
- `uniform vec3 accentDark` — darkened variant
- `uniform vec3 accentBright` — brightened variant
