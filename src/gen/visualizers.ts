// Audio visualizers drawn with Canvas 2D.
import { mixColor, withAlpha } from '../core/params';
import type { ScalarName } from '../core/audio';
import { mulberry32, type GenDef } from './types';

const SOURCES = ['rms', 'bass', 'mid', 'high', 'onset', 'centroid'];

const colorParams = (a: string, b: string) => [
  { key: 'colorA', label: 'Color A', type: 'color', default: a, group: 'Color' },
  { key: 'colorB', label: 'Color B', type: 'color', default: b, group: 'Color' },
  { key: 'glow', label: 'Glow', type: 'number', default: 0, min: 0, max: 80, step: 1, group: 'Color' },
] as const;

function glow(ctx: CanvasRenderingContext2D, amount: number, color: string) {
  ctx.shadowBlur = amount;
  ctx.shadowColor = amount > 0 ? color : 'transparent';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

export const spectrum: GenDef = {
  id: 'spectrum',
  name: 'Spectrum Bars',
  category: 'visualizer',
  params: [
    { key: 'style', type: 'select', default: 'bars', options: ['bars', 'line', 'fill', 'dots'], group: 'Shape', static: true },
    { key: 'count', label: 'Bars', type: 'number', default: 64, min: 4, max: 256, step: 1, group: 'Shape' },
    { key: 'x', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Shape' },
    { key: 'y', type: 'number', default: 0.85, min: 0, max: 1, step: 0.005, group: 'Shape' },
    { key: 'width', type: 'number', default: 0.8, min: 0.05, max: 1.5, step: 0.005, group: 'Shape' },
    { key: 'height', type: 'number', default: 360, min: 10, max: 1200, step: 1, group: 'Shape' },
    { key: 'gap', type: 'number', default: 0.35, min: 0, max: 0.95, step: 0.01, group: 'Shape' },
    { key: 'radius', label: 'Corner', type: 'number', default: 4, min: 0, max: 40, step: 1, group: 'Shape' },
    { key: 'minHeight', label: 'Min height', type: 'number', default: 3, min: 0, max: 60, step: 1, group: 'Shape' },
    { key: 'mirror', type: 'select', default: 'none', options: ['none', 'vertical', 'reflect'], group: 'Shape' },
    { key: 'symmetric', label: 'Symmetric L/R', type: 'bool', default: false, group: 'Shape' },
    { key: 'lineWidth', type: 'number', default: 4, min: 1, max: 30, step: 0.5, group: 'Shape' },
    { key: 'lo', label: 'Freq low', type: 'number', default: 0, min: 0, max: 1, step: 0.01, group: 'Audio' },
    { key: 'hi', label: 'Freq high', type: 'number', default: 0.92, min: 0, max: 1, step: 0.01, group: 'Audio' },
    { key: 'gain', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Audio' },
    { key: 'curve', label: 'Contrast', type: 'number', default: 1.6, min: 0.3, max: 5, step: 0.05, group: 'Audio' },
    { key: 'release', label: 'Falloff (s)', type: 'number', default: 0.12, min: 0, max: 1.5, step: 0.01, group: 'Audio' },
    ...colorParams('#ffffff', '#7fdcff'),
    { key: 'gradient', type: 'select', default: 'horizontal', options: ['horizontal', 'vertical', 'level'], group: 'Color' },
  ],
  draw(ctx, p, f) {
    if (!f.audio) return;
    const n = Math.round(p.count);
    const half = p.symmetric ? Math.ceil(n / 2) : n;
    const vals = f.audio.bars(f.t, half, p.release, p.lo, p.hi);
    const W = f.W * p.width;
    const x0 = f.W * p.x - W / 2;
    const yb = f.H * p.y;
    const slot = W / n;
    const bw = slot * (1 - p.gap);
    const level = (i: number) => {
      const j = p.symmetric ? (i < half ? half - 1 - i : i - half + (n % 2 ? 1 : 0)) : i;
      const v = Math.pow(Math.min(1, vals[Math.max(0, Math.min(half - 1, j))] * p.gain), p.curve);
      return Math.max(p.minHeight, v * p.height);
    };
    const colorAt = (i: number, h: number) =>
      p.gradient === 'level' ? mixColor(p.colorA, p.colorB, Math.min(1, h / p.height)) : mixColor(p.colorA, p.colorB, i / Math.max(1, n - 1));
    if (p.gradient === 'vertical') {
      const g = ctx.createLinearGradient(0, yb, 0, yb - p.height);
      g.addColorStop(0, p.colorA);
      g.addColorStop(1, p.colorB);
      ctx.fillStyle = g;
      ctx.strokeStyle = g;
    }
    glow(ctx, p.glow, p.colorB);

    if (p.style === 'bars' || p.style === 'dots') {
      for (let i = 0; i < n; i++) {
        const h = level(i);
        const x = x0 + i * slot + (slot - bw) / 2;
        if (p.gradient !== 'vertical') ctx.fillStyle = colorAt(i, h);
        if (p.style === 'dots') {
          const step = bw * 1.25;
          for (let y = 0; y < h; y += step) {
            ctx.beginPath();
            ctx.arc(x + bw / 2, yb - y - bw / 2, bw / 2, 0, Math.PI * 2);
            ctx.fill();
            if (p.mirror === 'vertical') { ctx.beginPath(); ctx.arc(x + bw / 2, yb + y + bw / 2, bw / 2, 0, Math.PI * 2); ctx.fill(); }
          }
          continue;
        }
        if (p.mirror === 'vertical') roundRect(ctx, x, yb - h / 2, bw, h, p.radius);
        else roundRect(ctx, x, yb - h, bw, h, p.radius);
        if (p.mirror === 'reflect') {
          ctx.save();
          ctx.globalAlpha *= 0.25;
          roundRect(ctx, x, yb + 4, bw, h * 0.5, p.radius);
          ctx.restore();
        }
      }
      return;
    }
    // line / fill
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) pts.push([x0 + (i + 0.5) * slot, level(i)]);
    const sign = p.mirror === 'vertical' ? [1, -1] : [1];
    if (p.gradient === 'horizontal') {
      const g = ctx.createLinearGradient(x0, 0, x0 + W, 0);
      g.addColorStop(0, p.colorA);
      g.addColorStop(1, p.colorB);
      ctx.fillStyle = g;
      ctx.strokeStyle = g;
    } else if (p.gradient === 'level') {
      ctx.fillStyle = ctx.strokeStyle = p.colorA;
    }
    for (const s of sign) {
      const yAt = (h: number) => (p.mirror === 'vertical' ? yb - (s * h) / 2 : yb - h);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], yAt(pts[0][1]));
      for (let i = 1; i < pts.length; i++) {
        const [xa, ha] = pts[i - 1];
        const [xb, hb] = pts[i];
        ctx.quadraticCurveTo(xa, yAt(ha), (xa + xb) / 2, (yAt(ha) + yAt(hb)) / 2);
      }
      ctx.lineTo(pts[pts.length - 1][0], yAt(pts[pts.length - 1][1]));
      if (p.style === 'fill') {
        ctx.lineTo(pts[pts.length - 1][0], yb);
        ctx.lineTo(pts[0][0], yb);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.lineWidth = p.lineWidth;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }
  },
};

export const radial: GenDef = {
  id: 'radial',
  name: 'Radial Spectrum',
  category: 'visualizer',
  params: [
    { key: 'style', type: 'select', default: 'bars', options: ['bars', 'line', 'dots', 'blob'], group: 'Shape', static: true },
    { key: 'count', label: 'Bars', type: 'number', default: 120, min: 8, max: 360, step: 1, group: 'Shape' },
    { key: 'x', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Shape' },
    { key: 'y', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Shape' },
    { key: 'radius', type: 'number', default: 220, min: 0, max: 900, step: 1, group: 'Shape' },
    { key: 'length', type: 'number', default: 160, min: 0, max: 900, step: 1, group: 'Shape' },
    { key: 'inward', label: 'Inward', type: 'number', default: 0, min: 0, max: 1, step: 0.01, group: 'Shape', hint: 'fraction of bar drawn toward the centre' },
    { key: 'lineWidth', type: 'number', default: 4, min: 0.5, max: 40, step: 0.5, group: 'Shape' },
    { key: 'rotation', type: 'number', default: -90, min: -360, max: 360, step: 1, group: 'Shape' },
    { key: 'spin', label: 'Spin °/beat', type: 'number', default: 0, min: -90, max: 90, step: 0.5, group: 'Shape' },
    { key: 'symmetric', label: 'Symmetric', type: 'bool', default: true, group: 'Shape' },
    { key: 'bassPush', label: 'Bass → radius', type: 'number', default: 40, min: 0, max: 400, step: 1, group: 'Audio' },
    { key: 'lo', label: 'Freq low', type: 'number', default: 0, min: 0, max: 1, step: 0.01, group: 'Audio' },
    { key: 'hi', label: 'Freq high', type: 'number', default: 0.85, min: 0, max: 1, step: 0.01, group: 'Audio' },
    { key: 'gain', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Audio' },
    { key: 'curve', label: 'Contrast', type: 'number', default: 1.5, min: 0.3, max: 5, step: 0.05, group: 'Audio' },
    { key: 'release', label: 'Falloff (s)', type: 'number', default: 0.1, min: 0, max: 1.5, step: 0.01, group: 'Audio' },
    ...colorParams('#ffffff', '#ff6ad5'),
    { key: 'fillCenter', label: 'Center fill', type: 'color', default: '#00000000', group: 'Color' },
  ],
  draw(ctx, p, f) {
    if (!f.audio) return;
    const n = Math.round(p.count);
    const half = p.symmetric ? Math.ceil(n / 2) : n;
    const vals = f.audio.bars(f.t, half, p.release, p.lo, p.hi);
    const cx = f.W * p.x;
    const cy = f.H * p.y;
    const r0 = p.radius + p.bassPush * f.audio.scalar('bass', f.t, 0.12);
    const rot = ((p.rotation + p.spin * f.beat.beat) * Math.PI) / 180;
    const level = (i: number) => {
      const j = p.symmetric ? (i < half ? i : n - 1 - i) : i;
      return Math.pow(Math.min(1, vals[Math.max(0, Math.min(half - 1, j))] * p.gain), p.curve) * p.length;
    };
    if (p.fillCenter && !p.fillCenter.endsWith('00')) {
      ctx.fillStyle = p.fillCenter;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, r0 - 2), 0, Math.PI * 2);
      ctx.fill();
    }
    glow(ctx, p.glow, p.colorB);
    ctx.lineCap = 'round';
    ctx.lineWidth = p.lineWidth;
    if (p.style === 'line' || p.style === 'blob') {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = rot + (i / n) * Math.PI * 2;
        const r = r0 + level(i % n);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(cx, cy, r0 * 0.5, cx, cy, r0 + p.length);
      g.addColorStop(0, p.colorA);
      g.addColorStop(1, p.colorB);
      if (p.style === 'blob') { ctx.fillStyle = g; ctx.fill(); }
      else { ctx.strokeStyle = g; ctx.stroke(); }
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const L = Math.max(1, level(i));
      const c = mixColor(p.colorA, p.colorB, Math.min(1, L / Math.max(1, p.length)));
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rin = r0 - L * p.inward;
      const rout = r0 + L * (1 - p.inward);
      if (p.style === 'dots') {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(cx + ca * rout, cy + sa * rout, p.lineWidth, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(cx + ca * rin, cy + sa * rin);
        ctx.lineTo(cx + ca * rout, cy + sa * rout);
        ctx.stroke();
      }
    }
  },
};

export const waveform: GenDef = {
  id: 'waveform',
  name: 'Oscilloscope',
  category: 'visualizer',
  params: [
    { key: 'style', type: 'select', default: 'line', options: ['line', 'filled', 'circle'], group: 'Shape', static: true },
    { key: 'x', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Shape' },
    { key: 'y', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Shape' },
    { key: 'width', type: 'number', default: 1, min: 0.05, max: 1.5, step: 0.005, group: 'Shape' },
    { key: 'amplitude', type: 'number', default: 220, min: 0, max: 1000, step: 1, group: 'Shape' },
    { key: 'radius', label: 'Circle radius', type: 'number', default: 260, min: 10, max: 900, step: 1, group: 'Shape' },
    { key: 'lineWidth', type: 'number', default: 3, min: 0.5, max: 30, step: 0.5, group: 'Shape' },
    { key: 'smooth', label: 'Smoothing', type: 'number', default: 2, min: 0, max: 12, step: 1, group: 'Shape' },
    { key: 'echoes', label: 'Trails', type: 'number', default: 0, min: 0, max: 12, step: 1, group: 'Shape', hint: 'previous frames drawn fading' },
    ...colorParams('#ffffff', '#00e5ff'),
  ],
  draw(ctx, p, f) {
    if (!f.audio) return;
    const echoes = Math.round(p.echoes);
    for (let e = echoes; e >= 0; e--) {
      const w = f.audio.wave(f.t - e * (1 / 30));
      const n = w.length;
      const s = Math.round(p.smooth);
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0, c = 0;
        for (let k = -s; k <= s; k++) { const j = i + k; if (j >= 0 && j < n) { acc += w[j]; c++; } }
        v[i] = acc / c;
      }
      ctx.save();
      ctx.globalAlpha *= e === 0 ? 1 : 0.5 * (1 - e / (echoes + 1));
      const color = e === 0 ? p.colorA : p.colorB;
      glow(ctx, p.glow, p.colorB);
      ctx.strokeStyle = color;
      ctx.fillStyle = withAlpha(color, 0.5);
      ctx.lineWidth = p.lineWidth;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (p.style === 'circle') {
        const cx = f.W * p.x, cy = f.H * p.y;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const r = p.radius + v[i % n] * p.amplitude * 0.5;
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      } else {
        const W = f.W * p.width;
        const x0 = f.W * p.x - W / 2;
        const yc = f.H * p.y;
        for (let i = 0; i < n; i++) {
          const x = x0 + (i / (n - 1)) * W;
          const y = yc + v[i] * p.amplitude;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        if (p.style === 'filled') {
          ctx.lineTo(x0 + W, yc);
          ctx.lineTo(x0, yc);
          ctx.closePath();
          ctx.fill();
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  },
};

export const particles: GenDef = {
  id: 'particles',
  name: 'Particles',
  category: 'visualizer',
  params: [
    { key: 'mode', type: 'select', default: 'starfield', options: ['starfield', 'rise', 'drift', 'burst'], group: 'Motion', static: true },
    { key: 'count', type: 'number', default: 500, min: 10, max: 4000, step: 10, group: 'Motion' },
    { key: 'speed', type: 'number', default: 1, min: 0, max: 10, step: 0.01, group: 'Motion' },
    { key: 'drive', label: 'Speed source', type: 'select', default: 'rms', options: ['none', ...SOURCES], group: 'Motion', static: true },
    { key: 'driveAmount', label: 'Drive amount', type: 'number', default: 3, min: 0, max: 20, step: 0.1, group: 'Motion', hint: 'extra travel when the source is loud' },
    { key: 'x', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Motion' },
    { key: 'y', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Motion' },
    { key: 'size', type: 'number', default: 3, min: 0.2, max: 40, step: 0.1, group: 'Look' },
    { key: 'sizeAudio', label: 'Size ← bass', type: 'number', default: 1, min: 0, max: 10, step: 0.05, group: 'Look' },
    { key: 'streak', label: 'Streaks', type: 'number', default: 0.6, min: 0, max: 4, step: 0.05, group: 'Look' },
    { key: 'twinkle', type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, group: 'Look' },
    { key: 'seed', type: 'number', default: 1, min: 0, max: 999, step: 1, group: 'Look', static: true },
    ...colorParams('#ffffff', '#9ad7ff'),
  ],
  draw(ctx, p, f) {
    const rnd = mulberry32(Math.round(p.seed) * 7919 + 13);
    const n = Math.round(p.count);
    const src = p.drive as ScalarName | 'none';
    // integrated "travel" = base time + audio-driven extra time (keeps motion deterministic & scrub-safe)
    const travel = p.speed * (f.t + (src !== 'none' && f.audio ? p.driveAmount * f.audio.integral(src, f.t) : 0));
    const bass = f.audio ? f.audio.scalar('bass', f.t, 0.1) : 0;
    const sz = p.size * (1 + p.sizeAudio * bass);
    const cx = f.W * p.x, cy = f.H * p.y;
    glow(ctx, p.glow, p.colorB);
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
      const col = mixColor(p.colorA, p.colorB, r3);
      const tw = 1 - p.twinkle * (0.5 + 0.5 * Math.sin(f.t * (2 + r4 * 6) + r1 * 50));
      if (p.mode === 'starfield') {
        const a = r1 * Math.PI * 2;
        const zf = (r2 + travel * 0.15) % 1; // 0 far → 1 near
        const z = 1 - zf;
        const persp = 0.06 / Math.max(0.02, z);
        const dist = (0.15 + r4 * 0.85) * persp * Math.max(f.W, f.H);
        const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
        const tail = dist * (1 - 1 / (1 + p.streak * 0.25 * (1 + bass)));
        ctx.globalAlpha = Math.min(1, zf * 1.6) * tw;
        ctx.strokeStyle = col;
        ctx.lineWidth = sz * (0.3 + zf);
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(a) * tail, y - Math.sin(a) * tail);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else if (p.mode === 'rise' || p.mode === 'drift') {
        const vy = p.mode === 'rise' ? 0.05 + r2 * 0.1 : (r2 - 0.5) * 0.04;
        const vx = p.mode === 'rise' ? Math.sin(travel * 0.5 + r4 * 10) * 0.01 : (r4 - 0.5) * 0.04;
        const x = (((r1 + vx * travel) % 1) + 1) % 1;
        const y = (((r3 - vy * travel) % 1) + 1) % 1;
        ctx.globalAlpha = tw * (0.4 + 0.6 * r2);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(x * f.W, y * f.H, sz * (0.4 + r2), 0, Math.PI * 2);
        ctx.fill();
      } else {
        // burst: every beat each particle is re-launched from the centre
        const age = f.beat.sinceBeat;
        const a = r1 * Math.PI * 2 + Math.floor(f.beat.beat) * 1.7;
        const v = (0.2 + r2) * 900 * p.speed * (1 + bass);
        const d = v * (1 - Math.exp(-age * 3)) / 3;
        ctx.globalAlpha = Math.exp(-age * 2.5) * tw;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, sz * (0.4 + r4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  },
};

export const VISUALIZERS = [spectrum, radial, waveform, particles];
