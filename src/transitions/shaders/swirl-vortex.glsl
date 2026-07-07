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
