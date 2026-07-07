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
