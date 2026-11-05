// Shapes, text and fills — usable as layers and especially as masks.
import type { GenDef } from './types';

export const shape: GenDef = {
  id: 'shape',
  name: 'Shape',
  category: 'shape',
  params: [
    { key: 'shape', type: 'select', default: 'ellipse', options: ['rect', 'ellipse', 'ring', 'polygon', 'star', 'bars'], group: 'Shape', static: true },
    { key: 'x', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Shape' },
    { key: 'y', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Shape' },
    { key: 'w', label: 'Width', type: 'number', default: 600, min: 0, max: 4000, step: 1, group: 'Shape' },
    { key: 'h', label: 'Height', type: 'number', default: 600, min: 0, max: 4000, step: 1, group: 'Shape' },
    { key: 'rotation', type: 'number', default: 0, min: -360, max: 360, step: 0.5, group: 'Shape' },
    { key: 'corner', type: 'number', default: 0, min: 0, max: 1000, step: 1, group: 'Shape' },
    { key: 'sides', label: 'Sides / points / bars', type: 'number', default: 6, min: 2, max: 32, step: 1, group: 'Shape' },
    { key: 'inner', label: 'Inner ratio', type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, group: 'Shape', hint: 'ring thickness / star depth / bar fill' },
    { key: 'fill', type: 'color', default: '#ffffff', group: 'Style' },
    { key: 'stroke', type: 'color', default: '#ffffff00', group: 'Style' },
    { key: 'strokeWidth', type: 'number', default: 0, min: 0, max: 100, step: 0.5, group: 'Style' },
  ],
  draw(ctx, p, f) {
    ctx.save();
    ctx.translate(f.W * p.x, f.H * p.y);
    ctx.rotate((p.rotation * Math.PI) / 180);
    const w = p.w, h = p.h;
    ctx.beginPath();
    switch (p.shape) {
      case 'rect': ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(p.corner, w / 2, h / 2)); break;
      case 'ellipse': ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); break;
      case 'ring':
        ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.ellipse(0, 0, (w / 2) * p.inner, (h / 2) * p.inner, 0, Math.PI * 2, 0, true);
        break;
      case 'polygon':
      case 'star': {
        const n = Math.max(3, Math.round(p.sides));
        const pts = p.shape === 'star' ? n * 2 : n;
        for (let i = 0; i < pts; i++) {
          const a = (i / pts) * Math.PI * 2 - Math.PI / 2;
          const r = p.shape === 'star' && i % 2 ? p.inner : 1;
          const x = (Math.cos(a) * w * r) / 2, y = (Math.sin(a) * h * r) / 2;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        break;
      }
      case 'bars': {
        // venetian-blind stripes — great as a wipe mask
        const n = Math.max(1, Math.round(p.sides));
        const slot = h / n;
        for (let i = 0; i < n; i++) ctx.rect(-w / 2, -h / 2 + i * slot, w, slot * p.inner);
        break;
      }
    }
    ctx.fillStyle = p.fill;
    ctx.fill('evenodd');
    if (p.strokeWidth > 0) {
      ctx.lineWidth = p.strokeWidth;
      ctx.strokeStyle = p.stroke;
      ctx.stroke();
    }
    ctx.restore();
  },
};

export const FONTS = [
  'Inter', 'Bebas Neue', 'Anton', 'Oswald', 'Montserrat', 'Playfair Display', 'Space Grotesk',
  'Syne', 'Unbounded', 'Archivo Black', 'Cormorant Garamond', 'Monoton', 'Major Mono Display',
  'Arial', 'Impact', 'Georgia', 'Courier New',
];
export const SYSTEM_FONTS = new Set(['Arial', 'Impact', 'Georgia', 'Courier New']);

export const text: GenDef = {
  id: 'text',
  name: 'Text',
  category: 'text',
  params: [
    { key: 'text', type: 'text', default: 'WIND IN MY HAIR', group: 'Text', static: true },
    { key: 'font', type: 'select', default: 'Bebas Neue', options: FONTS, group: 'Text', static: true },
    { key: 'weight', type: 'select', default: '400', options: ['300', '400', '700', '900'], group: 'Text', static: true },
    { key: 'size', type: 'number', default: 180, min: 8, max: 1200, step: 1, group: 'Text' },
    { key: 'x', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Text' },
    { key: 'y', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Text' },
    { key: 'align', type: 'select', default: 'center', options: ['left', 'center', 'right'], group: 'Text', static: true },
    { key: 'tracking', label: 'Letter spacing', type: 'number', default: 0, min: -50, max: 200, step: 0.5, group: 'Text' },
    { key: 'lineHeight', type: 'number', default: 1, min: 0.5, max: 3, step: 0.01, group: 'Text' },
    { key: 'reveal', type: 'number', default: 1, min: 0, max: 1, step: 0.001, group: 'Text', hint: 'typewriter reveal 0→1' },
    { key: 'color', type: 'color', default: '#ffffff', group: 'Style' },
    { key: 'stroke', type: 'color', default: '#ffffff00', group: 'Style' },
    { key: 'strokeWidth', type: 'number', default: 0, min: 0, max: 40, step: 0.5, group: 'Style' },
    { key: 'glow', type: 'number', default: 0, min: 0, max: 100, step: 1, group: 'Style' },
  ],
  draw(ctx, p, f) {
    const lines = String(p.text).split('\\n').join('\n').split('\n');
    const total = lines.reduce((a, l) => a + l.length, 0);
    let budget = Math.round(total * Math.max(0, Math.min(1, p.reveal)));
    ctx.font = `${p.weight} ${p.size}px "${p.font}"`;
    (ctx as any).letterSpacing = `${p.tracking}px`;
    ctx.textAlign = p.align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = p.color;
    ctx.shadowBlur = p.glow;
    ctx.shadowColor = p.glow > 0 ? p.color : 'transparent';
    const lh = p.size * p.lineHeight;
    const y0 = f.H * p.y - ((lines.length - 1) * lh) / 2;
    lines.forEach((line, i) => {
      const s = line.slice(0, Math.max(0, budget));
      budget -= line.length;
      if (!s) return;
      const y = y0 + i * lh;
      if (p.strokeWidth > 0) {
        ctx.lineWidth = p.strokeWidth;
        ctx.strokeStyle = p.stroke;
        ctx.lineJoin = 'round';
        ctx.strokeText(s, f.W * p.x, y);
      }
      ctx.fillText(s, f.W * p.x, y);
    });
    (ctx as any).letterSpacing = '0px';
  },
};

export const gradient: GenDef = {
  id: 'gradient',
  name: 'Gradient',
  category: 'fill',
  params: [
    { key: 'type', type: 'select', default: 'linear', options: ['linear', 'radial'], group: 'Gradient', static: true },
    { key: 'angle', type: 'number', default: 90, min: -360, max: 360, step: 1, group: 'Gradient' },
    { key: 'x', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Gradient' },
    { key: 'y', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Gradient' },
    { key: 'radius', type: 'number', default: 900, min: 1, max: 4000, step: 1, group: 'Gradient' },
    { key: 'spread', type: 'number', default: 1, min: 0.01, max: 3, step: 0.01, group: 'Gradient', hint: 'linear: length relative to frame' },
    { key: 'offset', type: 'number', default: 0, min: -1, max: 1, step: 0.005, group: 'Gradient', hint: 'slide the ramp (animate for wipes)' },
    { key: 'colorA', type: 'color', default: '#ffffff', group: 'Gradient' },
    { key: 'colorB', type: 'color', default: '#ffffff00', group: 'Gradient' },
  ],
  draw(ctx, p, f) {
    let g: CanvasGradient;
    if (p.type === 'radial') {
      const cx = f.W * p.x, cy = f.H * p.y;
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, p.radius);
    } else {
      const a = (p.angle * Math.PI) / 180;
      const L = (Math.abs(Math.cos(a) * f.W) + Math.abs(Math.sin(a) * f.H)) * p.spread * 0.5;
      const cx = f.W * p.x + Math.cos(a) * L * 2 * p.offset;
      const cy = f.H * p.y + Math.sin(a) * L * 2 * p.offset;
      g = ctx.createLinearGradient(cx - Math.cos(a) * L, cy - Math.sin(a) * L, cx + Math.cos(a) * L, cy + Math.sin(a) * L);
    }
    g.addColorStop(0, p.colorA);
    g.addColorStop(1, p.colorB);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, f.W, f.H);
  },
};

export const solid: GenDef = {
  id: 'solid',
  name: 'Solid',
  category: 'fill',
  params: [{ key: 'color', type: 'color', default: '#000000', group: 'Fill' }],
  draw(ctx, p, f) {
    ctx.fillStyle = p.color;
    ctx.fillRect(0, 0, f.W, f.H);
  },
};

export const SHAPES = [shape, text, gradient, solid];
