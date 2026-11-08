// Image generator: a media image drawn with fit / tile / scroll. Because it's a generator it also works as a mask
// source (e.g. a painted luminance matte) and gets trails, keyframes and modulation like any other generator.
import type { Values } from '../core/params';
import { imageFor } from './assets';
import type { FrameCtx, GenDef } from './types';

export const imageGen: GenDef = {
  id: 'image',
  name: 'Image (fit / tile / scroll)',
  category: 'fill',
  params: [
    { key: 'src', label: 'Image', type: 'text', default: '', static: true, media: 'image', group: 'Image' },
    { key: 'fit', type: 'select', default: 'cover', options: ['cover', 'contain', 'stretch', 'tile'], static: true, group: 'Image' },
    { key: 'focusX', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Image' },
    { key: 'focusY', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Image' },
    { key: 'tileScale', label: 'Tile scale', type: 'number', default: 1, min: 0.05, max: 8, step: 0.01, group: 'Image', hint: 'tile mode: size relative to the image height fitted to the frame' },
    { key: 'scrollX', label: 'Scroll X (px/s)', type: 'number', default: 0, min: -3000, max: 3000, step: 1, group: 'Scroll' },
    { key: 'scrollY', label: 'Scroll Y (px/s)', type: 'number', default: 0, min: -3000, max: 3000, step: 1, group: 'Scroll' },
    { key: 'loop', label: 'Loop (s)', type: 'number', default: 0, min: 0, max: 120, step: 0.001, group: 'Scroll', static: true,
      hint: 'tile mode: > 0 rounds the scroll speed so the pattern repeats exactly every N seconds (seamless loops)' },
  ],
  draw(ctx: CanvasRenderingContext2D, p: Values, f: FrameCtx) {
    const img = imageFor(String(p.src));
    if (!img) return;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const W = f.W, H = f.H;
    const t = f.layerT;
    if (p.fit === 'tile') {
      const th = H * p.tileScale;
      const tw = (iw / ih) * th;
      let sx = p.scrollX, sy = p.scrollY;
      if (p.loop > 0) {
        // whole tiles per loop → seamless
        sx = (Math.round((sx * p.loop) / tw) * tw) / p.loop;
        sy = (Math.round((sy * p.loop) / th) * th) / p.loop;
      }
      const ox = (((p.focusX - 0.5) * W + sx * t) % tw + tw) % tw;
      const oy = (((p.focusY - 0.5) * H + sy * t) % th + th) % th;
      for (let x = ox - tw; x < W; x += tw) for (let y = oy - th; y < H; y += th) ctx.drawImage(img, x, y, tw + 0.5, th + 0.5);
      return;
    }
    let w = W, h = H;
    if (p.fit !== 'stretch') {
      const s = p.fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
      w = iw * s;
      h = ih * s;
    }
    const x = (W - w) * p.focusX + p.scrollX * t;
    const y = (H - h) * p.focusY + p.scrollY * t;
    ctx.drawImage(img, x, y, w, h);
  },
};
