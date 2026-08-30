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
