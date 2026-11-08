// AI chat beside the lyrics: Claude reads the sheet through tools and answers with proposals you accept / reject.
import React, { useEffect, useRef, useState } from 'react';
import { barOf, sorted } from '../../core/sheet';
import { useLLM } from '../StoryPanel';
import { applyAlternative, applyProposal, snapshot, type Proposal } from './actions';
import { lx, sheet, toast, useLx, useSheet } from './state';
import { store } from '../store';

type Provider = 'claude' | 'openai';
interface PState { p: Proposal; status: 'pending' | 'accepted' | 'rejected' | 'partial' | 'superseded'; pick?: boolean[]; option?: number }
type DMsg =
  | { role: 'user'; text: string; ctx?: string }
  | { role: 'assistant'; text: string; thinking: string; tools: { name: string; ok: boolean; summary?: string }[]; proposals: PState[]; error?: string; pending?: boolean; runId?: string };

let msgs: DMsg[] = [];
const subs = new Set<() => void>();
const setMsgs = (m: DMsg[]) => { msgs = m; subs.forEach((f) => f()); saveDisplay(); };
const useMsgs = () => { const [, f] = useState(0); useEffect(() => { const g = () => f((x) => x + 1); subs.add(g); return () => void subs.delete(g); }, []); return msgs; };
let saveT: any;
const saveDisplay = () => { clearTimeout(saveT); saveT = setTimeout(() => fetch('/api/sheet/chat/display', { method: 'PUT', body: JSON.stringify({ display: msgs.filter((m) => !(m.role === 'assistant' && m.pending)) }) }).catch(() => {}), 600); };
let loaded = false;
async function loadThread() {
  if (loaded) return;
  loaded = true;
  try { const r = await (await fetch('/api/sheet/chat')).json(); msgs = r.display ?? []; subs.forEach((f) => f()); } catch { /* ignore */ }
}

/** outcomes of proposals since the last message, told to the model on the next turn */
let review: string[] = [];
/** the first accept after a turn snapshots the sheet into the library */
let snapPending: string | null = null;

async function beforeApply() {
  if (snapPending) { const n = snapPending; snapPending = null; await snapshot(`before AI: ${n}`); }
}

function updateProposal(id: string, fn: (p: PState) => PState) {
  setMsgs(msgs.map((m) => (m.role === 'assistant' && m.proposals.some((x) => x.p.id === id) ? { ...m, proposals: m.proposals.map((x) => (x.p.id === id ? fn(x) : x)) } : m)));
}

async function accept(ps: PState, option?: number) {
  await beforeApply();
  const p = ps.p;
  if (p.tool === 'propose_lines') {
    const pick = ps.pick ?? p.input.edits.map(() => true);
    const idx = pick.map((v: boolean, i: number) => (v ? i : -1)).filter((i: number) => i >= 0);
    if (!idx.length) return;
    applyProposal(p, { edits: idx });
    const partial = idx.length < p.input.edits.length;
    review.push(`${p.id} ${partial ? `partly accepted (${idx.length}/${p.input.edits.length} edits)` : 'accepted'}`);
    updateProposal(p.id, (x) => ({ ...x, status: partial ? 'partial' : 'accepted' }));
  } else if (p.tool === 'propose_alternatives') {
    const o = option ?? 0;
    applyProposal(p, { option: o, merge: `alt-${p.id}` });
    review.push(`${p.id}: option ${o + 1} used`);
    updateProposal(p.id, (x) => ({ ...x, status: 'accepted', option: o }));
  } else {
    applyProposal(p);
    review.push(`${p.id} accepted`);
    updateProposal(p.id, (x) => ({ ...x, status: 'accepted' }));
  }
}

function reject(ps: PState) {
  // an applied alternative is put back to the original lines
  if (ps.p.tool === 'propose_alternatives' && ps.status === 'accepted' && ps.p.before) {
    applyAlternative(ps.p.input.line_ids, ps.p.input.line_ids.map((id: string) => ps.p.before[id]).join('\n'));
  }
  review.push(`${ps.p.id} rejected`);
  updateProposal(ps.p.id, (x) => ({ ...x, status: 'rejected' }));
}

/** Alt+[ / Alt+]: cycle the newest alternatives proposal */
export function cycleAlternative(dir: -1 | 1) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const ps = [...m.proposals].reverse().find((x) => x.p.tool === 'propose_alternatives' && x.status !== 'rejected' && x.status !== 'superseded');
    if (!ps) continue;
    const n = ps.p.input.options.length;
    const o = ps.option === undefined ? (dir > 0 ? 0 : n - 1) : (ps.option + dir + n) % n;
    void accept(ps, o);
    toast(`alternative ${o + 1} / ${n}`);
    return;
  }
  toast('no alternatives to cycle — ask the AI for options');
}

export async function newThread() {
  await fetch('/api/sheet/chat', { method: 'DELETE' });
  review = [];
  setMsgs([]);
}

let running = false;
export async function send(text: string, provider: 'claude' | 'openai' = 'claude') {
  if (!text.trim() || running) return;
  running = true;
  const st = lx.get();
  const s = sheet();
  const focusBlock = st.editing?.block ?? st.focus?.block ?? st.selBlock ?? blockAtCenter();
  const fb = s.blocks.find((b) => b.id === focusBlock);
  const ctx = [fb ? `${fb.name} (bars ${barOf(s, fb.at)}–${barOf(s, fb.at + fb.len)})` : '', st.wsel ? `“${st.wsel.text}”` : ''].filter(Boolean).join(' · ');
  const am: DMsg = { role: 'assistant', text: '', thinking: '', tools: [], proposals: [], pending: true };
  setMsgs([...msgs, { role: 'user', text, ctx }, am]);
  const patch = (fn: (m: Extract<DMsg, { role: 'assistant' }>) => void) => {
    const last = { ...(msgs[msgs.length - 1] as Extract<DMsg, { role: 'assistant' }>) };
    fn(last);
    msgs = [...msgs.slice(0, -1), last];
    subs.forEach((f) => f());
  };
  const sung = store.state.project.lyrics?.lines.filter((l) => l.sheet);
  const body = { message: text, sheet: s, focus: fb ? { block: fb.id } : null, selection: st.wsel ? { lines: st.wsel.lines, text: st.wsel.text } : null, review, provider, sung: sung?.length ? sung : undefined };
  review = [];
  try {
    const r = await fetch('/api/sheet/chat', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t === 'text') patch((m) => { m.text += ev.d; });
        else if (ev.t === 'thinking') patch((m) => { m.thinking += ev.d; });
        else if (ev.t === 'tool') patch((m) => { m.tools = [...m.tools, { name: ev.name, ok: ev.ok, summary: ev.summary }]; });
        else if (ev.t === 'proposal') patch((m) => {
          // a corrected proposal for the same lines replaces the earlier one of this turn
          const prev = m.proposals.map((x) => (x.p.id === ev.proposal.supersedes && x.status === 'pending' ? { ...x, status: 'superseded' as const } : x));
          m.proposals = [...prev, { p: ev.proposal, status: 'pending', pick: ev.proposal.tool === 'propose_lines' ? ev.proposal.input.edits.map(() => true) : undefined }];
        });
        else if (ev.t === 'error') patch((m) => { m.error = ev.msg; });
        else if (ev.t === 'done') patch((m) => { m.runId = ev.runId; });
      }
    }
    snapPending = text.slice(0, 48);
  } catch (e: any) {
    patch((m) => { m.error = String(e?.message ?? e); });
  } finally {
    patch((m) => { m.pending = false; });
    saveDisplay();
    running = false;
  }
}

function blockAtCenter() {
  const s = sheet();
  const c = lx.get().center;
  return sorted(s).find((b) => c >= b.at && c < b.at + b.len)?.id ?? null;
}

const QUICK = ['Tighten these lines', 'Give me 3 alternatives', 'Less literal, more imagery', 'Fix the meter to match verse 1', 'Suggest layers for this block', 'Draft a chorus hook'];

export const Chat: React.FC = () => {
  const list = useMsgs();
  const [text, setText] = useState('');
  const [llm, setLLM] = useLLM();
  const [svc, setSvc] = useState<Record<Provider, { available: boolean; model: string; why?: string }> | null>(null);
  // the saved choice (shared with the Storyboard), or whichever provider has a key
  const provider: Provider = svc && !svc[llm.provider]?.available && svc[llm.provider === 'claude' ? 'openai' : 'claude']?.available ? (llm.provider === 'claude' ? 'openai' : 'claude') : llm.provider;
  const status = svc ? { ok: svc[provider].available, model: svc[provider].model, why: svc[provider].why } : null;
  const wsel = useLx((x) => x.wsel);
  const focus = useLx((x) => x.focus?.block ?? x.selBlock);
  const s = useSheet();
  const endRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLTextAreaElement>(null);
  const busy = list.some((m) => m.role === 'assistant' && m.pending);

  useEffect(() => { void loadThread(); fetch('/api/story/status').then((r) => r.json()).then((j) => setSvc(j.llm)).catch(() => {}); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [list]);
  useEffect(() => {
    const f = () => inRef.current?.focus();
    window.addEventListener('mv-chat-focus', f);
    return () => window.removeEventListener('mv-chat-focus', f);
  }, []);

  const fb = s.blocks.find((b) => b.id === focus);
  const go = () => { const t = text; setText(''); void send(t, provider); };

  return (
    <div className="lx-chat">
      <div className="lx-chat-h">
        <b>AI</b>
        <select value={provider} onChange={(e) => setLLM({ ...llm, provider: e.target.value as Provider })} title="the AI reads the sheet through tools and answers with proposals — each provider keeps its own context, the thread display is shared">
          {(['claude', 'openai'] as Provider[]).map((p) => <option key={p} value={p} disabled={!!svc && !svc[p]?.available}>{p === 'claude' ? 'Claude' : 'OpenAI'}{svc ? ` · ${svc[p]?.available ? svc[p].model : 'no key'}` : ''}</option>)}
        </select>
        <span className="grow" />
        <button onClick={() => newThread()} disabled={busy} title="start a new conversation">New thread</button>
        <button onClick={() => lx.set({ chat: false })} title="hide the chat">✕</button>
      </div>
      {status && !status.ok ? <div className="hint pad err">No AI provider is configured: {status.why} — add it to mvgen/.env and restart the editor.</div> : null}
      <div className="lx-msgs">
        {!list.length ? <div className="hint pad">Ask for changes: “change these to something less literal”, “rewrite verse 2 to rhyme ABAB and keep the meter”, “where should the female voice come in?”. Select words first to point at them; the block under the cursor and its layers, tags and the style go along automatically.</div> : null}
        {list.map((m, i) => m.role === 'user' ? (
          <div key={i} className="msg user"><div className="txt">{m.text}</div>{m.ctx ? <div className="ctx">{m.ctx}</div> : null}</div>
        ) : (
          <div key={i} className="msg ai">
            {m.thinking && (m.pending || !m.text) ? <details className="think" open={m.pending && !m.text}><summary>{m.pending && !m.text ? 'thinking…' : 'thinking'}</summary><div>{m.thinking.slice(-1200)}</div></details> : null}
            {m.tools.length ? <div className="tools">{m.tools.map((t, k) => <span key={k} className={`tool ${t.ok ? '' : 'bad'}`} title={t.name}>{t.summary ?? t.name}</span>)}</div> : null}
            {m.proposals.map((ps) => <ProposalCard key={ps.p.id} ps={ps} />)}
            {m.text ? <div className="txt">{m.text}</div> : null}
            {m.pending && !m.text && !m.thinking ? <div className="dim">…</div> : null}
            {m.error ? <div className="err">⚠ {m.error}</div> : null}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="lx-chat-in">
        <div className="ctxs">
          {fb ? <span className="cchip" title="the block in focus goes along with its layers and tags">▌{fb.name}</span> : null}
          {wsel ? <span className="cchip sel" title="selected words">“{wsel.text.length > 40 ? wsel.text.slice(0, 40) + '…' : wsel.text}” <button onClick={() => lx.set({ wsel: null })}>✕</button></span> : null}
        </div>
        <div className="quick">{QUICK.map((q) => <button key={q} onClick={() => { setText(q); inRef.current?.focus(); }}>{q}</button>)}</div>
        <textarea ref={inRef} value={text} placeholder={busy ? 'working…' : 'Ask for a change  (Enter sends · Shift+Enter new line)'} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } if (e.key === 'Escape') (e.target as HTMLElement).blur(); }} />
        <button className="accent" disabled={busy || !text.trim() || (status !== null && !status.ok)} onClick={go}>Send</button>
      </div>
    </div>
  );
};

// ---- proposal cards -----------------------------------------------------------------------------

const lineText = (id: string) => { for (const b of sheet().blocks) { const l = b.lines.find((x) => x.id === id); if (l) return { text: l.text, block: b.name }; } return null; };

const ProposalCard: React.FC<{ ps: PState }> = ({ ps }) => {
  const { p, status } = ps;
  const x = p.input;
  const done = status !== 'pending';
  if (status === 'superseded') return <div className="prop superseded"><div className="ph"><span className="pid">{p.id}</span> replaced by a corrected proposal<span className="grow" /><span className="pst">superseded</span></div></div>;
  const head = (label: string) => (
    <div className="ph"><span className="pid">{p.id}</span> {label}{x.summary ? <span className="dim"> — {x.summary}</span> : null}<span className="grow" /><span className={`pst ${status}`}>{status}</span></div>
  );
  const actions = (onAccept: () => void, label = 'Accept') => done ? null : (
    <div className="pa"><button className="accent" onClick={onAccept}>{label}</button><button onClick={() => reject(ps)}>Reject</button></div>
  );
  if (p.tool === 'propose_lines') {
    const pick = ps.pick ?? x.edits.map(() => true);
    return (
      <div className={`prop ${status}`}>
        {head(`${x.edits.length} line edit${x.edits.length > 1 ? 's' : ''}`)}
        {x.edits.map((e: any, i: number) => {
          const before = p.before?.[e.line_id];
          return (
            <label key={i} className="pe">
              {!done ? <input type="checkbox" checked={pick[i]} onChange={() => updateProposal(p.id, (q) => ({ ...q, pick: pick.map((v: boolean, k: number) => (k === i ? !v : v)) }))} /> : null}
              <div>
                {e.op !== 'insert_after' && before !== undefined ? <div className="old">{before}</div> : null}
                {e.op === 'insert_after' ? <div className="dim">after: {before}</div> : null}
                {e.op !== 'delete' ? <div className="new">{e.text}</div> : <div className="dim">(delete line)</div>}
                <Badges list={p.checks?.[e.line_id]} />
              </div>
            </label>
          );
        })}
        {actions(() => void accept(ps), pick.every(Boolean) ? 'Accept' : 'Accept selected')}
      </div>
    );
  }
  if (p.tool === 'propose_alternatives') {
    const before = x.line_ids.map((id: string) => p.before?.[id] ?? lineText(id)?.text ?? '').join('\n');
    return (
      <div className={`prop ${status}`}>
        {head(`${x.options.length} alternatives`)}
        <div className="old pre">{before}</div>
        {x.options.map((o: string, i: number) => (
          <div key={i} className={`alt ${ps.option === i && status === 'accepted' ? 'on' : ''}`}>
            <div className="new pre">{o}<Badges list={p.checks?.[i]} /></div>
            {status !== 'rejected' ? <button onClick={() => void accept(ps, i)} title="use this one (Alt+[ / Alt+] cycles)">{ps.option === i && status === 'accepted' ? 'using' : 'Use'}</button> : null}
          </div>
        ))}
        {status !== 'rejected' ? <div className="pa"><span className="dim">Alt+[ / Alt+] cycles</span><span className="grow" /><button onClick={() => reject(ps)}>{status === 'accepted' ? 'Revert' : 'Reject'}</button></div> : null}
      </div>
    );
  }
  if (p.tool === 'propose_style') {
    return (
      <div className={`prop ${status}`}>
        {head('style')}
        {p.before ? <div className="old pre">{p.before}</div> : null}
        <div className="new pre">{x.style}</div>
        {actions(() => void accept(ps))}
      </div>
    );
  }
  const describe = (o: any): string => {
    const bn = (id: string) => sheet().blocks.find((b) => b.id === id)?.name ?? id;
    if (p.tool === 'propose_blocks') return ({
      add: `add ${o.name} (${o.bars} bars${o.after_block_id ? ` after ${bn(o.after_block_id)}` : ''})${o.lines?.length ? ` with ${o.lines.length} lines` : ''}`,
      remove: `remove ${bn(o.block_id)}`, resize: `${bn(o.block_id)} → ${o.bars} bars`, rename: `rename ${bn(o.block_id)} → ${o.name}`,
      move: `move ${bn(o.block_id)} ${o.after_block_id ? `after ${bn(o.after_block_id)}` : 'to the start'}`, gap: `${o.bars} bar pause before ${bn(o.block_id)}`,
    } as Record<string, string>)[o.op] ?? JSON.stringify(o);
    if (p.tool === 'propose_layers') return o.op === 'energy' ? `energy ${o.from} → ${o.to}, bars ${o.from_bar}–${o.to_bar}` : `${o.op === 'add' ? '+' : '−'} ${o.label} on ${o.track}, bars ${o.from_bar}–${o.to_bar}`;
    if (p.tool === 'propose_tags') return `${o.op === 'add' ? 'tag' : 'untag'} “${o.words}”${o.kind ? ` as ${o.kind}` : ''}${o.note ? ` (${o.note})` : ''}`;
    return JSON.stringify(o);
  };
  return (
    <div className={`prop ${status}`}>
      {head(p.tool.replace('propose_', '').replace('_', ' '))}
      <ul className="ops">{(x.ops ?? []).map((o: any, i: number) => <li key={i}>{describe(o)}</li>)}</ul>
      {actions(() => void accept(ps))}
    </div>
  );
};

/** shape checks the server ran on a proposal: "8 → 10 syl", "rhyme B ✗", "closed vowel on long note" */
const Badges: React.FC<{ list?: string[] }> = ({ list }) => (list?.length ? <div className="badges">{list.map((b) => <span key={b} className="badge" title="measured against the line it replaces (syllables, rhyme partner, held note, density)">{b}</span>)}</div> : null);

export const focusChat = () => { lx.set({ chat: true }); setTimeout(() => window.dispatchEvent(new Event('mv-chat-focus')), 30); };
