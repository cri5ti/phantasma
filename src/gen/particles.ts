// Particles: smoke, rain, dust, stars, leaves, snow, embers… — deterministic: every particle is a closed-form function
// of its age (no simulation state), so scrubbing and parallel rendering are exact.
//   spawn  i-th particle at i / rate (+ jitter), plus `burst` particles on every beat
//   motion position from initial velocity, gravity + wind, linear drag (analytic), turbulence + sway (sum of sines)
//   look   size / colour / alpha over life, twinkle, spin, 10 shapes, blend mode
import { parseColor } from '../core/params';
import { mulberry32, type GenDef } from './types';

const SHAPES = ['dot', 'soft', 'streak', 'square', 'star', 'smoke', 'leaf', 'flake', 'spark', 'ring'];
const EMITTERS = ['area', 'top', 'bottom', 'left', 'right', 'point', 'ring'];

// soft round sprites per colour (white radial gradient tinted), cached
const sprites = new Map<string, HTMLCanvasElement>();
function sprite(rgb: string, hard = 0.0): HTMLCanvasElement {
  const key = `${rgb}|${hard}`;
  let c = sprites.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, `rgba(${rgb},1)`);
  gr.addColorStop(Math.max(0.05, hard), `rgba(${rgb},${hard ? 1 : 0.65})`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  if (sprites.size > 300) sprites.clear();
  sprites.set(key, c);
  return c;
}

function hueShift([r, g, b]: number[], deg: number): number[] {
  if (!deg) return [r, g, b];
  // rotate in YIQ space (cheap, good enough for variation)
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const y = 0.299 * r + 0.587 * g + 0.114 * b, i = 0.596 * r - 0.274 * g - 0.322 * b, q = 0.211 * r - 0.523 * g + 0.312 * b;
  const i2 = i * cos - q * sin, q2 = i * sin + q * cos;
  return [y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2].map((v) => Math.max(0, Math.min(255, v)));
}

export const particles: GenDef = {
  id: 'particles',
  name: 'Particles',
  category: 'particles',
  params: [
    { key: 'emitter', type: 'select', default: 'area', options: EMITTERS, group: 'Emitter', static: true, hint: 'area = anywhere · top/bottom/left/right = enter from that edge · point / ring = from (x, y)' },
    { key: 'ex', label: 'X', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Emitter' },
    { key: 'ey', label: 'Y', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Emitter' },
    { key: 'ew', label: 'Width', type: 'number', default: 1.1, min: 0, max: 3, step: 0.01, group: 'Emitter', hint: 'spread of the emitter (fraction of the frame); ring = radius' },
    { key: 'eh', label: 'Height', type: 'number', default: 1.1, min: 0, max: 3, step: 0.01, group: 'Emitter' },
    { key: 'rate', label: 'Rate /s', type: 'number', default: 60, min: 0, max: 3000, step: 1, group: 'Emitter', static: true, hint: 'particles per second (static — changing it re-seeds the stream)' },
    { key: 'burst', label: 'Burst / beat', type: 'number', default: 0, min: 0, max: 400, step: 1, group: 'Emitter', static: true, hint: 'extra particles on every beat of the tempo map' },
    { key: 'barOnly', label: 'Burst on bars only', type: 'bool', default: false, group: 'Emitter', static: true },
    { key: 'life', label: 'Life (s)', type: 'number', default: 4, min: 0.05, max: 60, step: 0.05, group: 'Emitter', static: true },
    { key: 'lifeVar', label: 'Life variation', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Emitter', static: true },
    { key: 'prewarm', label: 'Pre-warm', type: 'bool', default: true, group: 'Emitter', static: true, hint: 'start full (as if it had been running already)' },
    { key: 'maxCount', label: 'Max particles', type: 'number', default: 2500, min: 10, max: 20000, step: 10, group: 'Emitter', static: true },
    { key: 'seed', type: 'number', default: 0, min: 0, max: 9999, step: 1, group: 'Emitter', static: true },

    { key: 'dir', label: 'Direction°', type: 'number', default: 90, min: -360, max: 360, step: 1, group: 'Physics', hint: '0 = right, 90 = down, 270 = up' },
    { key: 'spread', label: 'Spread°', type: 'number', default: 20, min: 0, max: 180, step: 1, group: 'Physics' },
    { key: 'speed', type: 'number', default: 120, min: 0, max: 5000, step: 1, group: 'Physics', hint: 'px / s' },
    { key: 'speedVar', label: 'Speed variation', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Physics' },
    { key: 'gravX', label: 'Wind', type: 'number', default: 0, min: -3000, max: 3000, step: 1, group: 'Physics', hint: 'horizontal acceleration px/s²' },
    { key: 'gravY', label: 'Gravity', type: 'number', default: 0, min: -3000, max: 3000, step: 1, group: 'Physics', hint: 'px/s² (negative = rises)' },
    { key: 'drag', type: 'number', default: 0, min: 0, max: 10, step: 0.01, group: 'Physics', hint: 'air resistance (1/s) — particles settle to a terminal speed' },
    { key: 'turb', label: 'Turbulence', type: 'number', default: 0, min: 0, max: 600, step: 1, group: 'Physics', hint: 'wandering, px' },
    { key: 'turbFreq', label: 'Turbulence speed', type: 'number', default: 0.4, min: 0, max: 8, step: 0.01, group: 'Physics' },
    { key: 'sway', type: 'number', default: 0, min: 0, max: 400, step: 1, group: 'Physics', hint: 'side-to-side swing (leaves, snow)' },
    { key: 'swayFreq', label: 'Sway speed', type: 'number', default: 0.4, min: 0, max: 8, step: 0.01, group: 'Physics' },
    { key: 'spin', label: 'Spin°/s', type: 'number', default: 0, min: -2000, max: 2000, step: 1, group: 'Physics' },
    { key: 'spinVar', label: 'Spin variation', type: 'number', default: 1, min: 0, max: 1, step: 0.01, group: 'Physics', hint: '1 = random direction and speed' },

    { key: 'shape', type: 'select', default: 'soft', options: SHAPES, group: 'Look', static: true },
    { key: 'size', type: 'number', default: 6, min: 0.2, max: 800, step: 0.1, group: 'Look' },
    { key: 'sizeVar', label: 'Size variation', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'sizeEnd', label: 'Size at death', type: 'number', default: 1, min: 0, max: 8, step: 0.01, group: 'Look', hint: 'multiplier over life (smoke grows, sparks shrink)' },
    { key: 'stretch', type: 'number', default: 1, min: 0, max: 10, step: 0.01, group: 'Look', hint: 'streak / spark length along the motion' },
    { key: 'color', type: 'color', default: '#ffffff', group: 'Look' },
    { key: 'color2', label: 'Color 2', type: 'color', default: '#ffffff', group: 'Look' },
    { key: 'colorMix', label: 'Color mix', type: 'select', default: 'random', options: ['random', 'over life'], group: 'Look', static: true },
    { key: 'hueVar', label: 'Hue variation°', type: 'number', default: 0, min: 0, max: 180, step: 1, group: 'Look' },
    { key: 'alpha', label: 'Opacity', type: 'number', default: 1, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'fadeIn', label: 'Fade in', type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, group: 'Look', hint: 'fraction of life' },
    { key: 'fadeOut', label: 'Fade out', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'twinkle', type: 'number', default: 0, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'blendMode', label: 'Blend', type: 'select', default: 'source-over', options: ['source-over', 'lighter', 'screen'], group: 'Look', static: true },
  ],
  draw(ctx, p, f) {
    const W = f.W, H = f.H;
    const rate = Math.max(0, p.rate);
    const lifeMax = p.life * (1 + p.lifeVar);
    const T = f.layerT + (p.prewarm ? lifeMax : 0);
    if (T < 0) return;
    const c1 = parseColor(p.color), c2 = parseColor(p.color2);
    ctx.globalCompositeOperation = p.blendMode;
    const deg = Math.PI / 180;
    const k = p.drag;
    const margin = Math.max(20, p.size * 2);
    const layerStart = f.t - f.layerT;

    // ---- who is alive: continuous stream + beat bursts --------------------------------------------
    const spawns: { id: number; s: number }[] = [];
    if (rate > 0) {
      const i1 = Math.floor(T * rate);
      const i0 = Math.max(0, Math.ceil((T - lifeMax) * rate) - 1, i1 - p.maxCount);
      for (let i = i0; i <= i1; i++) spawns.push({ id: i, s: i / rate });
    }
    if (p.burst > 0) {
      // beats in the window (song time), mapped into the stream's clock
      const off = p.prewarm ? lifeMax : 0;
      const beats = f.tempo.beatsBetween(Math.max(layerStart, f.t - lifeMax), f.t).filter((b) => !p.barOnly || b.bar);
      for (const b of beats) {
        const bs = b.t - layerStart + off;
        const bid = Math.round(b.t * 1000) * 1000 + 7_000_000_000;
        for (let j = 0; j < p.burst; j++) spawns.push({ id: bid + j, s: bs });
      }
    }
    const cap = Math.max(10, Math.round(p.maxCount));
    const list = spawns.length > cap ? spawns.slice(spawns.length - cap) : spawns;

    for (const sp of list) {
      const r = mulberry32((sp.id * 2654435761) ^ (f.seed + p.seed * 7919));
      const jitter = rate > 0 && sp.id < 7_000_000_000 ? r() / rate : (r(), 0);
      const life = p.life * (1 + p.lifeVar * (r() * 2 - 1));
      const age = T - (sp.s + jitter);
      if (age < 0 || age >= life) { continue; }
      const u = age / life;

      // emitter position
      let x0: number, y0: number;
      const rx = r(), ry = r();
      switch (p.emitter) {
        case 'top': x0 = (p.ex + (rx - 0.5) * p.ew) * W; y0 = -margin; break;
        case 'bottom': x0 = (p.ex + (rx - 0.5) * p.ew) * W; y0 = H + margin; break;
        case 'left': x0 = -margin; y0 = (p.ey + (ry - 0.5) * p.eh) * H; break;
        case 'right': x0 = W + margin; y0 = (p.ey + (ry - 0.5) * p.eh) * H; break;
        case 'point': x0 = (p.ex + (rx - 0.5) * p.ew * 0.05) * W; y0 = (p.ey + (ry - 0.5) * p.eh * 0.05) * H; break;
        case 'ring': { const a = rx * Math.PI * 2, R = (p.ew * Math.min(W, H)) / 2; x0 = p.ex * W + Math.cos(a) * R; y0 = p.ey * H + Math.sin(a) * R; break; }
        default: x0 = (p.ex + (rx - 0.5) * p.ew) * W; y0 = (p.ey + (ry - 0.5) * p.eh) * H;
      }
      // initial velocity
      const ang = (p.dir + p.spread * (r() * 2 - 1)) * deg;
      const spd = p.speed * (1 + p.speedVar * (r() * 2 - 1));
      const vx0 = Math.cos(ang) * spd, vy0 = Math.sin(ang) * spd;
      // analytic motion with drag:  v(a) = g/k + (v0 - g/k)e^(-ka),  x(a) = x0 + (g/k)a + (v0 - g/k)(1 - e^(-ka))/k
      let x: number, y: number, vx: number, vy: number;
      if (k < 1e-4) {
        x = x0 + vx0 * age + 0.5 * p.gravX * age * age; y = y0 + vy0 * age + 0.5 * p.gravY * age * age;
        vx = vx0 + p.gravX * age; vy = vy0 + p.gravY * age;
      } else {
        const e = Math.exp(-k * age), tx = p.gravX / k, ty = p.gravY / k;
        x = x0 + tx * age + ((vx0 - tx) * (1 - e)) / k; y = y0 + ty * age + ((vy0 - ty) * (1 - e)) / k;
        vx = tx + (vx0 - tx) * e; vy = ty + (vy0 - ty) * e;
      }
      const ph1 = r() * 6.283, ph2 = r() * 6.283, ph3 = r() * 6.283, ph4 = r() * 6.283;
      if (p.turb > 0) {
        const w = 6.283 * p.turbFreq;
        x += p.turb * (0.6 * Math.sin(w * age + ph1) + 0.4 * Math.sin(w * 2.3 * age + ph2));
        y += p.turb * (0.6 * Math.sin(w * 0.9 * age + ph2) + 0.4 * Math.sin(w * 1.7 * age + ph1));
      }
      if (p.sway > 0) x += p.sway * Math.sin(6.283 * p.swayFreq * age + ph3);
      // looks
      let size = p.size * (1 + p.sizeVar * (r() * 2 - 1)) * (1 + (p.sizeEnd - 1) * u);
      if (size <= 0.05) continue;
      if (x < -size * 3 - margin || x > W + size * 3 + margin || y < -size * 3 - margin || y > H + size * 3 + margin) continue;
      let a = p.alpha;
      if (p.fadeIn > 0 && u < p.fadeIn) a *= u / p.fadeIn;
      if (p.fadeOut > 0 && u > 1 - p.fadeOut) a *= (1 - u) / p.fadeOut;
      if (p.twinkle > 0) a *= 1 - p.twinkle * 0.5 * (1 + Math.sin(6.283 * (1.2 + r() * 3) * age + ph4));
      if (a <= 0.003) continue;
      const mix = p.colorMix === 'over life' ? u : r();
      const hv = p.hueVar ? (r() * 2 - 1) * p.hueVar : (r(), 0);
      const rgb = hueShift([c1[0] + (c2[0] - c1[0]) * mix, c1[1] + (c2[1] - c1[1]) * mix, c1[2] + (c2[2] - c1[2]) * mix], hv).map((v) => Math.round(v / 8) * 8);
      const rgbS = `${rgb[0]},${rgb[1]},${rgb[2]}`;
      const spinV = p.spin * (1 - p.spinVar + 2 * p.spinVar * r());
      const rot = (r() * 360 + spinV * age) * deg;
      ctx.globalAlpha = Math.min(1, a);

      switch (p.shape) {
        case 'dot':
          ctx.fillStyle = `rgb(${rgbS})`;
          ctx.beginPath(); ctx.arc(x, y, size / 2, 0, 6.283); ctx.fill();
          break;
        case 'soft':
        case 'smoke': {
          const sp2 = sprite(rgbS, 0);
          const s = p.shape === 'smoke' ? size : size * 1.6;
          if (p.shape === 'smoke') { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, 0.8); ctx.drawImage(sp2, -s / 2, -s / 2, s, s); ctx.restore(); }
          else ctx.drawImage(sp2, x - s / 2, y - s / 2, s, s);
          break;
        }
        case 'streak':
        case 'spark': {
          const v = Math.hypot(vx, vy) || 1;
          const len = size + v * 0.03 * p.stretch * (p.shape === 'spark' ? 0.6 : 1);
          ctx.strokeStyle = `rgb(${rgbS})`;
          ctx.lineWidth = p.shape === 'spark' ? size * 0.6 : Math.max(0.5, size * 0.35);
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (vx / v) * len, y - (vy / v) * len); ctx.stroke();
          if (p.shape === 'spark') { const sp2 = sprite(rgbS, 0); ctx.drawImage(sp2, x - size, y - size, size * 2, size * 2); }
          break;
        }
        case 'square':
          ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
          // confetti tumbles: squash with the spin
          ctx.scale(1, Math.abs(Math.cos(rot * 1.7)) * 0.8 + 0.2);
          ctx.fillStyle = `rgb(${rgbS})`; ctx.fillRect(-size / 2, -size * 0.3, size, size * 0.6);
          ctx.restore();
          break;
        case 'star': {
          const sp2 = sprite(rgbS, 0);
          ctx.drawImage(sp2, x - size, y - size, size * 2, size * 2);
          ctx.save(); ctx.translate(x, y); ctx.rotate(rot * 0.1);
          ctx.fillStyle = `rgb(${rgbS})`;
          const L = size * 2.2, w = size * 0.18;
          ctx.beginPath(); ctx.moveTo(0, -L); ctx.lineTo(w, 0); ctx.lineTo(0, L); ctx.lineTo(-w, 0); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(-L, 0); ctx.lineTo(0, w); ctx.lineTo(L, 0); ctx.lineTo(0, -w); ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
        }
        case 'leaf':
          ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
          ctx.scale(1, Math.abs(Math.cos(rot * 0.7)) * 0.7 + 0.3);
          ctx.fillStyle = `rgb(${rgbS})`;
          ctx.beginPath(); ctx.ellipse(0, 0, size / 2, size * 0.22, 0, 0, 6.283); ctx.fill();
          ctx.strokeStyle = `rgba(0,0,0,0.25)`; ctx.lineWidth = Math.max(0.5, size * 0.04);
          ctx.beginPath(); ctx.moveTo(-size / 2, 0); ctx.lineTo(size / 2, 0); ctx.stroke();
          ctx.restore();
          break;
        case 'flake':
          ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
          ctx.strokeStyle = `rgb(${rgbS})`; ctx.lineWidth = Math.max(0.6, size * 0.1); ctx.lineCap = 'round';
          for (let j = 0; j < 3; j++) { ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.moveTo(-size / 2, 0); ctx.lineTo(size / 2, 0); ctx.stroke(); }
          ctx.restore();
          break;
        case 'ring':
          ctx.strokeStyle = `rgb(${rgbS})`; ctx.lineWidth = Math.max(0.5, size * 0.08);
          ctx.beginPath(); ctx.arc(x, y, size / 2, 0, 6.283); ctx.stroke();
          break;
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  },
  presets: {
    Rain: { emitter: 'top', ew: 1.4, rate: 900, life: 1.3, lifeVar: 0.2, dir: 100, spread: 3, speed: 1500, speedVar: 0.15, gravY: 400, shape: 'streak', size: 2, sizeVar: 0.4, stretch: 1.3, color: '#a9c4ff', color2: '#ffffff', alpha: 0.5, fadeIn: 0.05, fadeOut: 0.1, prewarm: true },
    Snow: { emitter: 'top', ew: 1.3, rate: 90, life: 16, lifeVar: 0.25, dir: 90, spread: 15, speed: 85, speedVar: 0.45, gravY: 4, drag: 0.05, sway: 30, swayFreq: 0.3, turb: 12, turbFreq: 0.2, shape: 'soft', size: 7, sizeVar: 0.6, color: '#ffffff', color2: '#dfe9ff', alpha: 0.9, fadeIn: 0.05, fadeOut: 0.15, prewarm: true },
    Dust: { emitter: 'area', rate: 40, life: 8, lifeVar: 0.5, speed: 10, spread: 180, turb: 25, turbFreq: 0.15, shape: 'dot', size: 2.4, sizeVar: 0.7, color: '#ffe9c4', color2: '#fff6e0', alpha: 0.5, twinkle: 0.5, fadeIn: 0.3, fadeOut: 0.3, blendMode: 'lighter', prewarm: true },
    Stars: { emitter: 'area', ew: 1, eh: 1, rate: 50, life: 24, lifeVar: 0.4, speed: 0, speedVar: 0, shape: 'star', size: 3, sizeVar: 0.8, twinkle: 0.8, color: '#ffffff', color2: '#a8cbff', colorMix: 'random', fadeIn: 0.15, fadeOut: 0.15, blendMode: 'lighter', prewarm: true },
    Smoke: { emitter: 'bottom', ex: 0.5, ew: 0.8, rate: 18, life: 9, lifeVar: 0.3, dir: 270, spread: 25, speed: 120, speedVar: 0.4, gravY: -25, drag: 0.25, turb: 45, turbFreq: 0.12, shape: 'smoke', size: 200, sizeVar: 0.4, sizeEnd: 2.8, spin: 12, spinVar: 1, color: '#c4c4ce', color2: '#8e8e9c', alpha: 0.32, fadeIn: 0.2, fadeOut: 0.6, blendMode: 'screen', prewarm: true },
    Leaves: { emitter: 'top', ew: 1.3, rate: 5, life: 10, lifeVar: 0.3, dir: 100, spread: 25, speed: 80, speedVar: 0.4, gravY: 20, drag: 0.3, sway: 70, swayFreq: 0.28, turb: 30, turbFreq: 0.2, spin: 120, spinVar: 1, shape: 'leaf', size: 28, sizeVar: 0.4, color: '#d9822b', color2: '#8a9a2b', colorMix: 'random', alpha: 0.95, fadeIn: 0.03, fadeOut: 0.08, prewarm: true },
    Embers: { emitter: 'bottom', ew: 0.9, rate: 50, life: 3, lifeVar: 0.5, dir: 270, spread: 30, speed: 220, speedVar: 0.5, gravY: -60, drag: 0.5, turb: 30, turbFreq: 0.8, shape: 'spark', size: 3, sizeVar: 0.6, sizeEnd: 0.3, stretch: 0.8, color: '#ffc06b', color2: '#ff4b1f', colorMix: 'over life', twinkle: 0.4, blendMode: 'lighter', prewarm: true },
    Bokeh: { emitter: 'area', rate: 4, life: 10, lifeVar: 0.5, speed: 14, spread: 180, turb: 20, turbFreq: 0.1, shape: 'soft', size: 130, sizeVar: 0.6, color: '#ffd9a0', color2: '#a0c8ff', colorMix: 'random', alpha: 0.25, fadeIn: 0.3, fadeOut: 0.3, blendMode: 'lighter', prewarm: true },
    Confetti: { emitter: 'top', ew: 1.2, rate: 120, life: 6, lifeVar: 0.3, dir: 90, spread: 30, speed: 250, speedVar: 0.6, gravY: 150, drag: 0.8, sway: 40, swayFreq: 0.8, spin: 360, spinVar: 1, shape: 'square', size: 12, sizeVar: 0.4, color: '#ff5aa0', color2: '#4dd4ff', hueVar: 160, alpha: 1, fadeIn: 0, fadeOut: 0.1, prewarm: true },
    Fireflies: { emitter: 'area', rate: 8, life: 6, lifeVar: 0.4, speed: 25, spread: 180, turb: 50, turbFreq: 0.25, shape: 'soft', size: 14, sizeVar: 0.4, color: '#d4ff6b', color2: '#fff3a0', alpha: 0.9, twinkle: 0.9, fadeIn: 0.3, fadeOut: 0.3, blendMode: 'lighter', prewarm: true },
    'Beat burst': { emitter: 'point', ex: 0.5, ey: 0.5, rate: 0, burst: 40, life: 1.6, lifeVar: 0.3, dir: 0, spread: 180, speed: 650, speedVar: 0.6, drag: 2, gravY: 200, shape: 'spark', size: 4, sizeEnd: 0.2, stretch: 1, color: '#ffffff', color2: '#ffcf40', colorMix: 'over life', blendMode: 'lighter', prewarm: false },
  },
};
