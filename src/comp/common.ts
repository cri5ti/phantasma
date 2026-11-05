import type { ParamDef, Values } from '../core/params';

/** Params every layer has (transform + look). */
export const COMMON_PARAMS: ParamDef[] = [
  { key: 'opacity', type: 'number', default: 1, min: 0, max: 1, step: 0.005, group: 'Layer' },
  { key: 'x', label: 'Offset X', type: 'number', default: 0, min: -2000, max: 2000, step: 1, group: 'Layer' },
  { key: 'y', label: 'Offset Y', type: 'number', default: 0, min: -2000, max: 2000, step: 1, group: 'Layer' },
  { key: 'scale', type: 'number', default: 1, min: 0, max: 5, step: 0.001, group: 'Layer' },
  { key: 'rotation', type: 'number', default: 0, min: -360, max: 360, step: 0.1, group: 'Layer' },
  { key: 'blur', type: 'number', default: 0, min: 0, max: 80, step: 0.1, group: 'Look' },
  { key: 'brightness', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Look' },
  { key: 'contrast', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Look' },
  { key: 'saturate', type: 'number', default: 1, min: 0, max: 4, step: 0.01, group: 'Look' },
  { key: 'hue', label: 'Hue shift', type: 'number', default: 0, min: -180, max: 180, step: 1, group: 'Look' },
  { key: 'invert', type: 'number', default: 0, min: 0, max: 1, step: 0.01, group: 'Look' },
];

/** Generator layers only: echoes of the layer's own recent past, faded + blurred (deterministic, scrub-safe). */
export const TRAIL_PARAMS: ParamDef[] = [
  { key: 'trails', label: 'Echoes', type: 'number', default: 0, min: 0, max: 16, step: 1, group: 'Trails' },
  { key: 'trailStep', label: 'Step (s)', type: 'number', default: 0.04, min: 0.005, max: 0.3, step: 0.005, group: 'Trails', hint: 'time between echoes' },
  { key: 'trailDecay', label: 'Decay', type: 'number', default: 0.72, min: 0.1, max: 0.98, step: 0.01, group: 'Trails', hint: 'opacity multiplier per echo' },
  { key: 'trailBlur', label: 'Blur / echo', type: 'number', default: 4, min: 0, max: 30, step: 0.5, group: 'Trails' },
  { key: 'trailZoom', label: 'Zoom / echo', type: 'number', default: 1, min: 0.85, max: 1.15, step: 0.001, group: 'Trails', hint: '>1 echoes expand outward, <1 collapse inward' },
  { key: 'trailBlend', label: 'Echo blend', type: 'select', default: 'lighter', options: ['source-over', 'lighter', 'screen'], group: 'Trails', static: true },
  // feedback: re-use the previous frame instead of re-drawing N echoes (1 draw per frame)
  { key: 'trailMode', label: 'Trail mode', type: 'select', default: 'echo', options: ['echo', 'feedback'], group: 'Trails', static: true, hint: 'echo = N re-draws per frame · feedback = previous frame transformed + faded (much faster, smoother trails)' },
  { key: 'fbDecay', label: 'FB keep', type: 'number', default: 0.88, min: 0, max: 0.995, step: 0.001, group: 'Trails', hint: 'feedback: how much of the previous frame survives each frame' },
  { key: 'fbZoom', label: 'FB zoom', type: 'number', default: 1.01, min: 0.9, max: 1.1, step: 0.0005, group: 'Trails', hint: '>1 tunnels outward, <1 inward (per frame)' },
  { key: 'fbRotate', label: 'FB rotate°', type: 'number', default: 0, min: -10, max: 10, step: 0.05, group: 'Trails', hint: 'degrees per frame' },
  { key: 'fbDriftX', label: 'FB drift X', type: 'number', default: 0, min: -40, max: 40, step: 0.1, group: 'Trails', hint: 'stage px per frame' },
  { key: 'fbDriftY', label: 'FB drift Y', type: 'number', default: 0, min: -40, max: 40, step: 0.1, group: 'Trails' },
  { key: 'fbBlur', label: 'FB blur', type: 'number', default: 0.6, min: 0, max: 20, step: 0.05, group: 'Trails', hint: 'blur added per frame (stage px)' },
  { key: 'fbHue', label: 'FB hue°', type: 'number', default: 0, min: -30, max: 30, step: 0.1, group: 'Trails', hint: 'hue shift per frame — rainbow trails' },
  { key: 'fbBlend', label: 'FB blend', type: 'select', default: 'screen', options: ['source-over', 'lighter', 'screen'], group: 'Trails', static: true },
  { key: 'fbRes', label: 'FB resolution', type: 'select', default: '0.5', options: ['0.25', '0.5', '1'], group: 'Trails', static: true, hint: 'history buffer size — it is blurred anyway' },
  { key: 'fbWarm', label: 'FB warm-up', type: 'number', default: 45, min: 1, max: 240, step: 1, group: 'Trails', static: true, hint: 'max frames re-simulated after a jump (scrub / parallel render); more = exact long trails, slower seeks' },
];

export const MEDIA_PARAMS: ParamDef[] = [
  { key: 'fit', type: 'select', default: 'cover', options: ['cover', 'contain', 'fill'], group: 'Media', static: true },
  { key: 'focusX', label: 'Focus X', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Media' },
  { key: 'focusY', label: 'Focus Y', type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, group: 'Media' },
  { key: 'flipX', label: 'Flip X', type: 'bool', default: false, group: 'Media', static: true },
];

export const VIDEO_PARAMS: ParamDef[] = [
  ...MEDIA_PARAMS,
  { key: 'offset', label: 'Clip in (s)', type: 'number', default: 0, min: 0, max: 600, step: 0.01, group: 'Media', static: true },
  { key: 'speed', type: 'number', default: 1, min: 0.1, max: 4, step: 0.01, group: 'Media', static: true },
  { key: 'loop', type: 'bool', default: true, group: 'Media', static: true },
];

export function cssFilter(c: Values): string {
  const f: string[] = [];
  if (c.blur > 0) f.push(`blur(${c.blur}px)`);
  if (c.brightness !== 1) f.push(`brightness(${c.brightness})`);
  if (c.contrast !== 1) f.push(`contrast(${c.contrast})`);
  if (c.saturate !== 1) f.push(`saturate(${c.saturate})`);
  if (c.hue) f.push(`hue-rotate(${c.hue}deg)`);
  if (c.invert > 0) f.push(`invert(${c.invert})`);
  return f.join(' ') || 'none';
}

/** Apply the common transform (around stage centre) to a 2D context drawing in stage units. */
export function applyTransform(ctx: CanvasRenderingContext2D, c: Values, W: number, H: number) {
  ctx.translate(W / 2 + c.x, H / 2 + c.y);
  if (c.rotation) ctx.rotate((c.rotation * Math.PI) / 180);
  if (c.scale !== 1) ctx.scale(c.scale, c.scale);
  ctx.translate(-W / 2, -H / 2);
}

export function cssTransform(c: Values): string {
  return `translate(${c.x}px, ${c.y}px) rotate(${c.rotation}deg) scale(${c.scale})`;
}

/** Fitted media rect in stage units (before the layer transform). */
export function fitRect(fit: string, mw: number, mh: number, W: number, H: number, fx = 0.5, fy = 0.5) {
  if (fit === 'fill' || !mw || !mh) return { x: 0, y: 0, w: W, h: H };
  const s = fit === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  const w = mw * s, h = mh * s;
  return { x: (W - w) * fx, y: (H - h) * fy, w, h };
}
