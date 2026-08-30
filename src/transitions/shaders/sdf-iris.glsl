// Adapted from hyperframes (github.com/heygen-com/hyperframes)
// packages/shader-transitions/src/shaders/registry.ts — "sdf-iris"
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
  vec2 uv=(vUv-.5)*vec2(resolution.x/resolution.y,1.);
  float d=length(uv);
  float radius=progress*1.2;
  float fw=.003;
  float edge=smoothstep(radius+fw,radius-fw,d);
  float ring1=exp(-abs(d-radius)*25.);
  float ring2=exp(-abs(d-radius+.04)*20.)*.5;
  float ring3=exp(-abs(d-radius+.08)*15.)*.25;
  float glow=(ring1+ring2+ring3)*progress*(1.-progress)*4.;
  gl_FragColor=vec4(mix(A,B,edge).rgb+accentBright*glow*.6,1.);
}
