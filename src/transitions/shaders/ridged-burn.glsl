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
