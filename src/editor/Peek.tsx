// Clip previews: an enlarged floating preview on hover, and a big view over the player (⤢ on any thumbnail).
// Both play the CDN preview files — no API calls involved.
import React from 'react';
import { refKey, refMediaId } from '../core/storyboard';
import type { Shot, StockRef } from '../core/types';
import { downloadPicks } from './storyActions';
import { refThumb } from './StoryPanel';
import { store, useStore } from './store';

const W = 440;

const Meta: React.FC<{ r: StockRef }> = ({ r }) => (
  <>
    <b>{r.provider} {r.id}</b>
    <span>{r.width}×{r.height}</span>
    {r.duration ? <span>{r.duration}s</span> : null}
    {r.author ? <span>by {r.author}</span> : null}
    {r.tags?.length ? <span className="dim">{r.tags.slice(0, 5).join(', ')}</span> : null}
  </>
);

export const HoverPeek: React.FC = () => {
  const h = useStore((s) => s.hoverRef);
  const peek = useStore((s) => s.peek);
  if (!h || peek) return null;
  const { ref: r } = h;
  const ar = r.width && r.height ? r.height / r.width : 9 / 16;
  const mh = Math.min(W * ar, window.innerHeight * 0.6);
  const mw = Math.min(W, mh / ar);
  // to the left of the thumbnail (thumbs live in the right pane), clamped on screen
  const left = Math.max(8, h.x - mw - 12);
  const top = Math.min(window.innerHeight - mh - 40, Math.max(8, h.y + h.h / 2 - mh / 2));
  const src = r.kind === 'video' ? r.preview ?? r.previewHd : undefined;
  return (
    <div className="hoverpeek" style={{ left, top, width: mw }}>
      <div className="media" style={{ height: mh }}>
        <img src={refThumb(r)} />
        {src ? <video key={src} src={src} autoPlay muted loop playsInline /> : null}
      </div>
      <div className="meta"><Meta r={r} /></div>
    </div>
  );
};

export const PeekOverlay: React.FC<{ r: StockRef }> = ({ r }) => {
  const shotId = useStore((s) => s.sel.shotId);
  const local = useStore((s) => s.media.find((m) => m.id === (r.media ?? refMediaId(r))));
  const src = local
    ? '/' + (local.proxy ?? local.src).split('/').map(encodeURIComponent).join('/')
    : r.kind === 'video' ? r.previewHd ?? r.preview : undefined;
  const use = () => {
    if (!shotId) return;
    store.editSB((d) => {
      const s = d.shots.find((x) => x.id === shotId) as Shot | undefined;
      if (!s) return;
      let k = s.candidates.findIndex((c) => refKey(c) === refKey(r));
      if (k < 0) { s.candidates.push(r); k = s.candidates.length - 1; }
      s.pick = k;
      s.source = 'footage';
    });
  };
  return (
    <div className="peek" onClick={(e) => e.target === e.currentTarget && store.set({ peek: null })}>
      <div className="media" onClick={(e) => e.target === e.currentTarget && store.set({ peek: null })}>
        {src ? <video key={src} src={src} autoPlay muted loop controls playsInline poster={refThumb(r)} /> : <img src={refThumb(r)} />}
      </div>
      <div className="meta">
        <Meta r={r} />
        {local ? <span>✓ local</span> : <span>streaming preview</span>}
        {r.page ? <a href={r.page} target="_blank" rel="noreferrer">source page ↗</a> : null}
        <span className="grow" />
        {shotId ? <button onClick={use}>Use for selected shot</button> : null}
        {!local && r.provider !== 'local' ? <button onClick={() => downloadPicks([r])}>⬇ Download</button> : null}
        <button onClick={() => store.set({ peek: null })}>✕ Close (Esc)</button>
      </div>
    </div>
  );
};
