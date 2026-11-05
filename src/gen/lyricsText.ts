// Lyrics generator: renders the project's word-timed lyrics (project.lyrics) — pure function of time.
//   line   whole line at once          word   one word at a time
//   build  line builds word by word    focus  whole line, the sung word highlighted (karaoke)
// Every part (the line, or each word) gets in/out effects; motion runs continuously per word.
import type { LyricLine, LyricWord } from '../core/types';
import { FONTS } from './shapes';
import { hashString, mulberry32, type GenDef } from './types';

const IN_FX = ['none', 'fade', 'blur', 'rise', 'drop', 'zoom', 'pop', 'slide-left', 'slide-right', 'typewriter'];
const OUT_FX = ['none', 'fade', 'blur', 'rise', 'drop', 'zoom', 'slide-left', 'slide-right'];
const MOTION = ['none', 'float', 'wave', 'shake', 'pulse', 'sway'];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const backOut = (x: number) => { const c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };

interface Look { alpha: number; dx: number; dy: number; scale: number; blur: number; reveal: number }
const IDLE: Look = { alpha: 1, dx: 0, dy: 0, scale: 1, blur: 0, reveal: 1 };

/** effect at progress k (0 = start of the effect, 1 = settled); `out` runs the same curves backwards */
function fx(kind: string, k: number, dist: number, blurMax: number): Look {
  const e = easeOut(clamp01(k));
  const l = { ...IDLE };
  switch (kind) {
    case 'fade': l.alpha = e; break;
    case 'blur': l.alpha = e; l.blur = (1 - e) * blurMax; break;
    case 'rise': l.alpha = e; l.dy = (1 - e) * dist; break;
    case 'drop': l.alpha = e; l.dy = -(1 - e) * dist; break;
    case 'zoom': l.alpha = e; l.scale = 0.6 + 0.4 * e; break;
    case 'pop': l.alpha = clamp01(k * 3); l.scale = Math.max(0, backOut(clamp01(k))); break;
    case 'slide-left': l.alpha = e; l.dx = (1 - e) * dist; break;
    case 'slide-right': l.alpha = e; l.dx = -(1 - e) * dist; break;
    case 'typewriter': l.reveal = clamp01(k); break;
  }
  return l;
}
const merge = (a: Look, b: Look): Look => ({ alpha: a.alpha * b.alpha, dx: a.dx + b.dx, dy: a.dy + b.dy, scale: a.scale * b.scale, blur: a.blur + b.blur, reveal: Math.min(a.reveal, b.reveal) });

const start = (l: LyricLine) => l.words[0].t;
const end = (l: LyricLine) => l.words[l.words.length - 1].e;

export const lyricsGen: GenDef = {
  id: 'lyrics',
  name: 'Lyrics',
  category: 'text',
  params: [
    { key: 'mode', type: 'select', default: 'line', options: ['line', 'word', 'build', 'focus'], group: 'Lyrics', static: true, hint: 'line = whole line · word = one word at a time · build = builds word by word · focus = whole line, sung word highlighted' },
    { key: 'lead', label: 'Show early (s)', type: 'number', default: 0.15, min: 0, max: 3, step: 0.01, group: 'Lyrics', hint: 'appear this long before the first word' },
    { key: 'hold', label: 'Hold after (s)', type: 'number', default: 0.5, min: 0, max: 5, step: 0.01, group: 'Lyrics', hint: 'stay after the last word (cut short by the next line)' },
    { key: 'section', label: 'Only section', type: 'text', default: '', group: 'Lyrics', static: true, hint: 'show only lines of this lyric section (empty = all)' },
    { key: 'caseMode', label: 'Case', type: 'select', default: 'as is', options: ['as is', 'UPPER', 'lower'], group: 'Lyrics', static: true },
    { key: 'font', type: 'select', default: 'Bebas Neue', options: FONTS, group: 'Text', static: true },
    { key: 'weight', type: 'select', default: '400', options: ['300', '400', '700', '900'], group: 'Text', static: true },
    { key: 'size', type: 'number', default: 96, min: 8, max: 600, step: 1, group: 'Text' },
    { key: 'x', type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, group: 'Text' },
    { key: 'y', type: 'number', default: 0.82, min: -0.5, max: 1.5, step: 0.005, group: 'Text' },
    { key: 'align', type: 'select', default: 'center', options: ['left', 'center', 'right'], group: 'Text', static: true },
    { key: 'maxWidth', label: 'Wrap width', type: 'number', default: 0.8, min: 0.1, max: 1, step: 0.01, group: 'Text', hint: 'fraction of the frame width' },
    { key: 'lineHeight', type: 'number', default: 1.15, min: 0.6, max: 3, step: 0.01, group: 'Text' },
    { key: 'tracking', label: 'Letter spacing', type: 'number', default: 0, min: -20, max: 100, step: 0.5, group: 'Text' },
    { key: 'color', type: 'color', default: '#ffffff', group: 'Style' },
    { key: 'stroke', type: 'color', default: '#000000', group: 'Style' },
    { key: 'strokeWidth', type: 'number', default: 0, min: 0, max: 30, step: 0.5, group: 'Style' },
    { key: 'glow', type: 'number', default: 0, min: 0, max: 80, step: 1, group: 'Style' },
    { key: 'shadow', type: 'number', default: 8, min: 0, max: 60, step: 1, group: 'Style', hint: 'soft drop shadow' },
    { key: 'box', label: 'Box', type: 'color', default: '#00000000', group: 'Style', hint: 'subtitle box behind the line (alpha = opacity)' },
    { key: 'boxPad', label: 'Box padding', type: 'number', default: 22, min: 0, max: 120, step: 1, group: 'Style' },
    { key: 'focusColor', label: 'Sung word', type: 'color', default: '#ffd84d', group: 'Focus', hint: 'focus mode: the word being sung' },
    { key: 'sungColor', label: 'Already sung', type: 'color', default: '#ffffff', group: 'Focus' },
    { key: 'upcoming', label: 'Upcoming opacity', type: 'number', default: 0.45, min: 0, max: 1, step: 0.01, group: 'Focus' },
    { key: 'focusScale', label: 'Sung word scale', type: 'number', default: 1.12, min: 0.5, max: 2, step: 0.01, group: 'Focus' },
    { key: 'focusGlow', label: 'Sung word glow', type: 'number', default: 18, min: 0, max: 80, step: 1, group: 'Focus' },
    { key: 'inFx', label: 'In', type: 'select', default: 'rise', options: IN_FX, group: 'Animate', static: true },
    { key: 'inDur', label: 'In time (s)', type: 'number', default: 0.25, min: 0.01, max: 3, step: 0.01, group: 'Animate' },
    { key: 'outFx', label: 'Out', type: 'select', default: 'fade', options: OUT_FX, group: 'Animate', static: true },
    { key: 'outDur', label: 'Out time (s)', type: 'number', default: 0.3, min: 0.01, max: 3, step: 0.01, group: 'Animate' },
    { key: 'fxDist', label: 'Move distance', type: 'number', default: 40, min: 0, max: 600, step: 1, group: 'Animate', hint: 'px for rise / drop / slide' },
    { key: 'fxBlur', label: 'Blur amount', type: 'number', default: 18, min: 0, max: 80, step: 1, group: 'Animate' },
    { key: 'motion', type: 'select', default: 'none', options: MOTION, group: 'Animate', static: true, hint: 'continuous per-word motion; pulse follows the beat' },
    { key: 'motionAmt', label: 'Motion amount', type: 'number', default: 6, min: 0, max: 80, step: 0.5, group: 'Animate' },
    { key: 'motionSpeed', label: 'Motion speed', type: 'number', default: 1, min: 0, max: 8, step: 0.05, group: 'Animate' },
  ],
  draw(ctx, p, f) {
    const all = f.lyrics?.lines.filter((l) => l.words.length && (!p.section || (l.section ?? '').toLowerCase() === String(p.section).toLowerCase())) ?? [];
    if (!all.length) return;
    const t = f.t;
    // the line on screen: the last one that has begun (incl. lead), until its hold ends or the next line takes over
    let li = -1;
    for (let i = 0; i < all.length; i++) if (start(all[i]) - p.lead <= t) li = i; else break;
    if (li < 0) return;
    const line = all[li];
    const next = all[li + 1];
    const tIn = start(line) - p.lead;
    const tOut = Math.min(end(line) + p.hold, next ? start(next) - p.lead : Infinity);
    if (t >= tOut) return;

    const cased = (w: string) => (p.caseMode === 'UPPER' ? w.toUpperCase() : p.caseMode === 'lower' ? w.toLowerCase() : w);
    ctx.font = `${p.weight} ${p.size}px "${p.font}"`;
    (ctx as any).letterSpacing = `${p.tracking}px`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const space = ctx.measureText(' ').width;
    const words = p.mode === 'word'
      ? (() => { const cur = [...line.words].reverse().find((w) => w.t <= t) ?? line.words[0]; return [cur]; })()
      : line.words;
    const widths = words.map((w) => ctx.measureText(cased(w.w)).width);

    // wrap into rows (stable layout: the whole line is laid out even while it builds)
    const maxW = f.W * p.maxWidth;
    const rows: number[][] = [[]];
    let rw = 0;
    words.forEach((_, i) => {
      const add = (rows[rows.length - 1].length ? space : 0) + widths[i];
      if (rows[rows.length - 1].length && rw + add > maxW) { rows.push([]); rw = 0; }
      rw += rows[rows.length - 1].length ? space + widths[i] : widths[i];
      rows[rows.length - 1].push(i);
    });
    const lh = p.size * p.lineHeight;
    const y0 = f.H * p.y - ((rows.length - 1) * lh) / 2;
    const pos: { x: number; y: number }[] = [];
    let minX = Infinity, maxX = -Infinity;
    rows.forEach((r, ri) => {
      const w = r.reduce((a, i, k) => a + widths[i] + (k ? space : 0), 0);
      let x = p.align === 'left' ? f.W * p.x : p.align === 'right' ? f.W * p.x - w : f.W * p.x - w / 2;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x + w);
      r.forEach((i) => { pos[i] = { x, y: y0 + ri * lh }; x += widths[i] + space; });
    });

    // line-level in/out (all modes except word, where each word has its own)
    const outK = p.outFx === 'none' ? 1 : clamp01((tOut - t) / p.outDur);
    const lineOut = fx(p.outFx, outK, p.fxDist, p.fxBlur);
    const lineIn = p.mode === 'line' || p.mode === 'focus' ? fx(p.inFx, p.inFx === 'none' ? 1 : (t - tIn) / p.inDur, p.fxDist, p.fxBlur) : IDLE;
    const lineLook = merge(lineIn, lineOut);

    // subtitle box
    const box = String(p.box);
    if (box.length === 9 && box.slice(7) !== '00' || box.length === 7) {
      ctx.save();
      ctx.globalAlpha = lineLook.alpha;
      ctx.fillStyle = box;
      const pad = p.boxPad;
      const x = minX - pad, y = y0 - lh / 2 - pad / 2, w = maxX - minX + pad * 2, h = rows.length * lh + pad;
      const r = Math.min(pad, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
      ctx.fill();
      ctx.restore();
    }

    // which word is being sung (focus / build)
    const cur = (() => { let c = -1; words.forEach((w, i) => { if (w.t <= t) c = i; }); return c; })();
    const rnd = mulberry32(hashString(line.id) ^ f.seed);
    const phase = words.map(() => rnd() * Math.PI * 2);

    words.forEach((w: LyricWord, i) => {
      let look = lineLook;
      if (p.mode === 'build') {
        if (t < w.t - 0.02) return; // not sung yet
        look = merge(fx(p.inFx, p.inFx === 'none' ? 1 : (t - w.t) / p.inDur, p.fxDist, p.fxBlur), lineOut);
      } else if (p.mode === 'word') {
        const nextW = line.words[line.words.indexOf(w) + 1];
        const wOut = Math.min(w.e + p.hold, nextW ? nextW.t : tOut, tOut);
        if (t >= wOut) return;
        // a word enters exactly on its start: the previous one stays until then (no blank gap between words)
        const k0 = Math.min(w.t, t);
        look = merge(fx(p.inFx, p.inFx === 'none' ? 1 : (t - k0) / p.inDur, p.fxDist, p.fxBlur), fx(p.outFx, p.outFx === 'none' ? 1 : (wOut - t) / p.outDur, p.fxDist, p.fxBlur));
      }
      // continuous motion
      const ms = p.motionSpeed, ma = p.motionAmt;
      let mx = 0, my = 0, mr = 0, msc = 1;
      if (p.motion === 'float') my = Math.sin(t * ms * Math.PI + phase[i]) * ma;
      else if (p.motion === 'wave') my = Math.sin(t * ms * 6 - i * 0.8) * ma;
      else if (p.motion === 'shake') { const r = mulberry32((hashString(line.id) + i * 7919 + Math.floor(t * 24 * Math.max(0.1, ms))) | 0); mx = (r() - 0.5) * 2 * ma; my = (r() - 0.5) * 2 * ma; }
      else if (p.motion === 'pulse') msc = 1 + (ma / 100) * Math.exp(-f.beat.sinceBeat / 0.15);
      else if (p.motion === 'sway') mr = Math.sin(t * ms * 2 + phase[i]) * ma * 0.01;

      let color = p.color, alpha = 1, glow = p.glow, scale = 1;
      if (p.mode === 'focus' || p.mode === 'build') {
        const nextT = words[i + 1]?.t ?? end(line) + p.hold;
        if (i === cur && t < nextT) {
          const k = clamp01((t - w.t) / 0.12);
          color = p.focusColor; glow = Math.max(glow, p.focusGlow); scale = 1 + (p.focusScale - 1) * easeOut(k);
        } else if (i < cur || (i === cur && t >= nextT)) color = p.sungColor;
        else if (p.mode === 'focus') alpha = p.upcoming;
      }

      const text = cased(w.w);
      const shown = look.reveal < 1 ? text.slice(0, Math.ceil(text.length * look.reveal)) : text;
      if (!shown || look.alpha * alpha <= 0.002) return;
      const cx = pos[i].x + widths[i] / 2, cy = pos[i].y;
      ctx.save();
      ctx.translate(cx + look.dx + mx, cy + look.dy + my);
      if (mr) ctx.rotate(mr);
      const s = look.scale * scale * msc;
      if (s !== 1) ctx.scale(s, s);
      ctx.globalAlpha = clamp01(look.alpha * alpha);
      if (look.blur > 0.3) ctx.filter = `blur(${look.blur.toFixed(1)}px)`;
      if (glow > 0) { ctx.shadowBlur = glow; ctx.shadowColor = color; }
      else if (p.shadow > 0) { ctx.shadowBlur = p.shadow; ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowOffsetY = p.shadow / 4; }
      if (p.strokeWidth > 0) {
        ctx.lineWidth = p.strokeWidth;
        ctx.strokeStyle = p.stroke;
        ctx.lineJoin = 'round';
        ctx.strokeText(shown, -widths[i] / 2, 0);
      }
      ctx.fillStyle = color;
      ctx.fillText(shown, -widths[i] / 2, 0);
      ctx.restore();
    });
    (ctx as any).letterSpacing = '0px';
  },
  presets: {
    'Karaoke': { mode: 'focus', inFx: 'fade', outFx: 'fade', focusColor: '#ffd84d', upcoming: 0.4, size: 84, y: 0.85, shadow: 10 },
    'Subtitles': { mode: 'line', inFx: 'fade', outFx: 'fade', inDur: 0.12, outDur: 0.12, size: 56, y: 0.9, font: 'Inter', weight: '700', box: '#000000a0', boxPad: 18, shadow: 0 },
    'Word punch': { mode: 'word', inFx: 'pop', outFx: 'zoom', inDur: 0.18, outDur: 0.15, size: 220, y: 0.5, caseMode: 'UPPER', motion: 'pulse', motionAmt: 8, hold: 0.15 },
    'Build-up': { mode: 'build', inFx: 'rise', inDur: 0.3, outFx: 'blur', outDur: 0.4, size: 110, y: 0.5, caseMode: 'UPPER', focusColor: '#ffffff', sungColor: '#ffffffcc' },
    'Dreamy': { mode: 'line', inFx: 'blur', outFx: 'blur', inDur: 0.8, outDur: 0.8, lead: 0.6, hold: 1, size: 120, y: 0.5, motion: 'float', motionAmt: 8, motionSpeed: 0.6, glow: 24, color: '#e8f0ff' },
    'Typewriter': { mode: 'build', inFx: 'typewriter', inDur: 0.2, outFx: 'fade', font: 'Courier New', size: 64, y: 0.8, caseMode: 'lower', shadow: 0 },
  },
};
