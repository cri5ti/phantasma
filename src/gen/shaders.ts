// Fullscreen GLSL generators rendered on one shared WebGL2 canvas, then blitted into the layer's 2D canvas.
import type { ParamDef, Values } from '../core/params';
import { parseColor } from '../core/params';
import type { ScalarName } from '../core/audio';
import type { FrameCtx, GenDef } from './types';

const VERT = `#version 300 es
in vec2 p; out vec2 vUv;
void main(){ vUv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform vec2 uRes; uniform float uTime, uTravel, uBeat, uPulse, uBar, uBass, uMid, uHigh, uRms, uOnset;
uniform float uSpec[32];
float spec(float x){ x = clamp(x,0.,1.)*31.; int i = int(floor(x)); int j = min(i+1,31); return mix(uSpec[i], uSpec[j], fract(x)); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<6;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return v; }
`;

class GL {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  programs = new Map<string, { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> }>();
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  }
  program(id: string, frag: string) {
    let p = this.programs.get(id);
    if (p) return p;
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader ${id}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, HEADER + frag));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link ${id}: ${gl.getProgramInfoLog(prog)}`);
    p = { prog, loc: new Map() };
    this.programs.set(id, p);
    return p;
  }
  render(id: string, frag: string, w: number, h: number, set: (u: (name: string) => WebGLUniformLocation | null, gl: WebGL2RenderingContext) => void) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const p = this.program(id, frag);
    gl.viewport(0, 0, w, h);
    gl.useProgram(p.prog);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => {
      if (!p!.loc.has(name)) p!.loc.set(name, gl.getUniformLocation(p!.prog, name));
      return p!.loc.get(name)!;
    };
    set(u, gl);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

let shared: GL | null = null;
const getGL = () => (shared ??= new GL());

const spec32 = new Float32Array(32);

interface ShaderSpec {
  id: string;
  name: string;
  params: ParamDef[];
  frag: string;
}

const travelParams: ParamDef[] = [
  { key: 'speed', type: 'number', default: 1, min: -5, max: 5, step: 0.01, group: 'Motion' },
  { key: 'drive', label: 'Speed source', type: 'select', default: 'rms', options: ['none', 'rms', 'bass', 'mid', 'high', 'onset'], group: 'Motion', static: true },
  { key: 'driveAmount', label: 'Drive amount', type: 'number', default: 2, min: 0, max: 20, step: 0.1, group: 'Motion' },
];

function shaderGen(s: ShaderSpec): GenDef {
  const custom = s.params.filter((d) => d.type === 'number' || d.type === 'color');
  return {
    id: s.id,
    name: s.name,
    category: 'shader',
    params: [...travelParams, ...s.params],
    draw(ctx: CanvasRenderingContext2D, p: Values, f: FrameCtx) {
      const m = ctx.getTransform();
      const sx = Math.hypot(m.a, m.b), sy = Math.hypot(m.c, m.d);
      const w = Math.max(2, Math.round(f.W * sx));
      const h = Math.max(2, Math.round(f.H * sy));
      const a = f.audio;
      const src = p.drive as ScalarName | 'none';
      const travel = p.speed * (f.t + (a && src !== 'none' ? p.driveAmount * a.integral(src, f.t) : 0));
      if (a) a.bars(f.t, 32, 0.08, 0, 0.95, spec32);
      const canvas = getGL().render(s.id, s.frag, w, h, (u, gl) => {
        gl.uniform2f(u('uRes'), w, h);
        gl.uniform1f(u('uTime'), f.t);
        gl.uniform1f(u('uTravel'), travel);
        gl.uniform1f(u('uBeat'), f.beat.beat);
        gl.uniform1f(u('uPulse'), Math.exp(-f.beat.sinceBeat / 0.15));
        gl.uniform1f(u('uBar'), Math.exp(-f.beat.sinceBar / 0.4));
        gl.uniform1f(u('uBass'), a ? a.scalar('bass', f.t, 0.1) : 0);
        gl.uniform1f(u('uMid'), a ? a.scalar('mid', f.t, 0.1) : 0);
        gl.uniform1f(u('uHigh'), a ? a.scalar('high', f.t, 0.1) : 0);
        gl.uniform1f(u('uRms'), a ? a.scalar('rms', f.t, 0.1) : 0);
        gl.uniform1f(u('uOnset'), a ? a.scalar('onset', f.t, 0.05) : 0);
        gl.uniform1fv(u('uSpec[0]'), spec32);
        for (const d of custom) {
          if (d.type === 'number') gl.uniform1f(u(`u_${d.key}`), p[d.key]);
          else {
            const c = parseColor(p[d.key]);
            gl.uniform4f(u(`u_${d.key}`), c[0] / 255, c[1] / 255, c[2] / 255, c[3]);
          }
        }
      });
      // drawn in stage units so the layer transform (scale/rotate/offset) applies
      ctx.drawImage(canvas, 0, 0, f.W, f.H);
    },
  };
}

export const tunnel = shaderGen({
  id: 'tunnel',
  name: 'Tunnel',
  params: [
    { key: 'rings', type: 'number', default: 6, min: 1, max: 30, step: 0.1, group: 'Look' },
    { key: 'segments', type: 'number', default: 12, min: 0, max: 64, step: 1, group: 'Look' },
    { key: 'twist', type: 'number', default: 0.3, min: -3, max: 3, step: 0.01, group: 'Look' },
    { key: 'thickness', type: 'number', default: 0.08, min: 0.005, max: 0.5, step: 0.005, group: 'Look' },
    { key: 'pulse', label: 'Beat pulse', type: 'number', default: 0.6, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'cx', label: 'Center X', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Look' },
    { key: 'cy', label: 'Center Y', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Look' },
    { key: 'colorA', type: 'color', default: '#ff4fd8', group: 'Color' },
    { key: 'colorB', type: 'color', default: '#3ad7ff', group: 'Color' },
    { key: 'fog', type: 'number', default: 1.2, min: 0, max: 5, step: 0.01, group: 'Color' },
    { key: 'gain', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Color' },
  ],
  frag: `
uniform float u_rings, u_segments, u_twist, u_thickness, u_pulse, u_cx, u_cy, u_fog, u_gain;
uniform vec4 u_colorA, u_colorB;
void main(){
  vec2 uv = (gl_FragCoord.xy - vec2(u_cx, u_cy)*uRes) / uRes.y;
  float r = length(uv); float a = atan(uv.y, uv.x);
  float z = 0.35 / max(r, 1e-3);
  float zz = z + uTravel;
  // anti-aliased lines of roughly constant on-screen width (thickness ≈ px / 25)
  float rv = zz * u_rings / 6.0;
  float ring = 0.5 - abs(fract(rv) - 0.5);
  float w = u_thickness * 25.0 * (1.0 + u_pulse * uPulse);
  float line = 1.0 - smoothstep(0.0, w * fwidth(rv) + 1e-4, ring);
  float sv = (a / 6.2831 + zz * u_twist * 0.1) * u_segments;
  float sd = 0.5 - abs(fract(sv) - 0.5);
  float seg = u_segments > 0.5 ? 1.0 - smoothstep(0.0, w * 0.6 * fwidth(sv) + 1e-4, sd) : 0.0;
  float s = spec(fract(a / 6.2831 + 0.5));
  vec3 col = mix(u_colorA.rgb, u_colorB.rgb, 0.5 + 0.5 * sin(zz * 0.7 + a * 2.0 * u_twist));
  float v = (line + seg * 0.6) * (0.6 + 1.4 * s) ;
  float fog = exp(-u_fog * max(z - 0.4, 0.0) * 0.6) * smoothstep(0.0, 0.08, r);
  vec3 c = min(col * v * fog * u_gain * (1.0 + 0.6 * uBass), vec3(1.0));
  outColor = vec4(c, max(c.r, max(c.g, c.b)));
}`,
});

export const nebula = shaderGen({
  id: 'nebula',
  name: 'Nebula',
  params: [
    { key: 'scale', type: 'number', default: 2.2, min: 0.2, max: 10, step: 0.01, group: 'Look' },
    { key: 'warp', type: 'number', default: 1.6, min: 0, max: 6, step: 0.01, group: 'Look' },
    { key: 'contrast', type: 'number', default: 1.6, min: 0.2, max: 5, step: 0.01, group: 'Look' },
    { key: 'bassBoost', label: 'Bass glow', type: 'number', default: 0.8, min: 0, max: 4, step: 0.01, group: 'Look' },
    { key: 'stars', type: 'number', default: 0.6, min: 0, max: 2, step: 0.01, group: 'Look' },
    { key: 'colorA', type: 'color', default: '#0b0630', group: 'Color' },
    { key: 'colorB', type: 'color', default: '#7a2cff', group: 'Color' },
    { key: 'colorC', type: 'color', default: '#ff9a5a', group: 'Color' },
    { key: 'gain', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Color' },
  ],
  frag: `
uniform float u_scale, u_warp, u_contrast, u_bassBoost, u_stars, u_gain;
uniform vec4 u_colorA, u_colorB, u_colorC;
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / uRes.y * u_scale;
  float t = uTravel * 0.08;
  vec2 q = vec2(fbm(uv + t), fbm(uv + vec2(5.2,1.3) - t));
  vec2 r = vec2(fbm(uv + u_warp*q + vec2(1.7,9.2) + t*1.3), fbm(uv + u_warp*q + vec2(8.3,2.8)));
  float f = fbm(uv + u_warp * r);
  f = pow(clamp(f, 0.0, 1.0), u_contrast);
  vec3 col = mix(u_colorA.rgb, u_colorB.rgb, clamp(f*2.0, 0.0, 1.0));
  col = mix(col, u_colorC.rgb, clamp(length(q) * f * (0.6 + u_bassBoost * uBass), 0.0, 1.0));
  vec2 g = floor(gl_FragCoord.xy / 3.0);
  float st = step(0.997, hash(g)) * (0.5 + 0.5 * sin(uTime * 3.0 + hash(g + 3.1) * 40.0)) * u_stars;
  col += st * (0.6 + uHigh);
  outColor = vec4(col * u_gain, 1.0);
}`,
});

export const synthgrid = shaderGen({
  id: 'synthgrid',
  name: 'Synth Grid',
  params: [
    { key: 'horizon', type: 'number', default: 0.55, min: 0.1, max: 0.9, step: 0.005, group: 'Look' },
    { key: 'density', type: 'number', default: 10, min: 1, max: 40, step: 0.1, group: 'Look' },
    { key: 'lineWidth', type: 'number', default: 0.03, min: 0.002, max: 0.2, step: 0.001, group: 'Look' },
    { key: 'sunSize', type: 'number', default: 0.28, min: 0, max: 0.8, step: 0.005, group: 'Look' },
    { key: 'terrain', label: 'Spectrum hills', type: 'number', default: 0.6, min: 0, max: 3, step: 0.01, group: 'Look' },
    { key: 'gridColor', type: 'color', default: '#ff3ad1', group: 'Color' },
    { key: 'skyA', type: 'color', default: '#07001a', group: 'Color' },
    { key: 'skyB', type: 'color', default: '#3a0b52', group: 'Color' },
    { key: 'sunA', type: 'color', default: '#ffd34f', group: 'Color' },
    { key: 'sunB', type: 'color', default: '#ff2d95', group: 'Color' },
  ],
  frag: `
uniform float u_horizon, u_density, u_lineWidth, u_sunSize, u_terrain;
uniform vec4 u_gridColor, u_skyA, u_skyB, u_sunA, u_sunB;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float asp = uRes.x / uRes.y;
  vec3 col;
  if (uv.y > u_horizon) {
    float k = (uv.y - u_horizon) / (1.0 - u_horizon);
    col = mix(u_skyB.rgb, u_skyA.rgb, k);
    vec2 sp = vec2((uv.x - 0.5) * asp, uv.y - u_horizon - u_sunSize * 0.55);
    float d = length(sp);
    float sz = u_sunSize * (1.0 + 0.08 * uBass);
    if (d < sz) {
      float sy = (sp.y / sz) * 0.5 + 0.5;
      float bars = step(0.5, fract(sy * 10.0 + uTravel * 0.3)) + step(0.55, sy);
      col = mix(col, mix(u_sunB.rgb, u_sunA.rgb, sy), clamp(bars, 0.0, 1.0));
    }
    col += u_sunB.rgb * 0.25 * exp(-d * 6.0) * (1.0 + uRms);
  } else {
    float y = (u_horizon - uv.y) / u_horizon;
    float z = 1.0 / max(y, 1e-3);
    float x = (uv.x - 0.5) * asp * z;
    float hill = spec(clamp(abs(uv.x - 0.5) * 2.0, 0.0, 1.0)) * u_terrain * smoothstep(0.0, 0.5, abs(uv.x - 0.5));
    float gz = fract((z + uTravel) * u_density * 0.1);
    float gx = fract(x * u_density * 0.1 + hill * 0.3);
    float w = u_lineWidth * z * 0.4;
    float line = max(smoothstep(w, 0.0, min(gz, 1.0 - gz)), smoothstep(w, 0.0, min(gx, 1.0 - gx)));
    float fade = smoothstep(0.0, 0.25, y);
    col = mix(u_skyA.rgb * 0.5, u_gridColor.rgb * (1.2 + uPulse), line * fade);
  }
  outColor = vec4(col, 1.0);
}`,
});

export const spectrumRings = shaderGen({
  id: 'spectrumRings',
  name: 'Spectrum Rings',
  params: [
    { key: 'rings', type: 'number', default: 18, min: 2, max: 60, step: 1, group: 'Look' },
    { key: 'radius', type: 'number', default: 0.45, min: 0.05, max: 1.5, step: 0.005, group: 'Look' },
    { key: 'sharp', label: 'Sharpness', type: 'number', default: 0.35, min: 0.01, max: 1, step: 0.01, group: 'Look' },
    { key: 'cx', label: 'Center X', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Look' },
    { key: 'cy', label: 'Center Y', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Look' },
    { key: 'colorA', type: 'color', default: '#00f0ff', group: 'Color' },
    { key: 'colorB', type: 'color', default: '#ff2fa0', group: 'Color' },
    { key: 'gain', type: 'number', default: 1.2, min: 0, max: 4, step: 0.01, group: 'Color' },
  ],
  frag: `
uniform float u_rings, u_radius, u_sharp, u_cx, u_cy, u_gain;
uniform vec4 u_colorA, u_colorB;
void main(){
  vec2 uv = (gl_FragCoord.xy - vec2(u_cx,u_cy)*uRes) / uRes.y;
  float r = length(uv) / u_radius;
  float k = r * u_rings;
  float idx = floor(k);
  float s = spec(idx / u_rings);
  float band = smoothstep(u_sharp, 0.0, abs(fract(k - uTravel*0.5) - 0.5)) * step(r, 1.0);
  vec3 col = mix(u_colorA.rgb, u_colorB.rgb, idx / u_rings);
  vec3 c = col * band * pow(s, 1.5) * u_gain * (1.0 + 0.5*uPulse);
  outColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0));
}`,
});

export const SHADERS = [tunnel, nebula, synthgrid, spectrumRings];
