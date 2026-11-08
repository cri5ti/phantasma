// @name Scene
// A scene layer: a GLSL fragment shader, recompiled on save. See src/gen/scene.ts for everything available.
//
// Header lines → inspector controls + injected uniforms (don't declare them yourself):
//   @tex plate        → sampler2D t_plate, vec2 t_plate_size (px) — pick the image in the inspector
//   @param gain ...   → float u_gain        @param tint color ... → vec4 u_tint
//
// @tex   plate
// @param gain    number 1 0 4
// @param tint    color  #ffffff
// @param loopSec number 8 0.5 60 group=Loop hint="the animation repeats exactly every N seconds"

void main(){
  float ph = fract(uTime / u_loopSec);           // 0..1 loop phase: build all motion from it for seamless loops
  vec2 uv = coverUV(vUv, t_plate_size);          // fill the frame like object-fit: cover
  vec3 c = texture(t_plate, uv).rgb * u_tint.rgb * u_gain;
  c *= 0.9 + 0.1 * sin(6.2831853 * ph);          // a gentle looping pulse
  c *= 1.0 + 0.3 * uPulse;                       // + a kick on each beat
  outColor = vec4(c, 1.0);
}
