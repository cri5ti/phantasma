// Layer groups: organisation + focus, not sub-compositions. A group lists member layers; its span is derived from them.
// Groups sit on group rows above the layers (several per row, back to back; move one to another row to stack).
// Compositing is unchanged — focusing a group only filters what the timeline shows.
import type { Draft } from 'immer';
import { shiftKeys } from '../core/params';
import { uid } from '../core/project';
import type { Group, Layer, ParamMap, Project } from '../core/types';
import { store } from './store';

const COLORS = ['#e0a040', '#4dd4ff', '#ff6b9a', '#3ddc97', '#b48cff', '#ff8a4d', '#9be15d', '#5b8cff'];

export function groupSpan(p: Project, g: Group): { a: number; b: number } | null {
  const ls = p.layers.filter((l) => g.layerIds.includes(l.id));
  if (!ls.length) return null;
  return { a: Math.min(...ls.map((l) => l.start)), b: Math.max(...ls.map((l) => l.end)) };
}

export const groupOf = (p: Project, layerId: string) => p.groups?.find((g) => g.layerIds.includes(layerId));

/** drop missing layer ids and empty groups (after deletes / rebuilds) */
export function pruneGroups(p: Draft<Project>) {
  if (!p.groups) return;
  const ids = new Set(p.layers.map((l) => l.id));
  p.groups.forEach((g) => { g.layerIds = g.layerIds.filter((id) => ids.has(id)); });
  p.groups = p.groups.filter((g) => g.layerIds.length);
}

/** first row where [a, b] doesn't overlap another group */
function freeRow(p: Project, a: number, b: number, skip?: string) {
  for (let row = 0; ; row++) {
    const clash = (p.groups ?? []).some((g) => {
      if (g.id === skip || (g.row ?? 0) !== row) return false;
      const s = groupSpan(p, g);
      return s && s.a < b - 1e-3 && s.b > a + 1e-3;
    });
    if (!clash) return row;
  }
}

/** Group layers (they leave any group they were in). Returns the new group's id. */
export function groupLayers(ids: string[], name?: string): string | null {
  const p = store.state.project;
  const members = p.layers.filter((l) => ids.includes(l.id)).map((l) => l.id);
  if (!members.length) return null;
  const a = Math.min(...p.layers.filter((l) => members.includes(l.id)).map((l) => l.start));
  const b = Math.max(...p.layers.filter((l) => members.includes(l.id)).map((l) => l.end));
  const n = (p.groups?.length ?? 0) + 1;
  // name after the tempo section it starts in, when there is one
  const sec = p.tempo.find((s) => a >= s.start - 0.05 && a < s.end);
  const g: Group = { id: uid('g'), name: name ?? (sec ? `${sec.label}` : `Group ${n}`), color: COLORS[(n - 1) % COLORS.length], row: 0, layerIds: members };
  store.edit((d) => {
    d.groups ??= [];
    d.groups.forEach((x) => { x.layerIds = x.layerIds.filter((id) => !members.includes(id)); });
    d.groups = d.groups.filter((x) => x.layerIds.length);
    g.row = freeRow(d as Project, a, b);
    d.groups.push(g);
  });
  store.set({ sel: { groupId: g.id } });
  return g.id;
}

export function ungroup(id: string) {
  const g = store.state.project.groups?.find((x) => x.id === id);
  store.edit((d) => { d.groups = (d.groups ?? []).filter((x) => x.id !== id); });
  if (store.state.focusGroup === id) store.set({ focusGroup: null });
  if (g) store.set({ sel: { layerId: g.layerIds[0], layerIds: g.layerIds } });
}

export function editGroup(id: string, fn: (g: Draft<Group>) => void, merge?: string) {
  store.edit((d) => { const g = d.groups?.find((x) => x.id === id); if (g) fn(g); }, merge);
}

/** move every member (and its keyframes) by dt, optionally to another group row */
export function shiftGroup(d: Draft<Project>, id: string, dt: number, row?: number) {
  const g = d.groups?.find((x) => x.id === id);
  if (!g) return;
  if (row !== undefined) g.row = Math.max(0, row);
  if (!dt) return;
  d.layers.forEach((l) => {
    if (!g.layerIds.includes(l.id)) return;
    l.start = +(l.start + dt).toFixed(4);
    l.end = +(l.end + dt).toFixed(4);
    (l as Layer).params = shiftKeys(l.params as ParamMap, dt) as any;
    l.masks.forEach((m) => { m.params = shiftKeys(m.params as ParamMap, dt) as any; });
  });
}

export function setMembersEnabled(id: string, on: boolean) {
  store.edit((d) => { const g = d.groups?.find((x) => x.id === id); d.layers.forEach((l) => { if (g?.layerIds.includes(l.id)) l.enabled = on; }); });
}

/** layers the selection refers to (multi-select + primary) */
export function selectedLayerIds(): string[] {
  const s = store.state.sel;
  return [...new Set([...(s.layerIds ?? []), ...(s.layerId ? [s.layerId] : [])])];
}
