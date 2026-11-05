// Full-screen footage search: big tiles, up to 200 results per request, pick straight onto the selected shot.
import React, { useEffect, useRef, useState } from 'react';
import { pickOf, refKey } from '../core/storyboard';
import type { Shot, StockRef } from '../core/types';
import { PeekOverlay } from './Peek';
import { RefThumb, StockSelect, StockUsage, editShot, hoverOff, usePersist, useStockProvider } from './StoryPanel';
import { downloadPicks, searchAny, task } from './storyActions';
import { fmtTime, store, useStore } from './store';

const NO_SHOTS: Shot[] = [];
const PER_PAGE = [30, 60, 100, 200];

let returnMode: 'edit' | 'story' = 'story';
export function openFind() {
  const m = store.state.mode;
  if (m === 'edit' || m === 'story') returnMode = m;
  hoverOff();
  store.set({ mode: 'find' });
}
export function closeFind() {
  hoverOff();
  store.set({ mode: returnMode });
}

// keep each shot's results when leaving and re-entering the screen
const memo = new Map<string, { q: string; results: StockRef[]; page: number; total: number }>();

export const FindScreen: React.FC = () => {
  const shotId = useStore((s) => s.sel.shotId);
  const shots = useStore((s) => s.project.storyboard?.shots ?? NO_SHOTS);
  const peek = useStore((s) => s.peek);
  const busy = useStore((s) => s.busy);
  const shot = shots.find((s) => s.id === shotId);
  const [provider, setProvider] = useStockProvider();
  const [kind, setKind] = usePersist<'video' | 'image'>('mv.find.kind', 'video');
  const [perPage, setPerPage] = usePersist<number>('mv.find.per', 60);
  const [tile, setTile] = usePersist<number>('mv.find.tile', 260);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<StockRef[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hideAdded, setHideAdded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // load this shot's remembered search (or start from its query)
  useEffect(() => {
    const m = shotId ? memo.get(shotId) : undefined;
    setQ(m?.q ?? shot?.query ?? '');
    setResults(m?.results ?? []);
    setPage(m?.page ?? 1);
    setTotal(m?.total ?? 0);
    if (!m && shot?.query) inputRef.current?.select();
  }, [shotId]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !store.state.peek && (e.target as HTMLElement).tagName !== 'INPUT') closeFind();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const running = !!busy && !busy.startsWith('⚠');
  const i = shot ? shots.indexOf(shot) : -1;
  const go = (d: number) => { const n = shots[i + d]; if (n) { store.set({ sel: { shotId: n.id } }); store.seek(n.start); } };

  const doSearch = (pg = 1) => task('Searching stock', async () => {
    const query = (q || shot?.query || '').trim();
    if (!query) return;
    const r = await searchAny(provider, query, kind, pg, perPage);
    const have = pg === 1 ? [] : results;
    const seen = new Set(have.map(refKey));
    const merged = [...have, ...r.items.filter((x) => !seen.has(refKey(x)))];
    setResults(merged); setPage(pg); setTotal(r.total);
    if (shotId) memo.set(shotId, { q: query, results: merged, page: pg, total: r.total });
  });

  const addCand = (r: StockRef) => {
    if (!shot) return;
    editShot(shot.id, (s) => {
      let k = s.candidates.findIndex((c) => refKey(c) === refKey(r));
      if (k < 0) { s.candidates.push(r); k = s.candidates.length - 1; }
      s.pick = k;
      s.source = 'footage';
    });
  };
  const removeCand = (k: number) => editShot(shot!.id, (s) => {
    s.candidates.splice(k, 1);
    if (s.pick === k) s.pick = s.candidates.length ? 0 : undefined;
    else if (s.pick !== undefined && s.pick > k) s.pick--;
  });

  const candKeys = new Set(shot?.candidates.map(refKey));
  const shown = hideAdded ? results.filter((r) => !candKeys.has(refKey(r))) : results;
  const pick = shot ? pickOf(shot) : undefined;

  return (
    <div className="findscreen" style={{ '--tile': `${tile}px` } as React.CSSProperties}>
      <div className="find-head">
        <button onClick={closeFind} title="back (Esc)">← Back</button>
        {shot ? (
          <>
            <button onClick={() => go(-1)} disabled={i <= 0}>◀</button>
            <b>Shot {i + 1}/{shots.length}</b>
            <button onClick={() => go(1)} disabled={i >= shots.length - 1}>▶</button>
            <span className="dim">{fmtTime(shot.start)} → {fmtTime(shot.end)} · {(shot.end - shot.start).toFixed(1)}s{shot.section ? ` · ${shot.section}` : ''}</span>
            <span className="find-desc" title={shot.description}>{shot.description}</span>
          </>
        ) : <span className="dim">No shot selected — you can still search, but picks need a shot (select one in the timeline).</span>}
      </div>

      {shot ? (
        <div className="find-cands">
          <span className="dim">Candidates{pick ? ` · pick: ${pick.provider} ${pick.id}` : ''}</span>
          {shot.candidates.map((c, k) => (
            <div className="find-cand" key={refKey(c)}>
              <RefThumb r={c} on={shot.pick === k} onClick={() => editShot(shot.id, (s) => { s.pick = k; })}>
                <div className="ref-acts" onClick={(e) => e.stopPropagation()}>
                  <button title="remove" onClick={() => removeCand(k)}>✕</button>
                </div>
              </RefThumb>
            </div>
          ))}
          {!shot.candidates.length ? <span className="hint">none yet — click a result below</span> : null}
          <span className="grow" />
          {pick && !pick.media ? <button disabled={running} onClick={() => downloadPicks([pick])}>⬇ Download pick</button> : null}
        </div>
      ) : null}

      <div className="find-bar">
        <StockSelect value={provider} onChange={setProvider} />
        <StockUsage provider={provider} />
        <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="video">video</option>
          <option value="image">photo</option>
        </select>
        <input ref={inputRef} className="grow" autoFocus value={q} placeholder="search query…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch(1)} />
        <button className="accent" onClick={() => doSearch(1)} disabled={running}>🔍 Search</button>
        <label className="chk" title="results requested per search (Pixabay allows 200, Pexels 80)">per page
          <select value={perPage} onChange={(e) => setPerPage(Number(e.target.value))}>{PER_PAGE.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </label>
        <label className="chk" title="tile size">size
          <input type="range" min={140} max={520} step={10} value={tile} onChange={(e) => setTile(Number(e.target.value))} />
        </label>
        <label className="chk" title="hide clips already in this shot's candidates"><input type="checkbox" checked={hideAdded} onChange={(e) => setHideAdded(e.target.checked)} /> hide added</label>
      </div>

      <div className="find-grid" onScroll={hoverOff}>
        {shown.map((r) => (
          <RefThumb key={refKey(r)} r={r} on={candKeys.has(refKey(r))} onClick={() => addCand(r)}>
            {r.tags?.length ? <em className="find-tags">{r.tags.slice(0, 4).join(' · ')}</em> : null}
          </RefThumb>
        ))}
        {!results.length ? <div className="hint pad">{running ? 'Searching…' : 'Search results appear here. Click a tile to add it as a candidate and pick it; hover to play; right-click to send it to the idea board.'}</div> : null}
        {results.length ? (
          <div className="find-more">
            <span className="dim">{results.length} loaded{total ? ` of ${total}` : ''}</span>
            <button disabled={running || (total > 0 && results.length >= total)} onClick={() => doSearch(page + 1)}>more…</button>
          </div>
        ) : null}
      </div>
      {peek ? <PeekOverlay r={peek} /> : null}
    </div>
  );
};
