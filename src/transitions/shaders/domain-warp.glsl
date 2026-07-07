// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "domain-warp"
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
  vec2 q=vec2(fbm(vUv*3.),fbm(vUv*3.+vec2(5.2,1.3)));
  vec2 r=vec2(fbm(vUv*3.+q*4.+vec2(1.7,9.2)),fbm(vUv*3.+q*4.+vec2(8.3,2.8)));
  float n=fbm(vUv*3.+r*2.);
  vec2 warpDir=(q-.5)*.4;
  vec4 A=texture2D(from,clamp(vUv+warpDir*progress,0.,1.));
  vec4 B=texture2D(to,clamp(vUv-warpDir*(1.-progress),0.,1.));
  float e=smoothstep(progress-.08,progress+.08,n);
  float ed=abs(n-progress);
  float em=smoothstep(.1,0.,ed)*(1.-step(1.,progress));
  vec3 ec=mix(accentDark,accentBright,smoothstep(0.,.1,ed));
  gl_FragColor=vec4(mix(B,A,e).rgb+ec*em*2.,1.);
}
