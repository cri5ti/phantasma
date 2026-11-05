// LLM layer for the storyboard stage: Claude (default) or OpenAI, both returning schema-validated JSON.
//   ANTHROPIC_API_KEY (or an `ant auth login` profile)   MV_CLAUDE_MODEL  (default claude-opus-5-5)
//   OPENAI_API_KEY                                       MV_OPENAI_MODEL  (default gpt-5)
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { AiLog } from './aiLog';

export type LLMProvider = 'claude' | 'openai';

export const defaultModel = (p: LLMProvider) =>
  p === 'openai' ? process.env.MV_OPENAI_MODEL || 'gpt-5' : process.env.MV_CLAUDE_MODEL || 'claude-opus-5-5';

export function llmStatus() {
  return {
    claude: { available: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN), model: defaultModel('claude'), why: 'set ANTHROPIC_API_KEY (or run `ant auth login`)' },
    openai: { available: !!process.env.OPENAI_API_KEY, model: defaultModel('openai'), why: 'set OPENAI_API_KEY' },
  };
}

let anthropic: Anthropic | null = null;
let openai: OpenAI | null = null;

interface JsonCall {
  provider: LLMProvider;
  model?: string;
  system: string;
  user: string;
  name: string;
  schema: Record<string, unknown>;
}

export async function jsonCompletion<T>(c: JsonCall, log: AiLog): Promise<{ data: T; model: string; runId: string }> {
  const model = c.model || defaultModel(c.provider);
  const run = log.start(c.name, c.provider, model, c.system, c.user);
  // live progress: throttled "N chars, M items" lines + thinking summary sentences as they complete
  let lastTick = 0, thinkCut = 0;
  const items = (s: string) => (s.match(/"description"\s*:|"text"\s*:/g) ?? []).length;
  const tick = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 1500) return;
    lastTick = now;
    if (run.text) log.event(run, `writing… ${run.text.length} chars, ~${items(run.text)} item(s)`);
  };
  const flushThinking = (force = false) => {
    const rest = run.thinking.slice(thinkCut);
    const end = force ? rest.length : Math.max(rest.lastIndexOf('\n'), rest.lastIndexOf('. ') + 1);
    if (end <= 0) return;
    const chunk = rest.slice(0, end).trim();
    thinkCut += end;
    if (chunk) log.event(run, `thinking: ${chunk.replace(/\s+/g, ' ').slice(0, 400)}`);
  };
  try {
    if (c.provider === 'openai') {
      openai ??= new OpenAI();
      log.event(run, 'request sent (streaming)');
      const stream = await openai.chat.completions.create({
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'system', content: c.system }, { role: 'user', content: c.user }],
        response_format: { type: 'json_schema', json_schema: { name: c.name, schema: c.schema, strict: true } },
      });
      let refusal = '', finish = '';
      for await (const ch of stream) {
        if (ch.model) run.servedBy = ch.model;
        if (ch.usage) run.usage = ch.usage as any;
        const d = ch.choices[0]?.delta;
        if (d?.content) { if (!run.text) log.event(run, 'first tokens'); run.text += d.content; tick(); }
        if (d?.refusal) refusal += d.refusal;
        if (ch.choices[0]?.finish_reason) finish = ch.choices[0].finish_reason;
      }
      run.stopReason = finish;
      tick(true);
      if (run.usage) log.event(run, `usage: ${JSON.stringify(run.usage)}`);
      if (refusal) throw new Error(`OpenAI refused: ${refusal}`);
      if (!run.text) throw new Error(`OpenAI returned no content (finish_reason ${finish})`);
    } else {
      anthropic ??= new Anthropic();
      log.event(run, 'request sent (streaming, adaptive thinking, effort medium)');
      // Streaming: a full-song shot list is long output. Server-side fallback reroutes a classifier decline.
      const stream = anthropic.beta.messages.stream({
        model,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: c.schema } },
        system: c.system,
        messages: [{ role: 'user', content: c.user }],
      });
      stream.on('thinking', (d) => { if (!run.thinking) log.event(run, 'thinking…'); run.thinking += d; flushThinking(); });
      stream.on('text', (d) => { if (!run.text) { flushThinking(true); log.event(run, 'writing the answer'); } run.text += d; tick(); });
      const msg = await stream.finalMessage();
      flushThinking(true);
      tick(true);
      run.servedBy = msg.model;
      run.stopReason = msg.stop_reason ?? undefined;
      run.usage = msg.usage as any;
      if (msg.model !== model) log.event(run, `served by fallback model ${msg.model}`);
      log.event(run, `stop: ${msg.stop_reason} · in ${msg.usage.input_tokens} / out ${msg.usage.output_tokens} tokens`);
      if (msg.stop_reason === 'refusal') throw new Error(`Claude declined (${msg.stop_details?.category ?? 'no category'}): ${msg.stop_details?.explanation ?? ''}`);
      if (msg.stop_reason === 'max_tokens') throw new Error('Claude hit max_tokens — try a shorter range');
      run.text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('') || run.text;
    }
    let data: T;
    try { data = JSON.parse(run.text) as T; } catch (e) { throw new Error(`response is not valid JSON: ${(e as Error).message}`); }
    log.event(run, `parsed ${items(run.text)} item(s)`);
    log.finish(run);
    return { data, model: run.servedBy ?? model, runId: run.id };
  } catch (e) {
    log.finish(run, e);
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { runId: run.id });
  }
}

// ---- storyboard prompts ------------------------------------------------------------------

/** What the editor sends: everything the director needs to know about the song and the board. */
export interface StoryContext {
  name: string;
  duration: number;
  sections: { label: string; start: number; end: number; bpm: number; barSec: number; energy: number }[];
  markers: { t: number; label: string }[];
  brief: { prompt: string; lyrics: string; style: string };
  /** parsed LRC lines when the lyrics carry timestamps */
  timedLyrics: { t: number; text: string }[] | null;
  /** pinned ideas / notes from the board */
  ideas: { text: string; tags: string[] }[];
  generators: { id: string; name: string; category: string }[];
  localMedia: { id: string; kind: string; duration: number }[];
  /** regenerate only this window (other shots are kept and shown as context) */
  range: { start: number; end: number } | null;
  keep: { start: number; end: number; description: string }[];
  instruction: string;
}

const SHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concept', 'shots'],
  properties: {
    concept: { type: 'string', description: 'one-paragraph visual concept / treatment for the video' },
    shots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'section', 'description', 'query', 'mood', 'lyric', 'tags', 'source', 'gen', 'transition', 'fade'],
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          section: { type: 'string' },
          description: { type: 'string', description: 'what we see, one or two sentences' },
          query: { type: 'string', description: '2-5 word stock footage search query, concrete nouns + action' },
          mood: { type: 'string' },
          lyric: { type: 'string', description: 'lyric sung over the shot, or empty' },
          tags: { type: 'array', items: { type: 'string' } },
          source: { type: 'string', enum: ['footage', 'gen'] },
          gen: { type: 'string', description: 'generator id when source is gen, else empty' },
          transition: { type: 'string', enum: ['cut', 'crossfade', 'dip'] },
          fade: { type: 'number', description: 'transition length in seconds (0 for cut)' },
        },
      },
    },
  },
} as const;

const IDEA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'tags'],
        properties: {
          text: { type: 'string', description: 'a concrete visual idea, prompt or motif (one or two sentences)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'section names, moods, motifs, colours' },
        },
      },
    },
  },
} as const;

const DIRECTOR = `You are a music video director and storyboard artist working with stock footage plus a set of
audio-reactive generators (visualizers, shaders). You plan shots along the song's real structure so the edit
breathes with the music. Your shots are later searched on stock libraries (Pexels, Pixabay), so search queries
must be concrete and filmable: subjects, places, actions, light (e.g. "woman hair wind beach sunset"), never
abstract words alone ("freedom", "nostalgia").`;

function songFacts(c: StoryContext) {
  const r = (x: number) => +x.toFixed(2);
  const lines = [
    `Song: "${c.name}", ${r(c.duration)} s.`,
    `Sections (start-end s, bpm, bar length s, energy 0..1):`,
    ...c.sections.map((s) => `- ${s.label}: ${r(s.start)}-${r(s.end)}, ${r(s.bpm)} bpm, bar ${r(s.barSec)} s, energy ${r(s.energy)}`),
  ];
  if (c.markers.length) lines.push(`Markers: ${c.markers.map((m) => `${m.label}@${r(m.t)}`).join(', ')}`);
  if (c.brief.prompt.trim()) lines.push('', `Director brief:\n${c.brief.prompt.trim()}`);
  if (c.brief.style.trim()) lines.push('', `Look & style:\n${c.brief.style.trim()}`);
  if (c.timedLyrics?.length) lines.push('', 'Timed lyrics:', ...c.timedLyrics.map((l) => `[${r(l.t)}] ${l.text}`));
  else if (c.brief.lyrics.trim()) lines.push('', `Lyrics (untimed — align them to sections by song form):\n${c.brief.lyrics.trim()}`);
  if (c.ideas.length) lines.push('', 'Ideas pinned on the board (use them):', ...c.ideas.map((i) => `- ${i.text}${i.tags.length ? ` [${i.tags.join(', ')}]` : ''}`));
  if (c.localMedia.length) lines.push('', `Footage already in the project folder: ${c.localMedia.map((m) => `${m.id} (${m.kind}${m.duration ? `, ${r(m.duration)} s` : ''})`).join('; ')}`);
  lines.push('', `Generators available for source "gen": ${c.generators.map((g) => `${g.id} (${g.category})`).join(', ')}`);
  return lines.join('\n');
}

export async function generateShots(log: AiLog, provider: LLMProvider, model: string | undefined, c: StoryContext) {
  const a = c.range?.start ?? 0;
  const b = c.range?.end ?? c.duration;
  const user = [
    songFacts(c),
    '',
    c.range
      ? `Plan shots ONLY for ${a.toFixed(2)}-${b.toFixed(2)} s. These neighbouring shots stay as they are:\n${c.keep.map((k) => `- ${k.start.toFixed(2)}-${k.end.toFixed(2)}: ${k.description}`).join('\n') || '(none)'}`
      : `Plan the whole song, 0-${b.toFixed(2)} s.`,
    c.instruction.trim() ? `\nExtra instruction: ${c.instruction.trim()}` : '',
    `
Rules:
- Shots are contiguous: the first starts at ${a.toFixed(2)}, each next shot starts where the previous ends, the last ends at ${b.toFixed(2)}.
- Cut on bar lines: shot lengths should be whole bars of the section (1-4 bars; longer only in quiet intros/outros).
  Higher energy = shorter shots. Section boundaries should be shot boundaries.
- Build visual motifs that recur (e.g. chorus always returns to the same subject) and escalate toward the climax.
- "gen" shots: use sparingly for driving/abstract moments, pick a generator id from the list; leave query as a fallback search anyway.
- Transitions: crossfade (1-3 s) in quiet/flowing parts, cut (fade 0) in energetic parts and on hard downbeats, dip at big section changes.
- lyric: the line sung during the shot when you know it, else "".
- tags: section name, mood, motif names, colour palette words.`,
  ].join('\n');
  return jsonCompletion<{ concept: string; shots: any[] }>({ provider, model, system: DIRECTOR, user, name: c.range ? 'storyboard-range' : 'storyboard', schema: SHOT_SCHEMA as any }, log);
}

export async function suggestIdeas(log: AiLog, provider: LLMProvider, model: string | undefined, c: StoryContext, count = 12) {
  const user = [
    songFacts(c),
    '',
    `Suggest ${count} distinct visual ideas for this video: motifs, signature shots, colour/lighting treatments,
generator moments and transitions. Make each specific and filmable; mix safe and bold. Don't repeat the pinned ideas.`,
    c.instruction.trim() ? `Focus: ${c.instruction.trim()}` : '',
  ].join('\n');
  return jsonCompletion<{ ideas: { text: string; tags: string[] }[] }>({ provider, model, system: DIRECTOR, user, name: 'ideas', schema: IDEA_SCHEMA as any }, log);
}

/** A card handed to the model for a group operation on the idea board. */
export interface CardIn { kind: string; text: string; tags: string[] }

/** Split / merge / free-prompt over a selection of board cards → resulting idea cards. */
export async function transformCards(log: AiLog, provider: LLMProvider, model: string | undefined, c: StoryContext, cards: CardIn[], task: string, mode: string) {
  const user = [
    songFacts(c),
    '',
    `Selected cards on the idea board (${cards.length}):`,
    ...cards.map((k, i) => `${i + 1}. [${k.kind}] ${k.text.replace(/\s+/g, ' ').trim()}${k.tags.length ? `  {tags: ${k.tags.join(', ')}}` : ''}`),
    '',
    `Task: ${task}`,
    '',
    `Return the resulting cards. Each card is one self-contained visual idea or note, concrete and filmable where it
describes footage. Keep useful tags (section names, moods, motifs, colours) and add tags where they help grouping.
Stock-clip and project-footage cards are context only — they stay on the board as they are, so don't output cards
that merely describe or reference them; use them to inform the ideas. Never invent clip ids.`,
  ].join('\n');
  return jsonCompletion<{ ideas: { text: string; tags: string[] }[] }>({ provider, model, system: DIRECTOR, user, name: `cards-${mode}`, schema: IDEA_SCHEMA as any }, log);
}
