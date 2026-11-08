// Scene layers: a GLSL fragment shader kept in the project folder (e.g. scenes/night-window.frag), with texture
// inputs from the project's media. Layer gen id = "scene:<project-relative path>".
//
// Header lines in the file declare the inspector UI; the matching uniforms are injected (don't declare them):
//   // @name  Night window
//   // @param <key> <number|int|color|bool> <default> [min max [step]] [group=Look] [label="Nice name"] [hint="…"] [static]
//        → uniform float u_<key>   (color → vec4 u_<key>, bool → float 0/1)
//   // @tex   <name> <media id or path> [wrap=clamp|repeat|mirror] [label="…"]
//        → uniform sampler2D t_<name>; uniform vec2 t_<name>_size;   (inspector: media picker, param "tex_<name>")
// Also available: everything in shaders.ts HEADER (uRes, uTime, uBeat, uPulse, uBar, uBass/uMid/uHigh/uRms/uOnset,
// spec(), hash(), noise(), fbm()), plus uLayerT, uFps, uBpm, uBeatPhase, uBarPhase and the helpers below.
// vUv / gl_FragCoord have their origin bottom-left; textures are uploaded so uv (0,0) is the image's bottom-left too.
//
// The editor polls the file and recompiles on save; errors are drawn on the layer (and fail a final render).
import type { ParamDef, Values } from '../core/params';
import { bump, imageFor, preloadImages, resolveRef, assetUrl } from './assets';
import { getGL, setParamUniforms, setStdUniforms, type Wrap } from './shaders';
import { hashString, type FrameCtx, type GenDef } from './types';

export const SCENE_PREFIX = 'scene:';
export const isSceneId = (id: string | undefined): id is string => !!id && id.startsWith(SCENE_PREFIX);
export const sceneFile = (id: string) => id.slice(SCENE_PREFIX.length);

const SCENE_HEADER = `
uniform float uLayerT, uFps, uBpm, uBeatPhase, uBarPhase;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 screenB(vec3 a, vec3 b){ return 1.0 - (1.0 - a) * (1.0 - b); }
/** screen uv → texture uv so a texture of size ts covers the frame (like object-fit: cover) */
vec2 coverUV(vec2 uv, vec2 ts){ float sa = uRes.x / uRes.y, ta = ts.x / ts.y;
  vec2 s = sa > ta ? vec2(1.0, ta / sa) : vec2(sa / ta, 1.0); return (uv - 0.5) * s + 0.5; }
`;

interface TexDecl {
  name: string;
  def: string;
  wrap: Wrap;
  label?: string;
}

export interface Scene {
  file: string;
  src: string;
  name: string;
  params: ParamDef[];
  textures: TexDecl[];
  frag: string;
  progId: string;
  error?: string;
  def: GenDef;
}

interface Slot {
  scene?: Scene;
  /** fetch / parse error before a scene could be built */
  error?: string;
  loading?: Promise<void>;
}

const slots = new Map<string, Slot>();

/** tokenise `a b=c "quoted words" d="x y"` */
function tokens(s: string): string[] {
  return [...s.matchAll(/(\w+=)?"([^"]*)"|\S+/g)].map((m) => (m[2] !== undefined ? (m[1] ?? '') + m[2] : m[0]));
}

function parse(file: string, src: string): Omit<Scene, 'def' | 'error'> {
  const params: ParamDef[] = [];
  const textures: TexDecl[] = [];
  let name = file.split('/').pop()!.replace(/\.[^.]+$/, '');
  const problems: string[] = [];
  src.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*\/\/ ?@(name|param|tex)\s+(.*)$/); // `// @x …` only — indented `//   @x` is prose
    if (!m) return;
    const [kind, rest] = [m[1], m[2].trim()];
    if (kind === 'name') {
      name = rest;
      return;
    }
    const tk = tokens(rest);
    const opts: Record<string, string> = {};
    const pos: string[] = [];
    for (const t of tk) {
      const kv = t.match(/^(\w+)=(.*)$/);
      if (kv) opts[kv[1]] = kv[2];
      else pos.push(t);
    }
    if (kind === 'tex') {
      if (pos.length < 1) return problems.push(`line ${i + 1}: @tex needs a name`);
      const wrap = (opts.wrap ?? 'clamp') as Wrap;
      textures.push({ name: pos[0], def: pos[1] ?? '', wrap: ['clamp', 'repeat', 'mirror'].includes(wrap) ? wrap : 'clamp', label: opts.label });
      return;
    }
    const [key, type, dflt, min, max, step] = pos;
    if (!key || !type) return problems.push(`line ${i + 1}: @param needs <key> <type> <default>`);
    const base = { key, label: opts.label, group: opts.group ?? 'Scene', hint: opts.hint, static: pos.includes('static') || 'static' in opts };
    if (type === 'number' || type === 'float' || type === 'int') {
      params.push({
        ...base, type: 'number', default: Number(dflt ?? 0),
        min: min !== undefined ? Number(min) : undefined, max: max !== undefined ? Number(max) : undefined,
        step: step !== undefined ? Number(step) : type === 'int' ? 1 : 0.01,
      });
    } else if (type === 'color') params.push({ ...base, type: 'color', default: dflt ?? '#ffffff' });
    else if (type === 'bool') params.push({ ...base, type: 'bool', default: dflt === 'true' || dflt === '1' });
    else problems.push(`line ${i + 1}: unknown @param type "${type}" (number | int | color | bool)`);
  });
  if (problems.length) throw new Error(problems.join('\n'));

  const decls = [
    ...params.map((d) => (d.type === 'color' ? `uniform vec4 u_${d.key};` : `uniform float u_${d.key};`)),
    ...textures.map((t) => `uniform sampler2D t_${t.name}; uniform vec2 t_${t.name}_size;`),
  ].join('\n');
  // #line resets numbering so GLSL errors point at the file's own lines
  const pre = SCENE_HEADER + decls + '\n#line 1\n';
  const texParams: ParamDef[] = textures.map((t) => ({
    key: `tex_${t.name}`, label: t.label ?? t.name, type: 'text', default: t.def, static: true, media: 'image', group: 'Textures',
  }));
  return {
    file, src, name, textures,
    params: [...texParams, ...params],
    frag: pre + src,
    progId: `${SCENE_PREFIX}${file}#${hashString(src).toString(36)}`,
  };
}

function errorText(ctx: CanvasRenderingContext2D, f: FrameCtx, title: string, msg: string) {
  ctx.save();
  ctx.fillStyle = 'rgba(40,0,0,0.85)';
  ctx.fillRect(0, 0, f.W, f.H);
  ctx.fillStyle = '#ff7070';
  ctx.font = `${Math.round(f.H / 40)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'top';
  const lines = [title, ...msg.split('\n')].slice(0, 30);
  lines.forEach((l, i) => ctx.fillText(l.slice(0, 140), f.W * 0.03, f.H * 0.04 + i * (f.H / 32)));
  ctx.restore();
}

function build(file: string, src: string): Scene {
  const s = parse(file, src) as Scene;
  const uniformDefs = s.params.filter((d) => d.type !== 'text');
  const gl = getGL();
  gl.forget(`${SCENE_PREFIX}${file}#`);
  try {
    gl.program(s.progId, s.frag);
  } catch (e: any) {
    s.error = String(e?.message ?? e).replace(/^shader [^:]+: /, '');
  }
  s.def = {
    id: SCENE_PREFIX + file,
    name: s.name,
    category: 'scene',
    params: s.params,
    draw(ctx: CanvasRenderingContext2D, p: Values, f: FrameCtx) {
      if (s.error) return errorText(ctx, f, `scene ${file}:`, s.error);
      const imgs: HTMLImageElement[] = [];
      for (const t of s.textures) {
        const ref = String(p[`tex_${t.name}`] ?? t.def);
        const img = imageFor(ref);
        if (!img) {
          if (!resolveRef(ref)) errorText(ctx, f, `scene ${file}:`, ref ? `texture "${t.name}": no media "${ref}"` : `pick an image for texture "${t.name}" in the inspector`);
          return; // still loading — the layer redraws when it lands
        }
        imgs.push(img);
      }
      const m = ctx.getTransform();
      const w = Math.max(2, Math.round(f.W * Math.hypot(m.a, m.b)));
      const h = Math.max(2, Math.round(f.H * Math.hypot(m.c, m.d)));
      const glr = getGL();
      const canvas = glr.render(s.progId, s.frag, w, h, (u, gl) => {
        setStdUniforms(u, gl, f, w, h, f.t);
        setParamUniforms(u, gl, uniformDefs, p);
        const sec = f.tempo.sectionAt(f.t);
        gl.uniform1f(u('uLayerT'), f.layerT);
        gl.uniform1f(u('uFps'), f.fps);
        gl.uniform1f(u('uBpm'), sec?.bpm ?? 120);
        gl.uniform1f(u('uBeatPhase'), f.beat.beat - Math.floor(f.beat.beat));
        gl.uniform1f(u('uBarPhase'), Math.min(1, f.beat.sinceBar / (((60 / (sec?.bpm ?? 120)) * (sec?.beatsPerBar ?? 4)) || 1)));
        s.textures.forEach((t, i) => {
          glr.bindTexture(i, imgs[i], t.wrap);
          gl.uniform1i(u(`t_${t.name}`), i);
          gl.uniform2f(u(`t_${t.name}_size`), imgs[i].naturalWidth, imgs[i].naturalHeight);
        });
      });
      ctx.drawImage(canvas, 0, 0, f.W, f.H);
    },
  };
  return s;
}

async function fetchText(file: string): Promise<string> {
  const url = assetUrl(file);
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return r.text();
}

function slot(file: string): Slot {
  let s = slots.get(file);
  if (!s) slots.set(file, (s = {}));
  return s;
}

/** Load (or reload) a scene file; resolves when it's parsed + compiled (errors are kept on the scene / slot). */
export function loadScene(file: string, force = false): Promise<void> {
  const s = slot(file);
  if (s.loading && !force) return s.loading;
  s.loading = fetchText(file)
    .then((src) => {
      if (s.scene && s.scene.src === src && !force) return;
      try {
        s.scene = build(file, src);
        s.error = undefined;
      } catch (e: any) {
        s.error = String(e?.message ?? e);
      }
      bump();
    })
    .catch((e) => {
      s.error = String(e?.message ?? e);
      bump();
    });
  return s.loading;
}

const placeholders = new Map<string, GenDef>();

/** GenDef for a scene id: the compiled scene, or a stand-in (loading / error) that triggers the load. */
export function sceneGen(id: string): GenDef {
  const file = sceneFile(id);
  const s = slot(file);
  if (s.scene && !s.error) return s.scene.def;
  if (!s.loading) loadScene(file);
  let ph = placeholders.get(id);
  if (!ph) {
    ph = {
      id, name: file.split('/').pop()!, category: 'scene', params: s.scene?.params ?? [],
      draw: (ctx, _p, f) => {
        const err = slots.get(file)?.error;
        if (err) errorText(ctx, f, `scene ${file}:`, err);
      },
    };
    placeholders.set(id, ph);
  }
  return ph;
}

/** problems with a scene (fetch, header, GLSL) or undefined */
export function sceneError(id: string): string | undefined {
  const s = slots.get(sceneFile(id));
  return s?.error ?? s?.scene?.error;
}

export function sceneInfo(id: string): Scene | undefined {
  return slots.get(sceneFile(id))?.scene;
}

/** Load the scenes + textures a set of (gen, params) pairs need. Returns the problems found. */
export async function preloadScenes(uses: { gen?: string; params: Record<string, unknown> }[]): Promise<string[]> {
  const files = [...new Set(uses.filter((u) => isSceneId(u.gen)).map((u) => sceneFile(u.gen!)))];
  await Promise.all(files.map((f) => loadScene(f)));
  const refs = new Set<string>();
  const problems: string[] = [];
  for (const u of uses) {
    if (!isSceneId(u.gen)) continue;
    const id = u.gen;
    const err = sceneError(id);
    if (err) {
      problems.push(`${sceneFile(id)}: ${err}`);
      continue;
    }
    for (const t of sceneInfo(id)!.textures) {
      const raw = u.params[`tex_${t.name}`];
      refs.add(typeof raw === 'string' ? raw : t.def);
    }
  }
  await preloadImages(refs);
  return problems;
}

let watching = false;
/** Editor only: poll loaded scene files and recompile when they change on disk. */
export function watchScenes(ms = 700) {
  if (watching) return;
  watching = true;
  setInterval(() => {
    for (const [file, s] of slots) {
      if (!s.scene && !s.error) continue;
      fetchText(file)
        .then((src) => {
          if (src === s.scene?.src) return;
          try {
            s.scene = build(file, src);
            s.error = undefined;
          } catch (e: any) {
            s.error = String(e?.message ?? e);
          }
          placeholders.delete(SCENE_PREFIX + file);
          bump();
        })
        .catch(() => undefined);
    }
  }, ms);
}
