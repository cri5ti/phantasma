// Feedback trails: instead of re-drawing the generator N times per frame (echo trails), keep a low-res history
// buffer per layer. Each frame the history is transformed (zoom / rotate / drift), blurred, hue-shifted and faded,
// then the new frame is laid on top:   hist_n = T(buf_{n-1}),   buf_n = hist_n ⊕ frame_n
// One generator draw per frame instead of N.
//
// Staying exact when frames arrive out of order (scrubbing, Remotion's parallel tabs render strided frames):
//   · next frame, or a frame a little ahead → catch up from the stored state (simulating the frames in between)
//   · anything else → warm up from scratch over the last K frames, K = frames until the decay makes older
//     contributions invisible (< 1/256), capped by `warm`
// So sequential playback costs 1 draw/frame and a cold frame at most K low-res draws.
import type { Layer } from '../core/types';
import { drawGen, type Env } from './draw';

export interface FbParams {
  decay: number;   // opacity kept per frame (0..1)
  zoom: number;    // scale per frame around the centre (1 = none)
  rotate: number;  // degrees per frame
  driftX: number;  // stage px per frame
  driftY: number;
  blur: number;    // stage px per frame
  hue: number;     // degrees per frame
  blend: GlobalCompositeOperation;
  res: number;     // history buffer resolution (fraction of the layer canvas)
  warm: number;    // max warm-up frames for a cold start
}

interface State {
  layer: Layer;       // edits produce a new layer object → history restarts
  /** inputs the generator reads besides time: when they change (audio analysis loads, tempo / lyrics edited) the history is stale */
  audio: unknown;
  tempo: unknown;
  lyrics: unknown;
  w: number;
  h: number;
  frame: number;      // buf holds buf_frame
  histFrame: number;  // hist holds hist_histFrame
  buf: HTMLCanvasElement;
  hist: HTMLCanvasElement;
}

const states = new Map<string, State>();
const lowCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** frames until decay^K < 1/256 */
const fadeFrames = (decay: number) => (decay <= 0 ? 1 : decay >= 0.999 ? 10_000 : Math.ceil(Math.log(1 / 256) / Math.log(decay)));

function transformInto(dst: HTMLCanvasElement, src: HTMLCanvasElement, p: FbParams, unit: number) {
  const g = dst.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, dst.width, dst.height);
  g.globalAlpha = Math.max(0, Math.min(1, p.decay));
  const f: string[] = [];
  if (p.blur > 0) f.push(`blur(${(p.blur * unit).toFixed(2)}px)`);
  if (p.hue) f.push(`hue-rotate(${p.hue}deg)`);
  g.filter = f.join(' ') || 'none';
  const cx = dst.width / 2, cy = dst.height / 2;
  g.translate(cx + p.driftX * unit, cy + p.driftY * unit);
  if (p.rotate) g.rotate((p.rotate * Math.PI) / 180);
  if (p.zoom !== 1) g.scale(p.zoom, p.zoom);
  g.translate(-cx, -cy);
  g.drawImage(src, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.filter = 'none';
  g.globalAlpha = 1;
}

function addFrame(buf: HTMLCanvasElement, hist: HTMLCanvasElement, frame: CanvasImageSource, blend: GlobalCompositeOperation) {
  const g = buf.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.clearRect(0, 0, buf.width, buf.height);
  g.drawImage(hist, 0, 0);
  g.globalCompositeOperation = blend;
  g.drawImage(frame, 0, 0, buf.width, buf.height);
  g.globalCompositeOperation = 'source-over';
}

/**
 * History for frame n of a feedback layer (null before the layer has any past), plus `commit(cur)` to fold the
 * full-res current frame into the buffer once it has been drawn.
 */
export function feedbackFrame(layer: Layer, env: Env, n: number, cw: number, ch: number, p: FbParams) {
  const bw = Math.max(2, Math.round(cw * p.res)), bh = Math.max(2, Math.round(ch * p.res));
  let s = states.get(layer.id);
  if (!s || s.layer !== layer || s.w !== bw || s.h !== bh || s.audio !== env.audio || s.tempo !== env.tempo || s.lyrics !== env.lyrics) {
    s = { layer, audio: env.audio, tempo: env.tempo, lyrics: env.lyrics, w: bw, h: bh, frame: -1e9, histFrame: -1e9, buf: canvas(bw, bh), hist: canvas(bw, bh) };
    states.set(layer.id, s);
  }
  const st = s;
  const unit = bw / env.W; // stage px → buffer px
  const first = Math.ceil(layer.start * env.fps - 1e-6);
  const noop = { hist: n > first && st.histFrame === n ? st.hist : null, commit: (_c: CanvasImageSource) => {} };
  if (n <= first) {
    // the layer's first frame has no past
    st.buf.getContext('2d')!.clearRect(0, 0, bw, bh);
    st.frame = n - 1;
  }
  if (st.histFrame === n && st.frame === n) return noop; // same frame drawn again (re-render)

  const K = Math.max(1, Math.min(Math.round(p.warm), fadeFrames(p.decay)));
  let from: number;
  if (st.frame < n && n - st.frame <= K) from = st.frame + 1; // catch up from the stored state
  else {
    st.buf.getContext('2d')!.clearRect(0, 0, bw, bh); // cold: warm up over the last K frames
    from = Math.max(first, n - K);
  }
  if (from < first) from = first;
  // simulate the frames we skipped (low res) — scratch canvas shared by all feedback layers
  if (from < n && (lowCanvas.width !== bw || lowCanvas.height !== bh)) { lowCanvas.width = bw; lowCanvas.height = bh; }
  const low = lowCanvas;
  const lg = low.getContext('2d')!;
  for (let k = from; k < n; k++) {
    transformInto(st.hist, st.buf, p, unit);
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.clearRect(0, 0, bw, bh);
    lg.setTransform(unit, 0, 0, unit, 0, 0);
    drawGen(lg, layer.gen, layer.params, { ...env, t: k / env.fps }, layer, true);
    addFrame(st.buf, st.hist, low, p.blend);
  }
  st.frame = n - 1;
  if (n > first) transformInto(st.hist, st.buf, p, unit);
  else st.hist.getContext('2d')!.clearRect(0, 0, bw, bh);
  st.histFrame = n;
  return {
    hist: n > first ? st.hist : null,
    commit: (cur: CanvasImageSource) => {
      addFrame(st.buf, st.hist, cur, p.blend);
      st.frame = n;
    },
  };
}
