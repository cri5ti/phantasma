// Per-project view memory: stage, side tab, timeline viewport + playhead, idea-board viewport, preview toggles.
// Saved in localStorage under a key derived from the project folder, and mirrored into the URL fragment
// (#p=…&m=story&tab=board&t=62.50&z=12&s=30&bv=10,-40,0.8) so a link reopens the same view.
// Precedence on load: URL fragment (when it belongs to this project) > localStorage > defaults.
import { store, type Mode, type SideTab } from './store';

export interface ViewState {
  mode?: Mode;
  tab?: SideTab;
  /** playhead (s) */
  t?: number;
  /** timeline px/s and left edge (s) */
  z?: number;
  s?: number;
  /** idea board pan/zoom */
  bv?: { x: number; y: number; z: number };
  overlay?: boolean;
  motion?: boolean;
  proxies?: boolean;
  res?: number;
  /** focused group id */
  g?: string;
}

let projectKey = '';
/** board viewport lives in the Board component; it reports here so it can be saved */
export const boardView: { current: { x: number; y: number; z: number } } = { current: { x: 0, y: 0, z: 1 } };

/** FNV-1a → short base36 id; stable per folder path */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

const TABS: SideTab[] = ['brief', 'shot', 'board', 'ai'];
const num = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const bool = (v: string | null) => (v === '1' ? true : v === '0' ? false : undefined);

function parseHash(h: string): { p?: string; v: ViewState } {
  const q = new URLSearchParams(h.replace(/^#/, ''));
  const bv = q.get('bv')?.split(',').map(Number);
  return {
    p: q.get('p') ?? undefined,
    v: {
      mode: q.get('m') === 'story' || q.get('m') === 'edit' ? (q.get('m') as Mode) : undefined,
      tab: TABS.includes(q.get('tab') as SideTab) ? (q.get('tab') as SideTab) : undefined,
      t: num(q.get('t')),
      z: num(q.get('z')),
      s: num(q.get('s')),
      bv: bv && bv.length === 3 && bv.every(Number.isFinite) ? { x: bv[0], y: bv[1], z: bv[2] } : undefined,
      overlay: bool(q.get('ov')),
      motion: bool(q.get('mo')),
      proxies: bool(q.get('px')),
      res: num(q.get('res')),
      g: q.get('g') ?? undefined,
    },
  };
}

function toHash(v: ViewState) {
  const q = new URLSearchParams();
  q.set('p', projectKey);
  if (v.mode) q.set('m', v.mode);
  if (v.tab) q.set('tab', v.tab);
  if (v.t !== undefined) q.set('t', v.t.toFixed(2));
  if (v.z !== undefined) q.set('z', String(+v.z.toFixed(3)));
  if (v.s !== undefined) q.set('s', v.s.toFixed(2));
  if (v.bv) q.set('bv', [Math.round(v.bv.x), Math.round(v.bv.y), +v.bv.z.toFixed(3)].join(','));
  if (v.overlay !== undefined) q.set('ov', v.overlay ? '1' : '0');
  if (v.motion !== undefined) q.set('mo', v.motion ? '1' : '0');
  if (v.proxies !== undefined) q.set('px', v.proxies ? '1' : '0');
  if (v.res !== undefined) q.set('res', String(v.res));
  if (v.g) q.set('g', v.g);
  return '#' + q.toString().replace(/%2C/g, ',');
}

const strip = (v: ViewState): ViewState => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as ViewState;

/** Read the saved view for this project folder (call once, before the first render). */
export function loadView(projectDir: string, projectName: string): ViewState {
  projectKey = `${slug(projectName)}-${hash(projectDir.toLowerCase().replace(/\\/g, '/'))}`;
  let saved: ViewState = {};
  try { saved = JSON.parse(localStorage.getItem(`mv.view.${projectKey}`) ?? '{}'); } catch { /* none */ }
  const fromUrl = parseHash(location.hash);
  // a fragment copied from another project's editor shouldn't scramble this one
  const url = !fromUrl.p || fromUrl.p === projectKey ? strip(fromUrl.v) : {};
  const v = { ...saved, ...url };
  if (v.bv) boardView.current = v.bv;
  return v;
}

/** Apply the view-related UI fields (timeline viewport is clamped to the song). */
export function applyView(v: ViewState) {
  const p = store.state.project;
  const patch: Record<string, unknown> = {};
  if (v.mode) patch.mode = v.mode;
  if (v.tab) patch.sideTab = v.tab;
  if (v.z !== undefined) patch.zoom = Math.max(1, Math.min(600, v.z));
  if (v.s !== undefined) patch.scroll = Math.max(0, Math.min(p.duration, v.s));
  if (v.overlay !== undefined) patch.sbOverlay = v.overlay;
  if (v.motion !== undefined) patch.sbMotion = v.motion;
  if (v.proxies !== undefined) patch.useProxies = v.proxies;
  if (v.res !== undefined && [0.25, 0.5, 1].includes(v.res)) patch.previewScale = v.res;
  if (v.g !== undefined) patch.focusGroup = p.groups?.some((x) => x.id === v.g) ? v.g : null;
  store.set(patch as any);
  if (v.bv) boardView.current = v.bv;
  if (v.t !== undefined) seekWhenReady(Math.max(0, Math.min(p.duration, v.t)));
}

/** the player registers its seek handler after mounting */
function seekWhenReady(t: number, tries = 40) {
  if (store.seekHandler) store.seek(t);
  else if (tries > 0) setTimeout(() => seekWhenReady(t, tries - 1), 100);
  else store.setTime(t);
}

function current(): ViewState {
  const s = store.state;
  return {
    mode: s.mode, tab: s.sideTab, t: store.time, z: s.zoom, s: s.scroll, bv: boardView.current,
    overlay: s.sbOverlay, motion: s.sbMotion, proxies: s.useProxies, res: s.previewScale, g: s.focusGroup ?? undefined,
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let lastHash = '';
/** debounced save to localStorage + URL fragment (replaceState: no history spam) */
export function saveViewSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const v = current();
    try { localStorage.setItem(`mv.view.${projectKey}`, JSON.stringify(v)); } catch { /* storage off */ }
    const h = toHash(v);
    if (h !== lastHash && h !== location.hash) { lastHash = h; history.replaceState(null, '', h); }
  }, 500);
}

/** Keep the saved view in sync with the editor; editing the fragment by hand jumps there. */
export function startViewSync() {
  let prev = current();
  store.subscribe(() => {
    const s = store.state;
    if (s.mode !== prev.mode || s.sideTab !== prev.tab || s.zoom !== prev.z || s.scroll !== prev.s || s.sbOverlay !== prev.overlay
      || s.sbMotion !== prev.motion || s.useProxies !== prev.proxies || s.previewScale !== prev.res || (s.focusGroup ?? undefined) !== prev.g) {
      prev = current();
      saveViewSoon();
    }
  });
  store.subscribeTime(saveViewSoon);
  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    const { p, v } = parseHash(location.hash);
    if (!p || p === projectKey) applyView(strip(v));
  });
  window.addEventListener('beforeunload', () => {
    try { localStorage.setItem(`mv.view.${projectKey}`, JSON.stringify(current())); } catch { /* storage off */ }
  });
  saveViewSoon();
}
