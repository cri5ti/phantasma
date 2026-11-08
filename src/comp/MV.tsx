import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AbsoluteFill, Audio, cancelRender, continueRender, delayRender, getRemotionEnvironment, Img, Loop, OffthreadVideo, Sequence,
  staticFile, useCurrentFrame, useVideoConfig,
} from 'remotion';
import { assetsVersion, configureAssets, onAssets, preloadImages } from '../gen/assets';
import { preloadScenes, watchScenes } from '../gen/scene';
import { loadAnalysis, type AudioData } from '../core/audio';
import { evalParams } from '../core/params';
import { Tempo } from '../core/tempo';
import type { Layer, MediaItem, Project } from '../core/types';
import { SYSTEM_FONTS } from '../gen/shapes';
import { COMMON_PARAMS, cssFilter, cssTransform, TRAIL_PARAMS, VIDEO_PARAMS, MEDIA_PARAMS } from './common';
import { buildMask, drawGen, evalCtx, scratch, type Env } from './draw';
import { feedbackFrame } from './feedback';

export type MVProps = {
  project: Project;
  media: MediaItem[];
  /** editor: '/' (served by vite). render: null → staticFile() */
  assetBase?: string | null;
  /** use low-res proxies for video (editor) */
  useProxies?: boolean;
  /** canvas resolution multiplier for generator layers (preview speed) */
  renderScale?: number;
  /** mask resolution multiplier */
  maskScale?: number;
};

export const WORK_DIR = '_mvgen';

export function makeAsset(base: string | null | undefined) {
  return (p: string) => (/^https?:\/\//.test(p) ? p : base != null ? base + p.split('/').map(encodeURIComponent).join('/') : staticFile(p));
}

function useAnalysis(asset: (p: string) => string) {
  const [audio, setAudio] = useState<AudioData | null>(null);
  const [handle] = useState(() => delayRender('Loading audio analysis'));
  useEffect(() => {
    loadAnalysis((f) => asset(`${WORK_DIR}/${f}`))
      .then((a) => {
        setAudio(a);
        continueRender(handle);
      })
      .catch((e) => cancelRender(e));
  }, []);
  return audio;
}

const loadedFonts = new Map<string, Promise<void>>();
function loadFont(family: string): Promise<void> {
  let p = loadedFonts.get(family);
  if (p) return p;
  p = new Promise<void>((resolve) => {
    const fam = encodeURIComponent(family).replace(/%20/g, '+');
    const add = (href: string, onerror?: () => void) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = () => Promise.all(['300', '400', '700', '900'].map((w) => document.fonts.load(`${w} 40px "${family}"`).catch(() => null))).then(() => resolve());
      l.onerror = onerror ?? (() => resolve());
      document.head.appendChild(l);
    };
    add(`https://fonts.googleapis.com/css2?family=${fam}:wght@300;400;700;900&display=block`, () =>
      add(`https://fonts.googleapis.com/css2?family=${fam}&display=block`),
    );
  });
  loadedFonts.set(family, p);
  return p;
}

function useFonts(project: Project) {
  const families = useMemo(() => {
    const s = new Set<string>();
    const scan = (gen: string | undefined, params: Layer['params']) => {
      if ((gen === 'text' || gen === 'lyrics') && typeof params.font === 'string' && !SYSTEM_FONTS.has(params.font)) s.add(params.font);
    };
    for (const l of project.layers) {
      scan(l.gen, l.params);
      l.masks.forEach((m) => scan(m.gen, m.params));
    }
    return [...s].sort();
  }, [project.layers]);
  const [ver, setVer] = useState(0);
  const key = families.join('|');
  useLayoutEffect(() => {
    if (!families.length) return;
    const h = delayRender(`Loading fonts ${key}`);
    Promise.all(families.map(loadFont)).then(() => {
      setVer((v) => v + 1);
      continueRender(h);
    });
  }, [key]);
  return ver;
}

/**
 * Images + scene files used by generator layers / masks: preloaded before the first frame renders (Remotion), hot-reloaded
 * in the editor. Returns a version that changes whenever something finished loading, so the canvases redraw.
 */
function useGenAssets(project: Project, asset: (p: string) => string, media: Map<string, MediaItem>) {
  configureAssets(asset, media);
  const ver = useSyncExternalStore(onAssets, assetsVersion);
  const uses = useMemo(
    () => project.layers.flatMap((l) => [{ gen: l.gen, params: l.params as Record<string, unknown> }, ...l.masks.map((m) => ({ gen: m.gen, params: m.params as Record<string, unknown> }))])
      .filter((u) => u.gen === 'image' || u.gen?.startsWith('scene:')),
    [project.layers],
  );
  const key = JSON.stringify(uses.map((u) => [u.gen, u.gen === 'image' ? u.params.src : Object.entries(u.params).filter(([k]) => k.startsWith('tex_'))]));
  const rendering = getRemotionEnvironment().isRendering;
  useLayoutEffect(() => {
    if (!uses.length) return;
    const h = delayRender(`Loading scenes / images`);
    Promise.all([preloadScenes(uses), preloadImages(uses.filter((u) => u.gen === 'image').map((u) => String(u.params.src ?? '')))])
      .then(([problems]) => {
        // the editor shows scene errors on the layer; a final render must not silently drop a layer
        if (problems.length && rendering) cancelRender(new Error(`scene error:\n${problems.join('\n')}`));
        else continueRender(h);
      })
      .catch((e) => cancelRender(e));
  }, [key]);
  useEffect(() => {
    if (!rendering) watchScenes();
  }, []);
  return ver;
}

export const MV: React.FC<MVProps> = ({ project, media, assetBase, useProxies, renderScale = 1, maskScale = 0.5 }) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const asset = useMemo(() => makeAsset(assetBase), [assetBase]);
  const audio = useAnalysis(asset);
  const fontVer = useFonts(project);
  const mediaMap = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  useGenAssets(project, asset, mediaMap); // re-renders (→ redraws) when scenes / images land
  const tempo = useMemo(() => new Tempo(project.tempo, audio?.meta.beats ?? [], project.duration), [project.tempo, audio, project.duration]);
  const t = frame / fps;
  const env: Env = { t, fps, W, H, audio, tempo, media: mediaMap, lyrics: project.lyrics };

  const solo = project.layers.some((l) => l.solo);
  const layers = project.layers;

  return (
    <AbsoluteFill style={{ background: project.background }}>
      {project.audio ? <Audio src={asset(project.audio)} /> : null}
      <AbsoluteFill style={{ isolation: 'isolate', overflow: 'hidden' }}>
        {layers.map((l, i) => {
          if (!l.enabled || (solo && !l.solo)) return null;
          const props = { layer: l, below: layers[i - 1], env, asset, useProxies: !!useProxies, renderScale, maskScale, fontVer };
          if (l.kind === 'gen') return t >= l.start && t < l.end ? <GenLayer key={l.id} {...props} /> : null;
          const from = Math.round(l.start * fps);
          const dur = Math.max(1, Math.round((l.end - l.start) * fps));
          return (
            <Sequence key={l.id} from={from} durationInFrames={dur} layout="none" name={l.name}>
              <MediaLayer {...props} />
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

interface LayerProps {
  layer: Layer;
  below?: Layer;
  env: Env;
  asset: (p: string) => string;
  useProxies: boolean;
  renderScale: number;
  maskScale: number;
  fontVer: number;
}

function fadeFactor(l: Layer, t: number) {
  let f = 1;
  if (l.fadeIn > 0) f *= Math.min(1, Math.max(0, (t - l.start) / l.fadeIn));
  if (l.fadeOut > 0) f *= Math.min(1, Math.max(0, (l.end - t) / l.fadeOut));
  return f;
}

const fill: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

const GenLayer: React.FC<LayerProps> = ({ layer, below, env, renderScale, maskScale }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const c = evalParams(layer.params, COMMON_PARAMS, evalCtx(env, layer));
  const cw = Math.round(env.W * renderScale);
  const ch = Math.round(env.H * renderScale);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cw, ch);
    const tr = evalParams(layer.params, TRAIL_PARAMS, evalCtx(env, layer));
    if (tr.trailMode === 'feedback') {
      // previous frame transformed + faded, current frame on top — one generator draw per frame
      const fb = feedbackFrame(layer, env, Math.round(env.t * env.fps), cw, ch, {
        decay: tr.fbDecay, zoom: tr.fbZoom, rotate: tr.fbRotate, driftX: tr.fbDriftX, driftY: tr.fbDriftY,
        blur: tr.fbBlur, hue: tr.fbHue, blend: tr.fbBlend, res: Number(tr.fbRes) || 0.5, warm: tr.fbWarm,
      });
      const cur = scratch(`${layer.id}:cur`, cw, ch);
      cur.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      drawGen(cur, layer.gen, layer.params, env, layer, true);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (fb.hist) ctx.drawImage(fb.hist, 0, 0, cw, ch);
      ctx.globalCompositeOperation = tr.fbBlend;
      ctx.drawImage(cur.canvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      fb.commit(cur.canvas);
    }
    const echoes = tr.trailMode === 'feedback' ? 0 : Math.round(tr.trails);
    if (echoes > 0) {
      // echoes are rendered at half resolution — they get blurred anyway
      const ts = renderScale * 0.5;
      const tw = Math.max(2, Math.round(env.W * ts)), th = Math.max(2, Math.round(env.H * ts));
      for (let k = echoes; k >= 1; k--) {
        const tk = env.t - k * tr.trailStep;
        if (tk < layer.start) continue;
        const tmp = scratch(`${layer.id}:trail`, tw, th);
        tmp.setTransform(ts, 0, 0, ts, 0, 0);
        drawGen(tmp, layer.gen, layer.params, { ...env, t: tk }, layer, true);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = Math.pow(tr.trailDecay, k);
        ctx.globalCompositeOperation = tr.trailBlend;
        if (tr.trailBlur > 0) ctx.filter = `blur(${tr.trailBlur * k * renderScale}px)`;
        const z = Math.pow(tr.trailZoom, k);
        ctx.translate(cw / 2, ch / 2);
        ctx.scale(z, z);
        ctx.translate(-cw / 2, -ch / 2);
        ctx.drawImage(tmp.canvas, 0, 0, cw, ch);
        ctx.restore();
      }
    }
    if (tr.trailMode !== 'feedback') {
      ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      drawGen(ctx, layer.gen, layer.params, env, layer, true);
    }
    const mask = buildMask(layer, below, env, maskScale);
    if (mask) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0, cw, ch);
      ctx.globalCompositeOperation = 'source-over';
    }
  });
  return (
    <canvas
      ref={ref}
      width={cw}
      height={ch}
      style={{ ...fill, mixBlendMode: layer.blend, opacity: c.opacity * fadeFactor(layer, env.t), filter: cssFilter(c) }}
    />
  );
};

/** CSS mask from a canvas; holds the frame until the mask image is decoded so renders never miss it. */
function useMaskUrl(canvas: HTMLCanvasElement | null): string | null {
  const url = canvas ? canvas.toDataURL('image/png') : null;
  useLayoutEffect(() => {
    if (!url) return;
    const h = delayRender('mask');
    const img = new Image();
    img.src = url;
    img.decode().catch(() => null).finally(() => continueRender(h));
  }, [url]);
  return url;
}

const MediaLayer: React.FC<LayerProps> = ({ layer, below, env, asset, useProxies, maskScale }) => {
  const item = layer.media ? env.media.get(layer.media) : undefined;
  const ec = evalCtx(env, layer);
  const c = evalParams(layer.params, COMMON_PARAMS, ec);
  const m = evalParams(layer.params, layer.kind === 'video' ? VIDEO_PARAMS : MEDIA_PARAMS, ec);
  const maskUrl = useMaskUrl(buildMask(layer, below, env, maskScale));
  if (!item) return null;
  const src = asset(useProxies && item.proxy ? item.proxy : item.src);
  const mediaStyle: React.CSSProperties = {
    ...fill,
    objectFit: m.fit,
    objectPosition: `${m.focusX * 100}% ${m.focusY * 100}%`,
    transform: m.flipX ? 'scaleX(-1)' : undefined,
  };
  let content: React.ReactNode;
  if (layer.kind === 'image') {
    content = <Img src={src} style={mediaStyle} />;
  } else {
    const speed = Math.max(0.05, m.speed);
    const trim = Math.max(0, Math.round(m.offset * env.fps));
    const video = <OffthreadVideo src={src} muted trimBefore={trim || undefined} playbackRate={speed} style={mediaStyle} pauseWhenBuffering />;
    const loopFrames = Math.floor(((item.duration - m.offset) / speed) * env.fps) - 1;
    content = m.loop && loopFrames > 1 ? <Loop durationInFrames={loopFrames} layout="none">{video}</Loop> : video;
  }
  const maskStyle: React.CSSProperties = maskUrl
    ? { maskImage: `url(${maskUrl})`, maskSize: '100% 100%', maskRepeat: 'no-repeat', WebkitMaskImage: `url(${maskUrl})`, WebkitMaskSize: '100% 100%', WebkitMaskRepeat: 'no-repeat' }
    : {};
  return (
    <div style={{ ...fill, mixBlendMode: layer.blend, opacity: c.opacity * fadeFactor(layer, env.t), ...maskStyle }}>
      <div style={{ ...fill, transform: cssTransform(c), filter: cssFilter(c), overflow: 'hidden' }}>{content}</div>
    </div>
  );
};

