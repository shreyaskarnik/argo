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
