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
