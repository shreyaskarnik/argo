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
