// Canvas drawing shared by generator layers, masks and clipping.
import type { AudioData } from '../core/audio';
import { evalParams, type EvalCtx } from '../core/params';
import type { Tempo } from '../core/tempo';
import type { Layer, Lyrics, MediaItem } from '../core/types';
import { getGen } from '../gen/registry';
import { hashString, type FrameCtx } from '../gen/types';
import { applyTransform, COMMON_PARAMS, fitRect, MEDIA_PARAMS } from './common';

export interface Env {
  t: number;
  fps: number;
  W: number;
  H: number;
  audio: AudioData | null;
  tempo: Tempo;
  media: Map<string, MediaItem>;
  lyrics?: Lyrics;
}

export const evalCtx = (env: Env, layer: Layer): EvalCtx => ({
  t: env.t,
  audio: env.audio,
  tempo: env.tempo,
  layerStart: layer.start,
  layerEnd: layer.end,
});

export function frameCtx(env: Env, layer: Layer): FrameCtx {
  return {
    t: env.t,
    layerT: env.t - layer.start,
    fps: env.fps,
    W: env.W,
    H: env.H,
    audio: env.audio,
    tempo: env.tempo,
    beat: env.tempo.at(env.t),
    seed: hashString(layer.id),
    lyrics: env.lyrics,
  };
}

const pool = new Map<string, HTMLCanvasElement>();
export function scratch(key: string, w: number, h: number): CanvasRenderingContext2D {
  let c = pool.get(key);
  if (!c) {
    c = document.createElement('canvas');
    pool.set(key, c);
  }
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d', { willReadFrequently: key.endsWith(':lum') })!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function resetStyle(ctx: CanvasRenderingContext2D) {
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
}

/**
 * Draw a generator layer's content (with its layer transform) into ctx whose transform maps stage units → pixels.
 * Errors in a generator are caught so one broken visualizer never kills the render.
 */
export function drawGen(ctx: CanvasRenderingContext2D, genId: string | undefined, params: Layer['params'], env: Env, layer: Layer, withTransform = true) {
  const gen = getGen(genId);
  if (!gen) return;
  const ec = evalCtx(env, layer);
  ctx.save();
  if (withTransform) applyTransform(ctx, evalParams(layer.params, COMMON_PARAMS, ec), env.W, env.H);
  resetStyle(ctx);
  try {
    gen.draw(ctx, evalParams(params, gen.params, ec), frameCtx(env, layer));
  } catch (e) {
    console.error(`[mvgen] generator ${genId} failed`, e);
  }
  ctx.restore();
}

/** The alpha footprint of a layer (used by "clip to layer below"). */
export function drawSilhouette(ctx: CanvasRenderingContext2D, layer: Layer, env: Env) {
  if (layer.kind === 'gen') {
    drawGen(ctx, layer.gen, layer.params, env, layer);
    return;
  }
  const ec = evalCtx(env, layer);
  const c = evalParams(layer.params, COMMON_PARAMS, ec);
  const m = evalParams(layer.params, MEDIA_PARAMS, ec);
  const item = layer.media ? env.media.get(layer.media) : undefined;
  const r = fitRect(m.fit, item?.width ?? env.W, item?.height ?? env.H, env.W, env.H, m.focusX, m.focusY);
  ctx.save();
  applyTransform(ctx, c, env.W, env.H);
  ctx.fillStyle = '#fff';
  ctx.fillRect(Math.max(0, r.x), Math.max(0, r.y), Math.min(env.W, r.w), Math.min(env.H, r.h));
  ctx.restore();
}

/**
 * Combine the layer's masks (+ optional clip-to-below) into one alpha canvas at `scale` of stage size.
 * Returns null when the layer has no active masking.
 */
export function buildMask(layer: Layer, below: Layer | undefined, env: Env, scale: number): HTMLCanvasElement | null {
  const masks = layer.masks.filter((m) => m.enabled);
  const clip = layer.clipBelow && below && below.enabled && env.t >= below.start && env.t < below.end;
  if (!masks.length && !layer.clipBelow) return null;
  const w = Math.max(2, Math.round(env.W * scale));
  const h = Math.max(2, Math.round(env.H * scale));
  const acc = scratch(`${layer.id}:acc`, w, h);
  if (!masks.length || masks[0].op !== 'add') {
    acc.fillStyle = '#fff';
    acc.fillRect(0, 0, w, h);
  }
  for (const m of masks) {
    const one = scratch(`${layer.id}:one`, w, h);
    one.setTransform(scale, 0, 0, scale, 0, 0);
    // masks live in stage space: no layer transform
    drawGen(one, m.gen, m.params, env, layer, false);
    let src: HTMLCanvasElement = one.canvas;
    if (m.mode === 'luminance') {
      const lum = scratch(`${layer.id}:lum`, w, h);
      lum.drawImage(src, 0, 0);
      const img = lum.getImageData(0, 0, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) * d[i + 3]) / 255;
        d[i] = d[i + 1] = d[i + 2] = 255;
        d[i + 3] = a;
      }
      lum.putImageData(img, 0, 0);
      src = lum.canvas;
    }
    if (m.feather > 0) {
      const fe = scratch(`${layer.id}:fe`, w, h);
      fe.filter = `blur(${m.feather * scale}px)`;
      fe.drawImage(src, 0, 0);
      fe.filter = 'none';
      src = fe.canvas;
    }
    if (m.invert) {
      const inv = scratch(`${layer.id}:inv`, w, h);
      inv.fillStyle = '#fff';
      inv.fillRect(0, 0, w, h);
      inv.globalCompositeOperation = 'destination-out';
      inv.drawImage(src, 0, 0);
      inv.globalCompositeOperation = 'source-over';
      src = inv.canvas;
    }
    acc.globalCompositeOperation = m.op === 'subtract' ? 'destination-out' : m.op === 'intersect' ? 'destination-in' : 'source-over';
    acc.drawImage(src, 0, 0);
    acc.globalCompositeOperation = 'source-over';
  }
  if (layer.clipBelow) {
    if (!clip) {
      acc.clearRect(0, 0, w, h);
    } else {
      const sil = scratch(`${layer.id}:sil`, w, h);
      sil.setTransform(scale, 0, 0, scale, 0, 0);
      drawSilhouette(sil, below!, env);
      acc.globalCompositeOperation = 'destination-in';
      acc.drawImage(sil.canvas, 0, 0);
      acc.globalCompositeOperation = 'source-over';
    }
  }
  return acc.canvas;
}
