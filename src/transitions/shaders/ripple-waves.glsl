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
