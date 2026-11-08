// Images used by generators (scene textures, the image generator), shared by the editor and the render.
// The composition configures the resolver every frame; loads are async and announced through `onAssets`.
// Remotion renders preload everything a project references (see preloadGenAssets) so `draw` never waits.
import type { MediaItem } from '../core/types';

let assetFn: (p: string) => string = (p) => '/' + p;
let mediaMap = new Map<string, MediaItem>();

export function configureAssets(asset: (p: string) => string, media: Map<string, MediaItem>) {
  assetFn = asset;
  mediaMap = media;
}

export const assetUrl = (p: string) => assetFn(p);
export const mediaItems = () => mediaMap;

/** A media id (from media.json) or a project-relative path → URL. */
export function resolveRef(ref: string): string | null {
  if (!ref) return null;
  const m = mediaMap.get(ref);
  if (m) return m.remote ? m.src : assetFn(m.src);
  if (/^https?:\/\//.test(ref)) return ref;
  return /\.[a-z0-9]{2,5}$/i.test(ref) ? assetFn(ref) : null;
}

interface Entry {
  img: HTMLImageElement;
  ready: boolean;
  error?: string;
  p: Promise<void>;
}
const images = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

export function onAssets(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export const assetsVersion = () => version;
export function bump() {
  version++;
  listeners.forEach((f) => f());
}

function load(url: string): Entry {
  let e = images.get(url);
  if (e) return e;
  const img = new Image();
  img.decoding = 'async';
  img.crossOrigin = 'anonymous';
  const entry: Entry = { img, ready: false } as Entry;
  entry.p = new Promise<void>((res) => {
    img.onload = () => {
      entry.ready = true;
      bump();
      res();
    };
    img.onerror = () => {
      entry.error = `could not load ${url}`;
      console.error(`[mvgen] ${entry.error}`);
      bump();
      res();
    };
  });
  img.src = url;
  images.set(url, entry);
  return entry;
}

/** The loaded image for a media id / path, or null (starts loading; listeners fire when it lands). */
export function imageFor(ref: string): HTMLImageElement | null {
  const url = resolveRef(ref);
  if (!url) return null;
  const e = load(url);
  return e.ready ? e.img : null;
}

export function preloadImages(refs: Iterable<string>): Promise<void> {
  const ps: Promise<void>[] = [];
  for (const r of refs) {
    const url = resolveRef(r);
    if (url) ps.push(load(url).p);
  }
  return Promise.all(ps).then(() => undefined);
}
