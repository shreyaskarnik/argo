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
