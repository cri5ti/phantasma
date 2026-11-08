// /api/sheet/* — lyric sheet library (versions on disk), the lyrics AI chat (tool loop on Claude or OpenAI, streamed),
// the AI meaning analysis of blocks and the pronunciation dictionary.
//   <project>/lyrics/versions/<id>.json        saved versions of the sheet (+ their metrics profile)
//   <project>/lyrics/chat.json                 chat thread: per-provider API messages (append-only) + the display log
//   <project>/_phantasma/lyrics-analysis.json      AI meaning analysis per block, keyed by a hash of the block's text
//   <root>/data/cmudict.json                   CMUdict (scripts/cmudict.mjs), optional
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { defaultModel, jsonCompletion, llmStatus, type LLMProvider } from './ai';
import type { AiLog, AiRun } from './aiLog';
import { barOf, blockText, layersText, lyricsText, sheetDuration, sorted, structureText } from '../src/core/sheet';
import { setDict } from '../src/core/phonetics';
import {
  analyzeSheet, blockHash, blockReport, checkEdits, checkLine, findingsText, hookText, profileSummary,
  type BlockSemantic, type ProfileSummary, type SheetAnalysis,
} from '../src/core/lyricMetrics';
import type { LyricLine, LyricSheet } from '../src/core/types';

type Send = (res: any, code: number, body: unknown) => void;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
/** Claude history lives here (append-only); OpenAI keeps its own server-side, chained by response id */
interface Thread { api: BetaMessageParam[]; oaiLast?: string; display: unknown[] }

export interface VersionFile { id: string; name: string; at: string; source: string; note?: string; sheet: LyricSheet; profile?: ProfileSummary }

/** what the editor sends with each chat message */
interface ChatIn {
  message: string;
  sheet: LyricSheet;
  focus?: { block?: string } | null;
  selection?: { lines: { block: string; line: string; from: number; to: number; text: string }[]; text: string } | null;
  /** outcome of earlier proposals since the last turn, e.g. "p3 accepted", "p4 rejected" */
  review?: string[];
  provider?: LLMProvider;
  model?: string;
  /** aligned song lines (with sheet back-refs) for the plan-vs-sung metrics */
  sung?: LyricLine[];
}

export function sheetApi(root: string, project: string, ai: AiLog) {
  const dictFile = path.join(root, 'data', 'cmudict.json');
  try { if (fs.existsSync(dictFile)) setDict(JSON.parse(fs.readFileSync(dictFile, 'utf8'))); } catch (e) { console.warn('cmudict: could not load', e); }
  const semFile = path.join(project, '_phantasma', 'lyrics-analysis.json');
  let semCache: Record<string, BlockSemantic> | null = null;
  const sem = () => (semCache ??= (() => { try { return JSON.parse(fs.readFileSync(semFile, 'utf8')); } catch { return {}; } })());
  const saveSem = () => { fs.mkdirSync(path.dirname(semFile), { recursive: true }); fs.writeFileSync(semFile, JSON.stringify(sem())); };
  const analyze = (s: LyricSheet, sung?: LyricLine[]) => analyzeSheet(s, { sem: sem(), sung });
  const dir = path.join(project, 'lyrics');
  const vdir = path.join(dir, 'versions');
  const chatFile = path.join(dir, 'chat.json');
  const okId = (id: string) => /^[\w-]{1,80}$/.test(id);
  const readChat = (): Thread => {
    try { return JSON.parse(fs.readFileSync(chatFile, 'utf8')); } catch { return { api: [], display: [] }; }
  };
  const writeChat = (c: Thread) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(chatFile + '.tmp', JSON.stringify(c));
    fs.renameSync(chatFile + '.tmp', chatFile);
  };
  const listVersions = () => {
    if (!fs.existsSync(vdir)) return [];
    return fs.readdirSync(vdir).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try {
        const v: VersionFile = JSON.parse(fs.readFileSync(path.join(vdir, f), 'utf8'));
        const lines = v.sheet.blocks.reduce((a, b) => a + b.lines.length, 0);
        const profile = v.profile ?? profileSummary(analyze(v.sheet));
        return [{ id: v.id, name: v.name, at: v.at, source: v.source, note: v.note, blocks: v.sheet.blocks.length, lines, duration: sheetDuration(v.sheet).total, profile }];
      } catch { return []; }
    }).sort((a, b) => b.at.localeCompare(a.at));
  };
  const readVersion = (id: string): VersionFile | null => {
    if (!okId(id)) return null;
    const f = path.join(vdir, `${id}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  let chatting = false;
  /** proposals of the running turn by (tool, lines): a later one for the same lines supersedes the earlier */
  let turnProps = new Map<string, string>();

  return async (req: any, res: any, url: URL, body: () => Promise<any>, send: Send): Promise<boolean> => {
    const p = url.pathname;
    if (p === '/api/sheet/versions' && req.method === 'GET') { send(res, 200, { versions: listVersions() }); return true; }
    if (p === '/api/sheet/versions' && req.method === 'POST') {
      const { name, source = 'manual', note, sheet } = await body();
      if (!sheet?.blocks) { send(res, 400, { error: 'sheet required' }); return true; }
      const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;
      const v: VersionFile = { id, name: String(name || 'untitled').slice(0, 120), at: new Date().toISOString(), source: String(source), note: note ? String(note).slice(0, 400) : undefined, sheet, profile: profileSummary(analyze(sheet)) };
      fs.mkdirSync(vdir, { recursive: true });
      fs.writeFileSync(path.join(vdir, `${id}.json`), JSON.stringify(v, null, 1));
      send(res, 200, { id, name: v.name, at: v.at });
      return true;
    }
    const vm = p.match(/^\/api\/sheet\/versions\/([\w-]+)$/);
    if (vm) {
      const v = readVersion(vm[1]);
      if (!v) { send(res, 404, { error: 'no such version' }); return true; }
      if (req.method === 'GET') { send(res, 200, v); return true; }
      if (req.method === 'PATCH') {
        const { name } = await body();
        if (name) v.name = String(name).slice(0, 120);
        fs.writeFileSync(path.join(vdir, `${v.id}.json`), JSON.stringify(v, null, 1));
        send(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'DELETE') { fs.unlinkSync(path.join(vdir, `${v.id}.json`)); send(res, 200, { ok: true }); return true; }
    }
    if (p === '/api/sheet/cmudict' && req.method === 'GET') {
      if (!fs.existsSync(dictFile)) { send(res, 404, { error: 'no data/cmudict.json — run `node scripts/cmudict.mjs`' }); return true; }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'max-age=86400');
      fs.createReadStream(dictFile).pipe(res);
      return true;
    }
    if (p === '/api/sheet/analysis' && req.method === 'POST') {
      // cached meaning analysis for these block hashes (no AI call)
      const { hashes } = await body();
      const c = sem();
      send(res, 200, { sem: Object.fromEntries((Array.isArray(hashes) ? hashes : []).filter((h: string) => c[h]).map((h: string) => [h, c[h]])) });
      return true;
    }
    if (p === '/api/sheet/analyze' && req.method === 'POST') {
      const { sheet, provider = 'claude', model, force } = await body();
      if (!sheet?.blocks) { send(res, 400, { error: 'sheet required' }); return true; }
      try { send(res, 200, await analyzeMeaning(sheet, provider === 'openai' ? 'openai' : 'claude', model, !!force)); }
      catch (e: any) { send(res, 500, { error: String(e?.message ?? e), runId: e?.runId }); }
      return true;
    }
    if (p === '/api/sheet/chat' && req.method === 'GET') { send(res, 200, { display: readChat().display, turns: readChat().api.length }); return true; }
    if (p === '/api/sheet/chat' && req.method === 'DELETE') { writeChat({ api: [], display: [] }); send(res, 200, { ok: true }); return true; }
    if (p === '/api/sheet/chat/display' && req.method === 'PUT') {
      const { display } = await body();
      const c = readChat();
      c.display = Array.isArray(display) ? display : [];
      writeChat(c);
      send(res, 200, { ok: true });
      return true;
    }
    if (p === '/api/sheet/chat' && req.method === 'POST') {
      if (chatting) { send(res, 409, { error: 'a chat turn is already running' }); return true; }
      const input: ChatIn = await body();
      chatting = true;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/x-ndjson');
      res.setHeader('cache-control', 'no-cache');
      const emit = (o: unknown) => res.write(JSON.stringify(o) + '\n');
      try {
        await chatTurn(input, emit);
      } catch (e: any) {
        emit({ t: 'error', msg: String(e?.message ?? e) });
      } finally {
        chatting = false;
        res.end();
      }
      return true;
    }
    return false;
  };

  // ---- AI meaning analysis (one structured call per batch of changed blocks, cached by text hash) ----------

  async function analyzeMeaning(s: LyricSheet, provider: LLMProvider, model: string | undefined, force: boolean) {
    const st = llmStatus()[provider];
    if (!st.available) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Claude'} isn't configured — ${st.why}`);
    const c = sem();
    const uniq = new Map<string, LyricSheet['blocks'][number]>();
    for (const b of sorted(s)) if (b.lines.some((l) => /[\p{L}]/u.test(l.text))) { const h = blockHash(b); if (!uniq.has(h)) uniq.set(h, b); }
    const todo = [...uniq].filter(([h]) => force || !c[h]);
    const song = sorted(s).map((b) => `[${b.name}]\n${blockText(b)}`).join('\n\n');
    for (let i = 0; i < todo.length; i += 10) {
      const batch = todo.slice(i, i + 10);
      const user = [
        `Style: ${s.style.trim() || '(none)'}`, '', 'The whole song, for context:', song, '',
        'Analyse these blocks (ids in brackets; lines numbered from 0, directions and adlibs included):',
        ...batch.map(([h, b]) => `## ${b.name} [${h}]\n${b.lines.map((l, k) => `${k}: ${l.text}`).join('\n')}`),
      ].join('\n');
      const { data } = await jsonCompletion<{ blocks: (BlockSemantic & { id: string })[] }>({ provider, model, system: SEM_SYSTEM, user, name: 'lyrics_meaning', schema: SEM_SCHEMA }, ai);
      for (const r of data.blocks ?? []) {
        if (!batch.some(([h]) => h === r.id)) continue;
        const { id, ...rest } = r;
        c[id] = rest;
      }
      saveSem();
    }
    return { sem: Object.fromEntries([...uniq.keys()].filter((h) => c[h]).map((h) => [h, c[h]])), analysed: todo.length };
  }

  // ---- the chat turn ------------------------------------------------------------------------------

  async function chatTurn(input: ChatIn, emit: (o: unknown) => void) {
    const provider: LLMProvider = input.provider === 'openai' ? 'openai' : 'claude';
    const st = llmStatus()[provider];
    if (!st.available) throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Claude'} isn't configured — ${st.why} (in phantasma/.env, then restart the editor)`);
    const model = input.model || defaultModel(provider);
    const chat = readChat();
    const userText = turnText(input);
    const run = ai.start('lyrics-chat', provider, model, SYSTEM, userText);
    let nProp = 0;
    const propId = () => `p${Date.now().toString(36).slice(-4)}${++nProp}`;
    turnProps = new Map();
    const exec = (name: string, raw: unknown) => {
      const r = runTool(name, raw, input.sheet, input, propId);
      emit({ t: 'tool', name, ok: !r.error, summary: r.summary });
      if (r.proposal) emit({ t: 'proposal', proposal: r.proposal });
      ai.event(run, `tool ${name}${r.error ? ` ✖ ${r.error}` : ''}`);
      return r;
    };
    // each provider keeps its own (append-only) history; the display log is shared
    const lenApi = chat.api.length, lastOai = chat.oaiLast;
    try {
      if (provider === 'openai') await openaiTurn(model, userText, chat, run, emit, exec);
      else await claudeTurn(model, userText, chat.api, run, emit, exec);
      writeChat(chat);
      ai.finish(run);
      emit({ t: 'done', runId: run.id });
    } catch (e) {
      // drop the unfinished turn so the stored thread stays a valid conversation
      chat.api.length = lenApi;
      chat.oaiLast = lastOai;
      writeChat(chat);
      ai.finish(run, e);
      throw e;
    }
  }

  type Exec = (name: string, raw: unknown) => { content: string; error?: string };

  async function claudeTurn(model: string, userText: string, api: BetaMessageParam[], run: AiRun, emit: (o: unknown) => void, exec: Exec) {
    api.push({ role: 'user', content: userText });
    anthropic ??= new Anthropic();
    for (let iter = 0; iter < 12; iter++) {
      const stream = anthropic.beta.messages.stream({
        model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium' },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages: api,
      });
      stream.on('thinking', (d) => { run.thinking += d; emit({ t: 'thinking', d }); });
      stream.on('text', (d) => { run.text += d; emit({ t: 'text', d }); });
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await stream.finalMessage();
      } catch (err) {
        // eager input streaming: a tool input that isn't parseable JSON rejects here — re-issue the turn
        if (err instanceof Anthropic.APIError || iter >= 10) throw err;
        ai.event(run, `tool input was not parseable JSON, re-issuing (${(err as Error).message})`);
        continue;
      }
      run.servedBy = msg.model;
      run.usage = msg.usage as any;
      ai.event(run, `stop: ${msg.stop_reason} · in ${msg.usage.input_tokens} / out ${msg.usage.output_tokens}${msg.usage.cache_read_input_tokens ? ` · cache read ${msg.usage.cache_read_input_tokens}` : ''}`);
      if (msg.stop_reason === 'refusal') throw new Error(`Claude declined (${msg.stop_details?.category ?? 'no category'})`);
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason === 'max_tokens' && uses.length) throw new Error('response hit max_tokens mid tool call — ask for a smaller change');
      api.push({ role: 'assistant', content: msg.content as any });
      if (msg.stop_reason === 'pause_turn') continue;
      if (!uses.length) break;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = uses.map((u) => {
        const r = exec(u.name, u.input);
        return { type: 'tool_result', tool_use_id: u.id, content: r.error ?? r.content, ...(r.error ? { is_error: true } : {}) };
      });
      api.push({ role: 'user', content: results });
    }
  }

  /**
   * OpenAI: Responses API (function tools work alongside reasoning there). Turns chain on `previous_response_id`,
   * so OpenAI keeps the history, reasoning items included; the thread stores the last response id.
   */
  async function openaiTurn(model: string, userText: string, chat: Thread, run: AiRun, emit: (o: unknown) => void, exec: Exec) {
    openai ??= new OpenAI();
    let prev = chat.oaiLast ?? null;
    let input: OpenAI.Responses.ResponseInput = [{ role: 'user', content: userText }];
    let reasoning = true;
    for (let iter = 0; iter < 12; iter++) {
      let resp: OpenAI.Responses.Response;
      try {
        const stream = openai.responses.stream({
          model, instructions: SYSTEM, input, tools: OAI_TOOLS, previous_response_id: prev,
          ...(reasoning ? { reasoning: { summary: 'auto' as const } } : {}),
        });
        for await (const ev of stream) {
          if (ev.type === 'response.output_text.delta') { run.text += ev.delta; emit({ t: 'text', d: ev.delta }); }
          else if (ev.type === 'response.reasoning_summary_text.delta') { run.thinking += ev.delta; emit({ t: 'thinking', d: ev.delta }); }
        }
        resp = await stream.finalResponse();
      } catch (err) {
        // not every model takes reasoning summaries; an expired chain starts over with this turn's context only
        if (err instanceof OpenAI.BadRequestError && reasoning && /reasoning/i.test(err.message)) { reasoning = false; iter--; continue; }
        if (err instanceof OpenAI.BadRequestError && prev && /previous_response/i.test(err.message) && iter === 0) { ai.event(run, 'previous response expired, starting a fresh context'); prev = null; iter--; continue; }
        throw err;
      }
      run.servedBy = resp.model;
      run.usage = resp.usage as any;
      ai.event(run, `status: ${resp.status}${resp.usage ? ` · in ${resp.usage.input_tokens} / out ${resp.usage.output_tokens}` : ''}`);
      if (resp.status === 'incomplete') throw new Error(`OpenAI stopped early (${resp.incomplete_details?.reason ?? 'incomplete'}) — ask for a smaller change`);
      prev = resp.id;
      const calls = resp.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === 'function_call');
      if (!calls.length) break;
      input = calls.map((c) => {
        let args: unknown;
        try { args = JSON.parse(c.arguments || '{}'); } catch { return { type: 'function_call_output' as const, call_id: c.call_id, output: JSON.stringify({ INVALID_JSON: c.arguments }) }; }
        const r = exec(c.name, args);
        return { type: 'function_call_output' as const, call_id: c.call_id, output: r.error ? `ERROR: ${r.error}` : r.content };
      });
    }
    chat.oaiLast = prev ?? undefined;
  }

  function turnText(input: ChatIn): string {
    const s = input.sheet;
    const d = sheetDuration(s);
    const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    const lines = [`<editor_state>`, `Style: ${s.style.trim() || '(none yet)'}`, `Meter: ${s.bpm} bpm, ${s.beatsPerBar}/4 · ${s.blocks.length} blocks · est. ${fmt(d.total)}`];
    const fb = input.focus?.block ? s.blocks.find((b) => b.id === input.focus!.block) : undefined;
    if (fb) {
      lines.push(`Focus block: ${fb.name} [${fb.id}] bars ${barOf(s, fb.at)}–${barOf(s, fb.at + fb.len)}`);
      lines.push(`Layers over the focus:\n${layersText(s, fb.at, fb.at + fb.len)}`);
      const a = analyze(s, input.sung);
      const bm = a.blocks.find((b) => b.id === fb.id);
      if (bm?.sung.length) {
        lines.push(`Focus shape: syllables ${JSON.stringify(bm.syllables)} · rhyme ${bm.rhyme} · density ${JSON.stringify(bm.density)} syl/beat${bm.shape ? ` · target syllables ${JSON.stringify(bm.shape.syl)}${bm.shape.rhyme ? ` rhyme ${bm.shape.rhyme}` : ''}` : ''}`);
        const tg = s.targets?.[fb.kind];
        if (tg) lines.push(`Targets for ${fb.kind}: ${JSON.stringify(tg)}`);
        const f = a.findings.filter((x) => x.block === fb.id && x.level === 'warn');
        if (f.length) lines.push(`Warnings in focus: ${f.map((x) => `${x.rule}${x.line ? ` [${x.line}]` : ''} ${x.msg}`).join('; ')}`);
      }
    }
    if (input.selection?.lines.length) {
      lines.push(`Selection: "${input.selection.text}"`);
      for (const x of input.selection.lines) {
        const line = s.blocks.find((b) => b.id === x.block)?.lines.find((l) => l.id === x.line);
        if (line) lines.push(`  in [${x.line}] ${line.text}  → chars ${x.from}-${x.to}`);
      }
    }
    const blockIds = fb ? [fb.id] : [];
    const tags = s.tags.filter((t) => blockIds.some((id) => s.blocks.find((b) => b.id === id)?.lines.some((l) => l.id === t.line)));
    if (tags.length) lines.push(`Tags in focus: ${tags.map((t) => { const l = s.blocks.flatMap((b) => b.lines).find((x) => x.id === t.line); return `${t.kind}${t.label ? `:${t.label}` : ''} "${l?.text.slice(t.from, t.to)}" [${t.line}]${t.note ? ` (${t.note})` : ''}`; }).join('; ')}`);
    if (input.review?.length) lines.push(`Your earlier proposals since the last message: ${input.review.join('; ')}`);
    lines.push(`</editor_state>`, '', input.message);
    return lines.join('\n');
  }

  function runTool(name: string, raw: unknown, s: LyricSheet, input: ChatIn, propId: () => string): { content: string; error?: string; summary?: string; proposal?: unknown } {
    const x = (raw ?? {}) as any;
    let A: SheetAnalysis | null = null;
    const an = () => (A ??= analyze(s, input.sung));
    const allLines = new Map(s.blocks.flatMap((b) => b.lines.map((l) => [l.id, { b, l }] as const)));
    const bad = (msg: string) => ({ content: '', error: msg });
    const isStr = (v: unknown) => typeof v === 'string';
    const isArr = (v: unknown) => Array.isArray(v);
    const keepViolations = (lineId: string, text: string | null) =>
      s.tags.filter((t) => t.line === lineId && t.kind === 'keep').map((t) => allLines.get(lineId)!.l.text.slice(t.from, t.to)).filter((k) => text === null || !text.includes(k));
    const proposal = (summary: string, extra: Record<string, unknown> = {}, warnings: string[] = []) => {
      const id = propId();
      const lineKey = name === 'propose_lines' ? x.edits.map((e: any) => e.line_id).sort().join(',') : name === 'propose_alternatives' ? x.line_ids.join(',') : null;
      const supersedes = lineKey ? turnProps.get(`${name}|${lineKey}`) : undefined;
      if (lineKey) turnProps.set(`${name}|${lineKey}`, id);
      const warn = warnings.length
        ? ` Checks against the lines' shape: ${warnings.join('; ')}. The user sees these as badges. If a deviation is unintended, send a corrected proposal for the same lines (it replaces this one); if intended, say why in one sentence.`
        : '';
      return { content: `Proposal ${id} recorded; the user reviews it in the editor (accept / reject).${warn} Don't repeat its content in your reply.`, summary, proposal: { id, tool: name, input: x, ...extra, ...(supersedes ? { supersedes } : {}) } };
    };
    const strict = !!s.lint?.strict;
    switch (name) {
      case 'get_structure': return { content: structureText(s), summary: 'read structure' };
      case 'get_lyrics': {
        if (x.block_ids !== undefined && !isArr(x.block_ids)) return bad('block_ids must be an array of block ids');
        return { content: lyricsText(s, x.block_ids?.length ? x.block_ids : undefined) || '(no lyrics yet)', summary: x.block_ids?.length ? `read ${x.block_ids.length} block(s)` : 'read lyrics' };
      }
      case 'get_layers': {
        const bpb = s.beatsPerBar;
        const a = typeof x.from_bar === 'number' ? (x.from_bar - 1) * bpb : 0;
        const b = typeof x.to_bar === 'number' ? (x.to_bar - 1) * bpb : Infinity;
        return { content: layersText(s, a, b) + `\nLabels: ${s.labels.map((l) => l.name).join(', ')}`, summary: 'read layers' };
      }
      case 'get_tags': {
        const out = s.tags.map((t) => { const e = allLines.get(t.line); return `${t.kind}${t.label ? `:${t.label}` : ''} "${e?.l.text.slice(t.from, t.to)}" in [${t.line}] (${e?.b.name})${t.note ? ` — ${t.note}` : ''}`; });
        return { content: out.join('\n') || '(no tags)', summary: 'read tags' };
      }
      case 'get_selection': {
        const sel = input.selection;
        if (!sel?.lines.length) return { content: '(nothing selected)', summary: 'read selection' };
        const out: string[] = [`Selected: "${sel.text}"`];
        for (const ln of sel.lines) {
          const e = allLines.get(ln.line);
          if (!e) continue;
          const i = e.b.lines.findIndex((l) => l.id === ln.line);
          out.push(`In ${e.b.name} [${e.b.id}]:`);
          e.b.lines.slice(Math.max(0, i - 2), i + 3).forEach((l) => out.push(`${l.id === ln.line ? '>' : ' '} [${l.id}] ${l.text}`));
        }
        return { content: out.join('\n'), summary: 'read selection' };
      }
      case 'get_style': return { content: s.style || '(no style yet)', summary: 'read style' };
      case 'list_versions': return { content: listVersions().map((v) => `${v.id} · ${v.name} · ${v.at} · ${v.source} · ${v.blocks} blocks`).join('\n') || '(no saved versions)', summary: 'listed versions' };
      case 'get_version': {
        if (!isStr(x.id)) return bad('id required');
        const v = readVersion(x.id);
        if (!v) return bad(`no version ${x.id}`);
        return { content: `${v.name} (${v.at})\nStyle: ${v.sheet.style}\n\n${structureText(v.sheet)}\n\n${lyricsText(v.sheet)}`, summary: `read version ${v.name}` };
      }
      case 'check_lines': {
        if (!isArr(x.lines) || !x.lines.every(isStr)) return bad('lines must be an array of strings');
        // planned beats come from the lines they would replace (line_ids, positional) when given
        const targets = isArr(x.line_ids) ? (x.line_ids as string[]).map((id) => [...an().byKey.values()].find((m) => m.line === id)) : [];
        const out = (x.lines as string[]).map((l, i) => {
          const t = targets[i];
          const c = checkLine(s, l, t?.at, t?.len);
          const dev: string[] = [];
          if (t) {
            const want = t.target ?? t.t.syl;
            if (Math.abs(c.syl - want) > 1) dev.push(`syllables ${c.syl} vs ${want}`);
            if (t.partner !== null && t.letter) {
              const p = an().blocks.find((b) => b.id === t.block)!.lines[t.partner];
              dev.push(`must rhyme (${t.letter[0]}) with "${p.t.end?.w ?? ''}"`);
            }
            if (t.sustained && c.sustain === 'closed') dev.push('ends on a closed vowel where the note is held');
          }
          return `${c.syl} syl ${c.stress} · end "${c.end}" (${c.tail})${c.sps !== null ? ` · ${c.sps} syl/s` : ''}${c.sustain ? ` · last vowel ${c.sustain}` : ''}${c.est.length ? ` · estimated: ${c.est.join(', ')}` : ''}${dev.length ? ` · ${dev.join('; ')}` : ''} · ${l}`;
        });
        return { content: out.join('\n'), summary: `checked ${x.lines.length} line(s)` };
      }
      case 'analyze_block': {
        if (!isStr(x.block_id) || !s.blocks.some((b) => b.id === x.block_id)) return bad('block_id must be an existing block id');
        return { content: blockReport(an(), x.block_id), summary: `analysed ${s.blocks.find((b) => b.id === x.block_id)!.name}` };
      }
      case 'get_findings': return { content: findingsText(an(), isStr(x.category) ? x.category : undefined), summary: 'read findings' };
      case 'get_hook': return { content: hookText(an()), summary: 'read hooks' };
      case 'propose_lines': {
        if (!isArr(x.edits) || !x.edits.length) return bad('edits must be a non-empty array');
        for (const e of x.edits) {
          if (!['replace', 'insert_after', 'delete'].includes(e?.op)) return bad(`bad op ${e?.op}`);
          if (!allLines.has(e.line_id)) return bad(`unknown line id ${e.line_id} — read the lyrics for current ids`);
          if (e.op !== 'delete' && !isStr(e.text)) return bad(`text required for ${e.op}`);
          if (e.op !== 'insert_after') {
            const v = keepViolations(e.line_id, e.op === 'delete' ? null : e.text);
            if (v.length) return bad(`[${e.line_id}] has keep tag(s) on ${v.map((k) => `"${k}"`).join(', ')} — that text must stay verbatim`);
          }
        }
        const linked = x.edits.filter((e: any) => allLines.get(e.line_id)!.b.link).length;
        const checks = checkEdits(s, an(), x.edits, strict);
        const errs = checks.flatMap((c) => c.errors.map((m) => `[${c.line}] ${m}`));
        if (errs.length) return bad(`strict meter is on: ${errs.join('; ')} — keep each line within ±1 syllable of its target (check_lines helps)`);
        const warnings = checks.flatMap((c) => c.badges.map((m) => `[${c.line}] ${m}`));
        return proposal(`${x.edits.length} line edit(s)${linked ? ' (linked blocks follow)' : ''}`, { before: Object.fromEntries(x.edits.map((e: any) => [e.line_id, allLines.get(e.line_id)!.l.text])), checks: Object.fromEntries(checks.map((c) => [c.line, c.badges])) }, warnings);
      }
      case 'propose_alternatives': {
        if (!isArr(x.line_ids) || !x.line_ids.length || !x.line_ids.every((id: string) => allLines.has(id))) return bad('line_ids must list existing line ids');
        if (!isArr(x.options) || x.options.length < 2 || !x.options.every(isStr)) return bad('options must be ≥ 2 strings');
        for (const id of x.line_ids) {
          const keeps = keepViolations(id, null);
          for (const o of x.options) { const miss = keeps.filter((k) => !o.includes(k)); if (miss.length) return bad(`an option drops kept text ${miss.map((k) => `"${k}"`).join(', ')}`); }
        }
        // each option is checked as replace edits over the given lines (positionally)
        const optChecks = (x.options as string[]).map((o) => {
          const parts = o.split('\n');
          const edits = x.line_ids.map((id: string, k: number) => ({ op: 'replace', line_id: id, text: parts[k] ?? '' })).filter((e: any) => e.text);
          return checkEdits(s, an(), edits, strict);
        });
        const errs = optChecks.flatMap((cs, i) => cs.flatMap((c) => c.errors.map((m) => `option ${i + 1} [${c.line}] ${m}`)));
        if (errs.length) return bad(`strict meter is on: ${errs.join('; ')}`);
        const warnings = optChecks.flatMap((cs, i) => cs.flatMap((c) => c.badges.map((m) => `option ${i + 1} [${c.line}] ${m}`)));
        return proposal(`${x.options.length} alternatives for ${x.line_ids.length} line(s)`, { before: Object.fromEntries(x.line_ids.map((id: string) => [id, allLines.get(id)!.l.text])), checks: optChecks.map((cs) => cs.flatMap((c) => c.badges)) }, warnings);
      }
      case 'propose_blocks': {
        if (!isArr(x.ops) || !x.ops.length) return bad('ops must be a non-empty array');
        const ids = new Set(s.blocks.map((b) => b.id));
        for (const o of x.ops) {
          if (!['add', 'remove', 'resize', 'rename', 'move', 'gap'].includes(o?.op)) return bad(`bad op ${o?.op}`);
          if (o.op !== 'add' && !ids.has(o.block_id)) return bad(`unknown block id ${o.block_id}`);
          if (o.op === 'add' && (!isStr(o.name) || typeof o.bars !== 'number')) return bad('add needs name and bars');
          if ((o.op === 'resize' || o.op === 'gap') && typeof o.bars !== 'number') return bad(`${o.op} needs bars`);
          if (o.op === 'rename' && !isStr(o.name)) return bad('rename needs name');
        }
        return proposal(`${x.ops.length} structure change(s)`);
      }
      case 'propose_layers': {
        if (!isArr(x.ops) || !x.ops.length) return bad('ops must be a non-empty array');
        for (const o of x.ops) {
          if (!['add', 'remove', 'energy'].includes(o?.op)) return bad(`bad op ${o?.op}`);
          if (typeof o.from_bar !== 'number' || typeof o.to_bar !== 'number') return bad('from_bar / to_bar required');
          if (o.op !== 'energy' && (!isStr(o.track) || !isStr(o.label))) return bad('track and label required');
          if (o.op === 'energy' && (typeof o.from !== 'number' || typeof o.to !== 'number')) return bad('energy needs from and to (0..1)');
        }
        return proposal(`${x.ops.length} layer change(s)`);
      }
      case 'propose_tags': {
        if (!isArr(x.ops) || !x.ops.length) return bad('ops must be a non-empty array');
        for (const o of x.ops) {
          if (!allLines.has(o?.line_id)) return bad(`unknown line id ${o?.line_id}`);
          if (!isStr(o.words) || !allLines.get(o.line_id)!.l.text.includes(o.words)) return bad(`"${o.words}" is not in line ${o.line_id}`);
        }
        return proposal(`${x.ops.length} tag change(s)`);
      }
      case 'propose_style': {
        if (!isStr(x.style)) return bad('style required');
        return proposal('style update', { before: s.style });
      }
    }
    return bad(`unknown tool ${name}`);
  }
}

let anthropic: Anthropic | null = null;
let openai: OpenAI | null = null;

const SYSTEM = `You are a songwriting collaborator built into a lyric editor. The user writes lyrics for a song that an AI
music generator will produce, so the sheet uses generator conventions: [bracketed] text is a performance or arrangement
direction (e.g. [whisper], [building intensity], [piano solo]); (parenthesised) text is an adlib or backing vocal.

The sheet is blocks (verse, chorus, …) laid out in bars on a timeline, each with lines. Every line has an id like
[labc123] — ids are references for your tools, never part of the lyric text. Blocks with the same "linked" id are
repeats that share their lines: editing a line in one changes every copy. Arrangement layers are tracks of labels
(e.g. male, female, intense piano) painted over bar ranges, plus an energy curve 0..1.

Each user message starts with an <editor_state> block: the style, meter, the block in focus, the current selection,
the layers and tags over the focus, and what happened to your earlier proposals. Read more with the get_* tools when
you need it (full lyrics, structure, layers, tags, saved versions) rather than guessing.

To change anything, call a propose_* tool. Never write changed lyrics in your reply text instead of proposing them —
the user reviews proposals in the editor and accepts or rejects them. One proposal can hold several edits; prefer one
coherent proposal per idea. When asked for options ("give me a few", "alternatives"), use propose_alternatives.

Word tags are constraints: keep = that text stays verbatim; replace = the user wants those words changed; note / custom
labels = context for you. Respect the style and the layers under the lines (a whispered, sparse section wants different
words than a full-band chorus).

The editor measures lyrics: syllables and stress by pronunciation, rhyme by sound (perfect / slant), syllables per beat
against the planned tempo, breath, held notes, hooks and repetition. These are a profile of what the song is, not a
grade. Keep the shape of the lines you rewrite unless asked otherwise: syllables within ±1 (or the block's target shape),
the rhyme scheme, an open vowel where a note is held. Use check_lines to measure candidates before proposing, and
analyze_block / get_findings / get_hook when the request is about structure, rhythm or the hook. Proposals come back
with checks; when you trade meter for meaning on purpose, say so.

After proposing, reply in a sentence or two: what you changed and why. No preamble, no restating the proposal.`;

const T = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Anthropic.Beta.BetaTool => ({
  name, description, eager_input_streaming: true, input_schema: { type: 'object', properties, required },
});
const str = { type: 'string' };
const num = { type: 'number' };

const TOOLS: Anthropic.Beta.BetaTool[] = [
  T('get_lyrics', 'Full lyrics (or some blocks) with line ids, syllable counts, rhyme letters and word tags.', { block_ids: { type: 'array', items: str, description: 'only these blocks; omit for all' } }),
  T('get_structure', 'Blocks in order with ids, kinds, bars, times, gaps, links and tempo.', {}),
  T('get_layers', 'Arrangement layers (track spans by label, energy curve) over a bar range.', { from_bar: num, to_bar: num }),
  T('get_tags', 'All word tags (replace / keep / note) with their text and line.', {}),
  T('get_selection', 'The current selection with two lines of context around it.', {}),
  T('get_style', 'The global style prompt.', {}),
  T('list_versions', 'Saved versions in the library.', {}),
  T('get_version', 'Structure + lyrics of a saved version (to compare or bring something back).', { id: str }, ['id']),
  T('check_lines', 'Measure candidate lines: syllables, stress pattern (x unstressed, / stressed), end word and its rhyme sound, syllables per second, last vowel open/closed. Pass line_ids (positional) to check them against the lines they would replace: planned beats, target syllables, rhyme partner, held notes.', {
    lines: { type: 'array', items: str }, line_ids: { type: 'array', items: str, description: 'optional: the line each candidate would replace, same order' },
  }, ['lines']),
  T('analyze_block', 'Profile of one block: syllable / stress / rhyme / density sequences, meter, breath, repetition, perspective, held notes, target shape and its findings.', { block_id: str }, ['block_id']),
  T('get_findings', 'Findings over the whole song (rhythm, rhyme, repetition, sound, language, targets, meaning, sung), optionally one category.', { category: { type: 'string', enum: ['rhythm', 'rhyme', 'repetition', 'sound', 'language', 'targets', 'meaning', 'sung'] } }),
  T('get_hook', 'Recurring phrases (the hook first) with counts, positions, time to first hook and chorus, section sequence.', {}),
  T('propose_lines', 'Propose line edits: replace a line, insert a new line after one, or delete one.', {
    edits: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['replace', 'insert_after', 'delete'] }, line_id: str, text: { type: 'string', description: 'new line text (replace / insert_after)' } }, required: ['op', 'line_id'] } },
    summary: str,
  }, ['edits']),
  T('propose_alternatives', 'Offer 2-6 alternative rewrites for one or more consecutive lines. Each option replaces all the given lines; separate lines inside an option with \\n.', {
    line_ids: { type: 'array', items: str }, options: { type: 'array', items: str }, summary: str,
  }, ['line_ids', 'options']),
  T('propose_blocks', 'Propose structure changes. ops: add {name, kind, bars, after_block_id?, lines?}, remove {block_id}, resize {block_id, bars}, rename {block_id, name}, move {block_id, after_block_id (omit = first)}, gap {block_id, bars: pause before the block}.', {
    ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['add', 'remove', 'resize', 'rename', 'move', 'gap'] }, block_id: str, after_block_id: str, name: str, kind: { type: 'string', enum: ['intro', 'verse', 'prechorus', 'chorus', 'bridge', 'outro', 'break', 'hook', 'drop', 'custom'] }, bars: num, lines: { type: 'array', items: str } }, required: ['op'] } },
    summary: str,
  }, ['ops']),
  T('propose_layers', 'Propose arrangement layer changes over bar ranges (bars are 1-based, to_bar exclusive). add/remove paint a label on a track (created if missing); energy draws the energy curve from value `from` to `to`.', {
    ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['add', 'remove', 'energy'] }, track: str, label: str, from_bar: num, to_bar: num, from: num, to: num }, required: ['op', 'from_bar', 'to_bar'] } },
    summary: str,
  }, ['ops']),
  T('propose_tags', 'Propose word tags: add or remove a tag on exact words of a line.', {
    ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['add', 'remove'] }, line_id: str, words: str, kind: { type: 'string', enum: ['replace', 'keep', 'note'] }, note: str }, required: ['op', 'line_id', 'words'] } },
  }, ['ops']),
  T('propose_style', 'Propose a new global style prompt (genre, voice, instrumentation, mood, production).', { style: str, summary: str }, ['style']),
];

/** the same tools as Responses API function tools */
const OAI_TOOLS: OpenAI.Responses.FunctionTool[] = TOOLS.map((t) => ({
  type: 'function', name: t.name, description: t.description ?? '', parameters: t.input_schema as Record<string, unknown>, strict: false,
}));

// ---- meaning analysis prompt ---------------------------------------------------------------------------

const SEM_SYSTEM = `You read song lyrics and describe each block you're given, as structured data for a lyric editor. Describe
what is there, as amounts, not quality grades: a sparse, repetitive chorus and a dense, image-heavy verse are both fine.
[Bracketed] text is a performance direction and (parenthesised) text an adlib; judge the sung words.

Per block (id = the bracketed id you were given):
- summary: one short line, what the block says or does.
- advances 0..1: how much new information or story movement it brings compared to the blocks before it (a repeated
  chorus is near 0).
- valence -1..1 (negative … positive) and intensity 0..1 of the emotion; emotions: one to three words.
- concreteness 0..1 (abstract … concrete, sensory), imagery 0..1 (density of images), metaphor 0..1 (figurative density);
  imageWords: the words carrying the images, verbatim from the lyric.
- cliches: stock phrases or predictable images, verbatim text plus a few words why. Empty when there are none; don't
  flag deliberate hook repetition.
- coherence 0..1 with the style and the song's central idea.
- lines: valence and intensity per sung line, by its line number.`;

const SEM_SCHEMA: Record<string, unknown> = {
  type: 'object', additionalProperties: false, required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'summary', 'advances', 'valence', 'intensity', 'emotions', 'concreteness', 'imagery', 'metaphor', 'imageWords', 'cliches', 'coherence', 'lines'],
        properties: {
          id: { type: 'string' }, summary: { type: 'string' }, advances: num, valence: num, intensity: num,
          emotions: { type: 'array', items: { type: 'string' } }, concreteness: num, imagery: num, metaphor: num,
          imageWords: { type: 'array', items: { type: 'string' } },
          cliches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'why'], properties: { text: { type: 'string' }, why: { type: 'string' } } } },
          coherence: num,
          lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'valence', 'intensity'], properties: { i: { type: 'integer' }, valence: num, intensity: num } } },
        },
      },
    },
  },
};
