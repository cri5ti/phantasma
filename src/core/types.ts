// Project schema. Everything is serialisable JSON; times are in seconds.

export type Easing = 'linear' | 'hold' | 'easeIn' | 'easeOut' | 'easeInOut' | 'expoOut' | 'backOut';

export interface Keyframe {
  t: number; // absolute song time (s)
  v: Prim;
  e?: Easing; // easing from this key to the next
}

export type ModSource =
  | 'rms' | 'bass' | 'mid' | 'high' | 'onset' | 'centroid'
  | 'beat' | 'bar' | 'lfo' | 'sectionProgress' | 'layerProgress';

/** Audio/time modulation added on top of the (keyframed) base value: v = base + amount * shape(source). */
export interface Modulation {
  src: ModSource;
  amount: number;
  /** peak-hold release in seconds for audio sources; decay time for beat/bar pulses; period (beats) for lfo */
  release?: number;
  /** exponent applied to the 0..1 source (gamma) */
  curve?: number;
  /** lower threshold: source below it is treated as 0, rest rescaled */
  gate?: number;
}

export type Prim = number | string | boolean;

export interface Animated {
  $k?: Keyframe[];
  $mod?: Modulation[];
  /** base value when there are no keyframes */
  v?: Prim;
}

export type ParamValue = Prim | Animated;
export type ParamMap = Record<string, ParamValue>;

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten'
  | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference'
  | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity' | 'plus-lighter';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'screen', 'plus-lighter', 'multiply', 'overlay', 'soft-light', 'hard-light',
  'color-dodge', 'color-burn', 'darken', 'lighten', 'difference', 'exclusion',
  'hue', 'saturation', 'color', 'luminosity',
];

export interface Mask {
  id: string;
  enabled: boolean;
  /** generator id (shape, text, gradient, any visualizer...) drawn to build the mask */
  gen: string;
  params: ParamMap;
  /** how this mask combines with the ones above it */
  op: 'add' | 'subtract' | 'intersect';
  mode: 'alpha' | 'luminance';
  invert: boolean;
  feather: number; // px blur
}

export type LayerKind = 'video' | 'image' | 'gen';

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  enabled: boolean;
  solo?: boolean;
  locked?: boolean;
  start: number;
  end: number;
  /** fade in/out (s) applied to opacity */
  fadeIn: number;
  fadeOut: number;
  blend: BlendMode;
  /** Photoshop-style clipping: only visible where the layer directly below has alpha */
  clipBelow?: boolean;
  /** media id from media.json (video/image) */
  media?: string;
  /** generator id (kind === 'gen') */
  gen?: string;
  /** common transform/filter params + media/generator specific params */
  params: ParamMap;
  masks: Mask[];
  color?: string; // timeline tint
  /** storyboard shot this layer was built from (rebuilt by "Build timeline") */
  shot?: string;
}

export interface TempoSection {
  start: number;
  end: number;
  bpm: number;
  /** time of a downbeat inside (or before) the section; grid is anchored here */
  beatOffset: number;
  beatsPerBar: number;
  label: string;
  color?: string;
}

export interface Marker {
  t: number;
  label: string;
}

export interface Project {
  version: 1;
  name: string;
  audio: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  background: string;
  tempo: TempoSection[];
  markers: Marker[];
  /** bottom → top */
  layers: Layer[];
  /** pre-production: brief, shot plan along the song, idea board */
  storyboard?: Storyboard;
  /** word-timed lyrics for timeline syncing */
  lyrics?: Lyrics;
  /** precise sync points (right-click the timeline) */
  cues?: Cue[];
  /** timeline organisation: layer groups on group rows (focus = timeline filter, compositing unchanged) */
  groups?: Group[];
}

export interface Group {
  id: string;
  name: string;
  color?: string;
  /** group row (0 = top); several groups can share a row back to back */
  row: number;
  layerIds: string[];
  /** members hidden from the layer list */
  collapsed?: boolean;
}

export interface Cue {
  id: string;
  t: number;
  label: string;
  color?: string;
}

export interface LyricWord {
  w: string;
  /** start / end (s) */
  t: number;
  e: number;
  /** where the timing came from: transcript, interpolated, local forced alignment, or hand-edited */
  src?: 'asr' | 'interp' | 'aligned' | 'manual';
  /** confidence 0..1 */
  p?: number;
}

export interface LyricLine {
  id: string;
  section?: string;
  words: LyricWord[];
}

export interface Lyrics {
  lines: LyricLine[];
  source?: { kind: string; at: string; model?: string; matched?: number; total?: number };
}

// ---- storyboard ------------------------------------------------------------------

export type StockProvider = 'pexels' | 'pixabay' | 'mixkit';

/** A stock search hit (remote) — thumbnails are hot-linked until downloaded. */
export interface StockRef {
  /** 'local' = footage already in the project folder (media is set) */
  provider: StockProvider | 'local';
  id: string;
  kind: 'video' | 'image';
  thumb: string;
  /** small mp4 for hover/motion preview (videos) */
  preview?: string;
  /** ~720p mp4 from the CDN: big preview + streamed timeline stand-in until downloaded */
  previewHd?: string;
  /** provider page (attribution) */
  page: string;
  author?: string;
  authorUrl?: string;
  width: number;
  height: number;
  duration?: number;
  tags?: string[];
  /** media id once downloaded into the project folder */
  media?: string;
}

export type ShotTransition = 'cut' | 'crossfade' | 'dip';

export interface Shot {
  id: string;
  start: number;
  end: number;
  /** tempo section label it was planned for */
  section?: string;
  /** what we see */
  description: string;
  /** stock search query */
  query: string;
  mood?: string;
  /** lyric line(s) sung over this shot */
  lyric?: string;
  tags: string[];
  /** 'footage' = stock clip, 'gen' = one of our generators carries the shot */
  source: 'footage' | 'gen';
  gen?: string;
  candidates: StockRef[];
  /** index into candidates */
  pick?: number;
  /** transition INTO this shot */
  transition: ShotTransition;
  fade: number;
  notes?: string;
}

export type BoardKind = 'idea' | 'note' | 'lyric' | 'stock' | 'media' | 'section';

/** A card on the idea board (free canvas). */
export interface BoardItem {
  id: string;
  kind: BoardKind;
  x: number;
  y: number;
  text?: string;
  tags: string[];
  stock?: StockRef;
  /** local media id (kind === 'media') */
  media?: string;
  color?: string;
  /** provenance for AI-suggested items */
  source?: { model: string; at: string; prompt?: string };
}

export interface StoryBrief {
  prompt: string;
  /** plain or LRC-timestamped ([mm:ss.xx]) */
  lyrics: string;
  style: string;
}

export interface Storyboard {
  brief: StoryBrief;
  shots: Shot[];
  board: BoardItem[];
  /** AI runs, newest last (for provenance) */
  log: { at: string; model: string; kind: string; prompt: string }[];
}

export interface MediaItem {
  id: string;
  kind: 'video' | 'image';
  src: string;
  proxy?: string;
  thumb?: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** streamed from a stock CDN (not downloaded yet) — preview only, never used by the final render */
  remote?: boolean;
}
