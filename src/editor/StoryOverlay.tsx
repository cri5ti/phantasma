// Storyboard preview: the picked thumbnail (or preview clip) of the shot under the playhead, drawn over the player
// with the planned transitions, plus a caption. The player underneath keeps driving time + audio.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pickOf } from '../core/storyboard';
import type { Shot } from '../core/types';
import { refThumb } from './StoryPanel';
import { store, useStore, useTime } from './store';

function useBox(aspect: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth, H = el.clientHeight;
      setBox(W / H > aspect ? { w: H * aspect, h: H } : { w: W, h: W / aspect });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return [ref, box] as const;
}

/** opacity of each visible shot at t, following the planned transitions */
function visible(shots: Shot[], t: number): { s: Shot; o: number }[] {
  const out: { s: Shot; o: number }[] = [];
  shots.forEach((s, i) => {
    const next = shots[i + 1];
    const head = s.transition === 'crossfade' ? s.fade / 2 : 0;
    const tail = next?.transition === 'crossfade' ? next.fade / 2 : 0;
    const a = s.start - head, b = s.end + tail;
    if (t < a || t >= b) return;
    let o = 1;
    if (s.transition === 'crossfade' && s.fade > 0) o = Math.min(1, (t - a) / s.fade);
    if (s.transition === 'dip' && s.fade > 0) o = Math.min(o, (t - s.start) / (s.fade / 2));
    if (next?.transition === 'dip' && next.fade > 0) o = Math.min(o, (s.end - t) / (next.fade / 2));
    out.push({ s, o: Math.max(0, Math.min(1, o)) });
  });
  return out;
}

const Motion: React.FC<{ src: string; offset: number }> = ({ src, offset }) => {
  const ref = useRef<HTMLVideoElement>(null);
  const playing = useStore((s) => s.playing);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const d = v.duration || 0;
    const want = d ? offset % d : offset;
    if (!playing || Math.abs(v.currentTime - want) > 0.4) v.currentTime = want;
    if (playing) v.play().catch(() => {});
    else v.pause();
  }, [playing, Math.round(offset * 2)]);
  return <video ref={ref} src={src} muted playsInline preload="auto" />;
};

export const StoryOverlay: React.FC = () => {
  const shots = useStore((s) => s.project.storyboard?.shots);
  const W = useStore((s) => s.project.width);
  const H = useStore((s) => s.project.height);
  const motion = useStore((s) => s.sbMotion);
  useStore((s) => s.media);
  const t = useTime();
  const [ref, box] = useBox(W / H);
  const sorted = React.useMemo(() => [...(shots ?? [])].sort((a, b) => a.start - b.start), [shots]);
  const vis = visible(sorted, t);
  const cur = vis[vis.length - 1]?.s;
  return (
    <div className="sb-overlay" ref={ref}>
      <div className="sb-frame" style={{ width: box.w, height: box.h }}>
        {vis.map(({ s, o }) => {
          const r = pickOf(s);
          const src = r ? refThumb(r) : undefined;
          return (
            <div key={s.id} className="sb-layer" style={{ opacity: o }}>
              {s.source === 'gen' ? <div className="sb-gen">⚡ {s.gen ?? 'generator'}<small>rendered by the generator in the timeline</small></div>
                : motion && r?.preview ? <Motion src={r.preview} offset={t - s.start} />
                : src ? <img src={src} />
                : <div className="sb-gen empty">no pick<small>{s.query}</small></div>}
            </div>
          );
        })}
        {cur ? (
          <div className="sb-caption" onClick={() => store.set({ sel: { shotId: cur.id }, sideTab: 'shot' })}>
            <div className="sb-meta">{cur.section ?? ''} · {sorted.indexOf(cur) + 1}/{sorted.length} · {cur.transition}{cur.fade ? ` ${cur.fade}s` : ''}</div>
            <div>{cur.description}</div>
            {cur.lyric ? <div className="sb-lyric">♪ {cur.lyric}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
