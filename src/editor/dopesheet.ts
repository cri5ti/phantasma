// Dopesheet: per-layer keyframe tracks (one per animated param, masks included) + key selection / move / delete / ease.
// A key is addressed by layer id + param path + its time: "p.<key>" (layer param) or "m.<maskId>.<key>" (mask param).
import type { Draft } from 'immer';
import { COMMON_PARAMS, MEDIA_PARAMS, TRAIL_PARAMS, VIDEO_PARAMS } from '../comp/common';
import { isAnimated, setKey, type ParamDef } from '../core/params';
import type { Easing, Keyframe, Layer, ParamMap, Project } from '../core/types';
import { getGen } from '../gen/registry';
import { store, type KeyRef } from './store';

export type { KeyRef };

export interface Track {
  path: string;
  label: string;
  /** group name in the inspector (or the mask name) */
  group: string;
  keys: Keyframe[];
}

const EPS = 1e-4;

function layerDefs(l: Layer): ParamDef[] {
  const typed = l.kind === 'gen' ? [...(getGen(l.gen)?.params ?? []), ...TRAIL_PARAMS] : l.kind === 'video' ? VIDEO_PARAMS : MEDIA_PARAMS;
  return [...typed, ...COMMON_PARAMS];
}

/** keyframed params of a layer (and its masks), in inspector order */
export function layerTracks(l: Layer): Track[] {
  const out: Track[] = [];
  const defs = layerDefs(l);
  const seen = new Set<string>();
  const add = (map: ParamMap, prefix: string, ds: ParamDef[], group?: string) => {
    const keys = [...ds.map((d) => d.key), ...Object.keys(map)]; // params without a def (renamed in a scene) still show
    for (const k of keys) {
      const path = prefix + k;
      if (seen.has(path)) continue;
      seen.add(path);
      const v = map[k];
      if (!isAnimated(v) || !v.$k?.length) continue;
      const d = ds.find((x) => x.key === k);
      out.push({ path, label: d?.label ?? k, group: group ?? d?.group ?? 'Params', keys: [...v.$k].sort((a, b) => a.t - b.t) });
    }
  };
  add(l.params, 'p.', defs);
  l.masks.forEach((m, i) => add(m.params, `m.${m.id}.`, getGen(m.gen)?.params ?? [], `Mask ${i + 1}`));
  return out;
}

function paramMap(l: Draft<Layer>, path: string): Draft<ParamMap> | undefined {
  if (path.startsWith('p.')) return l.params;
  const [, maskId] = path.split('.');
  return l.masks.find((m) => m.id === maskId)?.params;
}
const paramKey = (path: string) => path.slice(path.lastIndexOf('.') + 1);

function keysOf(p: Draft<Project>, r: KeyRef): Draft<Keyframe>[] | undefined {
  const l = p.layers.find((x) => x.id === r.layer);
  const v = l && paramMap(l, r.path)?.[paramKey(r.path)];
  return isAnimated(v) ? v.$k : undefined;
}

export const sameKey = (a: KeyRef, b: KeyRef) => a.layer === b.layer && a.path === b.path && Math.abs(a.t - b.t) < EPS;
export const isKeySel = (r: KeyRef) => store.state.keySel.some((k) => sameKey(k, r));

/** move keys (each from its own time `from[i]` to `from[i] + dt`); returns the new refs */
export function moveKeys(refs: KeyRef[], from: number[], dt: number, merge: string): KeyRef[] {
  const next = refs.map((r, i) => ({ ...r, t: Math.max(0, +(from[i] + dt).toFixed(4)) }));
  store.edit((p) => {
    refs.forEach((r, i) => {
      const ks = keysOf(p, r);
      const k = ks?.find((x) => Math.abs(x.t - r.t) < EPS);
      if (k) k.t = next[i].t;
    });
    for (const r of refs) keysOf(p, r)?.sort((a, b) => a.t - b.t);
  }, merge);
  return next;
}

export function deleteKeys(refs: KeyRef[]) {
  if (!refs.length) return;
  store.edit((p) => {
    for (const r of refs) {
      const l = p.layers.find((x) => x.id === r.layer);
      const map = l && paramMap(l, r.path);
      const key = paramKey(r.path);
      const v = map?.[key];
      if (!map || !isAnimated(v) || !v.$k) continue;
      const removed = v.$k.find((k) => Math.abs(k.t - r.t) < EPS);
      v.$k = v.$k.filter((k) => Math.abs(k.t - r.t) >= EPS);
      if (!v.$k.length) {
        // last key gone: keep its value as the static one (and any modulation)
        if (v.$mod?.length) { delete v.$k; v.v = removed?.v ?? v.v; }
        else map[key] = (removed?.v ?? v.v ?? 0) as any;
      }
    }
  });
  store.set({ keySel: [] });
}

export function setEase(refs: KeyRef[], e: Easing) {
  store.edit((p) => {
    for (const r of refs) {
      const k = keysOf(p, r)?.find((x) => Math.abs(x.t - r.t) < EPS);
      if (k) k.e = e;
    }
  });
}

/** leave a copy of each key in place (alt-drag): the originals then move on, the copies stay behind */
export function duplicateKeys(refs: KeyRef[], merge: string) {
  store.edit((p) => {
    for (const r of refs) {
      const ks = keysOf(p, r);
      const k = ks?.find((x) => Math.abs(x.t - r.t) < EPS);
      if (ks && k) ks.push({ ...k });
    }
    for (const r of refs) keysOf(p, r)?.sort((a, b) => a.t - b.t);
  }, merge);
}

// ---- clipboard --------------------------------------------------------------------------------

interface ClipKey { layer: string; path: string; dt: number; k: Keyframe }
let clip: ClipKey[] = [];

export function copyKeys(refs: KeyRef[]): number {
  const p = store.state.project;
  const out: ClipKey[] = [];
  for (const r of refs) {
    const k = keysOf(p as Draft<Project>, r)?.find((x) => Math.abs(x.t - r.t) < EPS);
    if (k) out.push({ layer: r.layer, path: r.path, dt: r.t, k: JSON.parse(JSON.stringify(k)) });
  }
  if (!out.length) return 0;
  const t0 = Math.min(...out.map((c) => c.dt));
  out.forEach((c) => { c.dt -= t0; });
  clip = out;
  return out.length;
}

export const hasClipKeys = () => clip.length > 0;

/**
 * Paste the copied keys with the earliest one at `t`. They go to the selected layer when there is one
 * (same param names; mask keys only onto their own layer), else back to the layer they came from.
 * Keys already at a pasted time are replaced. Selects the pasted keys.
 */
export function pasteKeys(t: number): boolean {
  if (!clip.length) return false;
  const s = store.state;
  const target = s.sel.layerId && s.project.layers.some((l) => l.id === s.sel.layerId) ? s.sel.layerId : undefined;
  const pasted: KeyRef[] = [];
  store.edit((p) => {
    for (const c of clip) {
      const layerId = target ?? c.layer;
      if (c.path.startsWith('m.') && layerId !== c.layer) continue;
      const l = p.layers.find((x) => x.id === layerId);
      const map = l && paramMap(l, c.path);
      if (!l || !map) continue;
      const key = paramKey(c.path);
      // skip params the target layer doesn't have (e.g. gen-specific ones)
      if (layerId !== c.layer && !(key in map) && !layerDefs(l as Layer).some((d) => d.key === key)) continue;
      const nt = Math.max(0, +(t + c.dt).toFixed(4));
      map[key] = setKey(map[key] as any, nt, c.k.v, c.k.e) as any;
      pasted.push({ layer: layerId, path: c.path, t: nt });
    }
  });
  if (pasted.length) store.set({ keySel: pasted, sel: { layerId: pasted[0].layer } });
  return pasted.length > 0;
}

export function toggleDope(layerId: string) {
  const d = store.state.dope;
  store.set({ dope: d.includes(layerId) ? d.filter((x) => x !== layerId) : [...d, layerId] });
}
