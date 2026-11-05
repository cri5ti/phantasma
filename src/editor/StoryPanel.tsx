import React, { useEffect, useState } from 'react';
import { pickOf, refKey, refMediaId } from '../core/storyboard';
import type { Shot, ShotTransition, StockProvider, StockRef } from '../core/types';

// stable fallback: a fresh [] per selector call makes useSyncExternalStore loop forever
const NO_SHOTS: Shot[] = [];
import { GENERATORS } from '../gen/registry';
import { AiLogTab, fetchRuns } from './AiLogTab';
import { Board } from './Board';
import { LyricsSync } from './LyricsSync';
import { VResize } from './Resizer';
import {
  buildTimeline, card, commitToLayers, downloadPicks, scanFootage, undownloadedCandidates, fillThumbnails, generateStoryboard, searchAny, status, STOCK_ORDER, suggestIdeas, task,
  type LLMChoice, type ServiceStatus,
} from './storyActions';
import { fmtTime, store, useStore } from './store';
import { openFind } from './FindScreen';

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export function usePersist<T>(k: string, d: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => ls.get(k, d));
  return [v, (x: T) => { setV(x); ls.set(k, x); }];
}

export function useServices() {
  const [st, setSt] = useState<ServiceStatus | null>(null);
  useEffect(() => { status().then(setSt).catch(() => {}); }, []);
  return st;
}

export const useLLM = () => usePersist<LLMChoice>('mv.llm', { provider: 'claude' });
/** Chosen stock provider, coerced to one that has a key once the server status is known. */
export function useStockProvider(): [StockProvider, (v: StockProvider) => void] {
  const [v, set] = usePersist<StockProvider>('mv.stock', 'pixabay');
  const svc = useServices();
  const ok = svc ? STOCK_ORDER.filter((p) => svc.stock[p]?.available) : null;
  return [ok && ok.length && !ok.includes(v) ? ok[0] : v, set];
}

/** API budget of a provider, polled while visible: "pixabay 12/85 per 60s". */
export const StockUsage: React.FC<{ provider: StockProvider }> = ({ provider }) => {
  const [u, setU] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    const poll = () => fetch('/api/stock/usage').then((r) => r.json()).then((j) => alive && setU(j[provider]?.usage ?? null)).catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [provider]);
  if (!u) return null;
  const w = u.windows[0];
  const low = w.used >= w.budget * 0.8 || u.blockedFor || (u.providerRemaining !== undefined && u.providerRemaining < 50);
  const mins = (ms?: number) => (ms ? (ms < 90_000 ? `${Math.ceil(ms / 1000)}s` : `${Math.ceil(ms / 60_000)}min`) : '');
  return (
    <span className={low ? 'warn' : 'dim'} title={`API calls this ${w.per}: ${w.used} of our ${w.budget} budget (provider limit ${w.limit}).${u.providerRemaining !== undefined ? ` Provider counter: ${u.providerRemaining}${u.providerLimit ? `/${u.providerLimit}` : ''} left${u.resetsIn ? `, resets in ${mins(u.resetsIn)}` : ''}.` : ''} Searches are cached 24 h; thumbnails/previews don't count.`}>
      {u.blockedFor ? `paused ${mins(u.blockedFor)}` : `${w.used}/${w.budget} per ${w.per}`}{u.providerRemaining !== undefined && provider === 'pexels' ? ` · ${u.providerRemaining} left this month` : ''}
    </span>
  );
};

/** Provider dropdown: providers without a key are listed but disabled, with the reason as tooltip. */
export const StockSelect: React.FC<{ value: StockProvider; onChange: (p: StockProvider) => void }> = ({ value, onChange }) => {
  const svc = useServices();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as StockProvider)}>
      {STOCK_ORDER.map((p) => {
        const a = svc?.stock[p];
        return <option key={p} value={p} disabled={!!a && !a.available} title={a?.why}>{p}{a && !a.available ? ' (no key)' : ''}</option>;
      })}
    </select>
  );
};

const enc = (p: string) => '/' + p.split('/').map(encodeURIComponent).join('/');

/** Thumbnail to show for a ref: the local one once downloaded, else the provider CDN. */
export function refThumb(r: StockRef | undefined): string | undefined {
  if (!r) return undefined;
  const m = store.state.media.find((x) => x.id === (r.media ?? refMediaId(r)));
  return m?.thumb ? enc(m.thumb) : r.thumb;
}

const TAB_NAMES = { brief: 'Brief & AI', shot: 'Shot', board: 'Idea board', ai: 'AI log' } as const;

/** Busy/error strip; while an AI run is in flight it shows the run's latest event live. */
const BusyBar: React.FC<{ busy: string }> = ({ busy }) => {
  const err = busy.startsWith('⚠');
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (err) return;
    let alive = true;
    const poll = () => fetchRuns().then((rs) => { const r = rs.find((x) => x.status === 'running'); if (alive) setLast(r?.lastEvent ?? null); }).catch(() => {});
    poll();
    const id = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(id); };
  }, [err, busy]);
  return (
    <div className={`busybar ${err ? 'err' : ''}`}>
      <span className="grow busytext" onClick={() => err && store.set({ busy: null })} title={err ? 'click to dismiss' : undefined}>
        {err ? busy : <><span className="spin" /> {busy}…{last ? <span className="dim"> {last}</span> : null}</>}
      </span>
      <button onClick={() => store.set({ sideTab: 'ai' })} title="open the AI log">log ›</button>
    </div>
  );
};

export const StoryPanel: React.FC = () => {
  const tab = useStore((s) => s.sideTab);
  const busy = useStore((s) => s.busy);
  return (
    <div className="story-panel">
      <div className="tabs">
        {(['brief', 'shot', 'board', 'ai'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => store.set({ sideTab: t })}>{TAB_NAMES[t]}</button>
        ))}
      </div>
      {busy ? <BusyBar busy={busy} /> : null}
      <div className="tab-body">
        {tab === 'brief' ? <BriefTab /> : tab === 'shot' ? <ShotTab /> : tab === 'board' ? <Board /> : <AiLogTab />}
      </div>
    </div>
  );
};

// ---- Brief & AI ----------------------------------------------------------------------------

const BriefTab: React.FC = () => {
  const storyboard = useStore((s) => s.project.storyboard);
  const media = useStore((s) => s.media);
  const busy = useStore((s) => s.busy);
  const inP = useStore((s) => s.inPoint);
  const outP = useStore((s) => s.outPoint);
  const svc = useServices();
  const [llm, setLLM] = useLLM();
  const [stock, setStock] = useStockProvider();
  const [instr, setInstr] = useState('');
  const brief = storyboard?.brief ?? { prompt: '', lyrics: '', style: '' };
  const shots = storyboard?.shots ?? [];
  const running = !!busy && !busy.startsWith('⚠');
  const setBrief = (k: keyof typeof brief) => (e: React.ChangeEvent<HTMLTextAreaElement>) => store.editSB((d) => { d.brief[k] = e.target.value; }, `brief.${k}`);

  const ids = new Set(media.map((m) => m.id));
  const footage = shots.filter((s) => s.source === 'footage');
  const picked = footage.filter((s) => pickOf(s));
  const local = picked.filter((s) => ids.has(pickOf(s)!.media ?? refMediaId(pickOf(s)!)));
  const candCount = useStore((s) => s.project.storyboard ? undownloadedCandidates().length : 0);
  const llmInfo = svc?.llm[llm.provider];
  const range = inP !== null && outP !== null && outP > inP ? { start: inP, end: outP } : null;

  const plan = () => {
    if (shots.length && !confirm(`Replace all ${shots.length} shots? (undo with Ctrl+Z)`)) return;
    generateStoryboard(llm, null, instr);
  };

  return (
    <div className="brief">
      <div className="row">
        <label>AI</label>
        <select value={llm.provider} onChange={(e) => setLLM({ provider: e.target.value as any })}>
          <option value="claude">Claude</option>
          <option value="openai">OpenAI</option>
        </select>
        <input placeholder={llmInfo?.model ?? 'model'} value={llm.model ?? ''} onChange={(e) => setLLM({ ...llm, model: e.target.value || undefined })} title="model override" />
        {llmInfo && !llmInfo.available ? <span className="warn" title={llmInfo.why}>no key</span> : null}
      </div>

      <label className="lbl">Director prompt</label>
      <VResize id="brief.prompt" def={84} min={40}><textarea value={brief.prompt} onChange={setBrief('prompt')} placeholder="What's the video about? Story, characters, places, the feeling it should leave…" /></VResize>
      <label className="lbl">Look &amp; style</label>
      <VResize id="brief.style" def={48} min={32}><textarea value={brief.style} onChange={setBrief('style')} placeholder="golden hour, 16mm grain, teal/orange, slow motion, handheld…" /></VResize>
      <label className="lbl">Lyrics <span className="dim">— plain, or LRC [mm:ss.xx] for exact timing</span></label>
      <VResize id="brief.lyrics" def={160} min={48}><textarea value={brief.lyrics} onChange={setBrief('lyrics')} placeholder="[00:30.30] first line…" className="mono" /></VResize>
      <LyricsSync />

      <label className="lbl">Instruction for this run <span className="dim">(optional)</span></label>
      <input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="e.g. more ocean in the choruses, fewer people" />

      <div className="btns">
        <button disabled={running} onClick={() => suggestIdeas(llm, instr).then(() => store.set({ sideTab: 'board' }))} title="adds AI idea cards to the board">✦ Suggest ideas</button>
        <button disabled={running} className="accent" onClick={plan}>▦ Plan storyboard</button>
        <button disabled={running || !range} onClick={() => range && generateStoryboard(llm, range, instr)} title="set In/Out (I / O keys) to re-plan just that part">↻ Re-plan In→Out</button>
      </div>

      <div className="sb-sum">
        <div><b>{shots.length}</b> shots · <b>{footage.length - picked.length}</b> without pick · <b>{picked.length - local.length}</b> to download · <b>{local.length}</b> local</div>
      </div>

      <div className="row">
        <label>Stock</label>
        <StockSelect value={stock} onChange={setStock} />
        {svc && !STOCK_ORDER.some((p) => svc.stock[p].available)
          ? <span className="warn" title="add a key to mvgen/.env and restart the editor">no stock API key set (PIXABAY_API_KEY / PEXELS_API_KEY)</span>
          : <StockUsage provider={stock} />}
      </div>
      <div className="btns">
        <button disabled={running || !footage.length} onClick={() => fillThumbnails(stock)} title="search each shot's query, keep the hits as candidates">⬚ Fetch thumbnails</button>
        <button disabled={running} onClick={() => scanFootage()} title="pick up clips you dropped into the project folder (e.g. stock/): probes them and builds thumbnails + proxies">↻ Scan footage folder</button>
        <button disabled={running || !picked.length} onClick={() => downloadPicks()} title="download picked clips into stock/, then build proxies">⬇ Download picks</button>
        <button disabled={running || !shots.length} className="accent" onClick={() => {
          const r = buildTimeline();
          if (r.missing.length) store.set({ busy: `⚠ Built ${r.built} layers — ${r.missing.length} shot(s) skipped (no downloaded pick)` });
        }} title="replace storyboard layers in the timeline; your other layers are kept">Build timeline →</button>
      </div>
      <div className="btns">
        <button disabled={running || !candCount} onClick={() => {
          if (candCount > 20 && !confirm(`Download ${candCount} candidate clip(s) for ${footage.length} shot(s)? This can be large and uses API calls (undo does not remove files).`)) return;
          downloadPicks(undownloadedCandidates());
        }} title="download every candidate of every footage shot, not just the picks">⬇ Download all candidates{candCount ? ` (${candCount})` : ''}</button>
        <button disabled={running || !shots.length} onClick={async () => {
          const r = await commitToLayers();
          if (!r.committed) store.set({ busy: '⚠ Not committed - some clips failed to download, layers stay linked to the storyboard' });
          else if (r.missing.length) store.set({ busy: `⚠ Committed ${r.built} layers - ${r.missing.length} shot(s) skipped (no downloaded pick)` });
        }} title="build the timeline from the picks, download streamed clips, and turn the layers into normal layers detached from the storyboard">⇥ Commit to layers</button>
      </div>

      {storyboard?.log.length ? (
        <details className="sb-log">
          <summary>AI runs ({storyboard.log.length})</summary>
          {[...storyboard.log].reverse().map((l, i) => (
            <div key={i} className="dim">{l.at.slice(0, 16).replace('T', ' ')} · {l.kind} · {l.model}{l.prompt ? ` — ${l.prompt}` : ''}</div>
          ))}
        </details>
      ) : null}
      <div className="hint">Keys live in <code>mvgen/.env</code> or the song folder's <code>.env</code>: ANTHROPIC_API_KEY, OPENAI_API_KEY, PEXELS_API_KEY, PIXABAY_API_KEY.</div>
    </div>
  );
};

// ---- Shot -----------------------------------------------------------------------------------

export function editShot(id: string, fn: (s: Shot) => void, merge?: string) {
  store.editSB((d) => {
    const s = d.shots.find((x) => x.id === id);
    if (s) fn(s as Shot);
  }, merge);
}

// enlarged hover preview: appears after a short dwell so sweeping across the grid doesn't load every clip
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
function hoverOn(ref: StockRef, el: HTMLElement) {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    const b = el.getBoundingClientRect();
    store.set({ hoverRef: { ref, x: b.left, y: b.top, w: b.width, h: b.height } });
  }, 350);
}
export function hoverOff() {
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = null;
  if (store.state.hoverRef) store.set({ hoverRef: null });
}

export const RefThumb: React.FC<{ r: StockRef; on?: boolean; onClick?: () => void; children?: React.ReactNode; draggable?: boolean }> = ({ r, on, onClick, children, draggable = true }) => {
  const local = useStore((s) => s.media.some((m) => m.id === (r.media ?? refMediaId(r))));
  return (
    <div
      className={`thumb ref ${on ? 'on' : ''}`}
      onClick={onClick}
      onMouseEnter={(e) => hoverOn(r, e.currentTarget)}
      onMouseLeave={hoverOff}
      onMouseDown={hoverOff}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); hoverOff(); store.set({ footMenu: { x: e.clientX, y: e.clientY, ref: r } }); }}
      title={`${r.provider} ${r.id}${r.author ? ` · ${r.author}` : ''} · ${r.width}×${r.height}${r.duration ? ` · ${r.duration}s` : ''}`}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('application/x-mv-ref', JSON.stringify(r))}
    >
      <img src={refThumb(r)} loading="lazy" />
      <span>{r.kind === 'video' ? `${r.duration ?? '?'}s` : 'img'}{local ? ' · ✓ local' : ''}</span>
      <button className="peek-btn" title="preview big in the player (Esc closes)" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); hoverOff(); store.set({ peek: r }); }}>⤢</button>
      {children}
    </div>
  );
};

const ShotTab: React.FC = () => {
  const shotId = useStore((s) => s.sel.shotId);
  const shots = useStore((s) => s.project.storyboard?.shots ?? NO_SHOTS);
  const shot = shots.find((s) => s.id === shotId);
  const busy = useStore((s) => s.busy);
  const [llm] = useLLM();
  const [provider, setProvider] = useStockProvider();
  const svc = useServices();
  const [kind, setKind] = useState<'video' | 'image'>('video');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<StockRef[]>([]);
  const [instr, setInstr] = useState('');
  useEffect(() => { setQ(shot?.query ?? ''); setResults([]); setPage(1); }, [shotId]);

  if (!shot) return <div className="hint pad">Click a shot in the storyboard lane of the timeline, or plan a storyboard from the Brief tab.</div>;
  const i = shots.indexOf(shot);
  const running = !!busy && !busy.startsWith('⚠');
  const go = (d: number) => { const n = shots[i + d]; if (n) { store.set({ sel: { shotId: n.id } }); store.seek(n.start); } };
  const set = <K extends keyof Shot>(k: K) => (v: Shot[K]) => editShot(shot.id, (s) => { s[k] = v; }, `${shot.id}.${String(k)}`);
  const doSearch = (pg = 1) => task('Searching stock', async () => {
    const r = await searchAny(provider, q || shot.query, kind, pg, 15);
    setResults(pg === 1 ? r.items : [...results, ...r.items]);
    setPage(pg);
  });
  const addCand = (r: StockRef) => editShot(shot.id, (s) => {
    let k = s.candidates.findIndex((c) => refKey(c) === refKey(r));
    if (k < 0) { s.candidates.push(r); k = s.candidates.length - 1; }
    s.pick = k;
  });
  const pick = pickOf(shot);

  return (
    <div className="shot">
      <div className="row">
        <button onClick={() => go(-1)} disabled={i <= 0}>◀</button>
        <b>Shot {i + 1}/{shots.length}</b>
        <span className="dim">{fmtTime(shot.start)} → {fmtTime(shot.end)} · {(shot.end - shot.start).toFixed(2)}s{shot.section ? ` · ${shot.section}` : ''}</span>
        <span className="grow" />
        <button onClick={() => go(1)} disabled={i >= shots.length - 1}>▶</button>
      </div>
      <label className="lbl">Description</label>
      <VResize id="shot.description" def={52} min={32}><textarea value={shot.description} onChange={(e) => set('description')(e.target.value)} /></VResize>
      <div className="grid2">
        <label>Search query</label><input value={shot.query} onChange={(e) => set('query')(e.target.value)} />
        <label>Lyric</label><input value={shot.lyric ?? ''} onChange={(e) => set('lyric')(e.target.value || undefined)} />
        <label>Mood</label><input value={shot.mood ?? ''} onChange={(e) => set('mood')(e.target.value || undefined)} />
        <label>Tags</label><input value={shot.tags.join(', ')} onChange={(e) => set('tags')(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />
        <label>Source</label>
        <div className="row tight">
          <select value={shot.source} onChange={(e) => set('source')(e.target.value as any)}>
            <option value="footage">stock footage</option>
            <option value="gen">generator</option>
          </select>
          {shot.source === 'gen' ? (
            <select value={shot.gen ?? ''} onChange={(e) => set('gen')(e.target.value)}>
              <option value="">—</option>
              {GENERATORS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          ) : null}
        </div>
        <label>Transition in</label>
        <div className="row tight">
          <select value={shot.transition} onChange={(e) => editShot(shot.id, (s) => { s.transition = e.target.value as ShotTransition; if (s.transition === 'cut') s.fade = 0; else if (!s.fade) s.fade = 1; })}>
            <option value="cut">cut</option>
            <option value="crossfade">crossfade</option>
            <option value="dip">dip to black</option>
          </select>
          {shot.transition !== 'cut' ? <><input type="number" step={0.1} min={0} value={shot.fade} onChange={(e) => set('fade')(Math.max(0, Number(e.target.value)))} style={{ width: 60 }} /><span className="dim">s</span></> : null}
        </div>
        <label>Notes</label><input value={shot.notes ?? ''} onChange={(e) => set('notes')(e.target.value || undefined)} />
      </div>

      <div className="row">
        <input className="grow" value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="AI: re-think this shot… (optional instruction)" />
        <button disabled={running} onClick={() => generateStoryboard(llm, { start: shot.start, end: shot.end }, instr)}>↻ AI</button>
      </div>

      <div className="isec-h static">Candidates {pick ? <span className="dim">· pick: {pick.provider} {pick.id}</span> : null}</div>
      <VResize id="shot.candidates" def={220} min={60} scroll><div className="cand-grid">
        {shot.candidates.map((c, k) => (
          <RefThumb key={refKey(c)} r={c} on={shot.pick === k} onClick={() => editShot(shot.id, (s) => { s.pick = k; })}>
            <div className="ref-acts" onClick={(e) => e.stopPropagation()}>
              <button title="pin to idea board" onClick={() => store.editSB((d) => { d.board.push(card('stock', shot.query, [...shot.tags], undefined, d.board, 0, { stock: c })); })}>📌</button>
              <button title="remove" onClick={() => editShot(shot.id, (s) => {
                s.candidates.splice(k, 1);
                if (s.pick === k) s.pick = s.candidates.length ? 0 : undefined;
                else if (s.pick !== undefined && s.pick > k) s.pick--;
              })}>✕</button>
            </div>
          </RefThumb>
        ))}
        {!shot.candidates.length ? <div className="hint">No candidates yet — search below or drop a stock card from the board on the shot.</div> : null}
      </div></VResize>
      {pick && !pick.media ? <button disabled={running} onClick={() => downloadPicks([pick])}>⬇ Download pick</button> : null}

      <div className="isec-h static">Search <button onClick={() => openFind()} title="big tiles, up to 200 results at a time (F)">⤢ Full screen</button></div>
      <div className="row">
        <StockSelect value={provider} onChange={setProvider} />
        <StockUsage provider={provider} />
        <select value={kind} onChange={(e) => setKind(e.target.value as any)}>
          <option value="video">video</option>
          <option value="image">photo</option>
        </select>
        <input className="grow" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch(1)} />
        <button onClick={() => doSearch(1)}>🔍</button>
      </div>
      <VResize id="shot.results" def={280} min={60} scroll><div className="cand-grid">
        {results.map((r) => <RefThumb key={refKey(r)} r={r} on={shot.candidates.some((c) => refKey(c) === refKey(r))} onClick={() => addCand(r)} />)}
        {!results.length ? <div className="hint">Search results appear here.</div> : null}
      </div></VResize>
      {results.length ? <button onClick={() => doSearch(page + 1)}>more…</button> : null}
    </div>
  );
};
