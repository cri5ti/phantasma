# mvgen — system architecture

A music-video generator. A **project** is a folder with a song and footage; one editor app edits it, one Remotion
composition renders it. Everything the app knows about a project is plain JSON on disk.

This document is the map: what the parts are, how they talk, and the rules to follow when changing them.
Feature specs live next to it (`lyrics.md`); user-facing usage is in the root `README.md`.

## 1. The four stages

The editor has a top-bar **mode** (`Mode` in `src/editor/store.ts`). Each stage is a screen over the same project.

| Mode | Purpose | Main code |
|---|---|---|
| `lyrics` | Write and measure lyrics before (or after) the song exists; block out structure; AI chat | `src/editor/lyrics/*`, `src/core/{sheet,lyricMetrics,phonetics}.ts`, `server/sheetApi.ts` |
| `story` | Storyboard: brief, AI shot list, stock footage search, idea board | `src/editor/{StoryPanel,Board,StoryOverlay,storyActions}.ts*`, `src/core/storyboard.ts`, `server/{ai,storyApi,stock}.ts` |
| `edit` | Layer timeline: generators, footage, masks, keyframes, audio modulation | `src/editor/{App,Timeline,Inspector,dopesheet}.ts*`, `src/core/{params,tempo}.ts`, `src/comp/*`, `src/gen/*` |
| `find` / `render` | Footage browser, render queue | `FindScreen.tsx`, `RenderScreen.tsx`, `scripts/render.mjs` |

Data flows one way along the stages: **lyrics sheet → storyboard brief → layers → render**. The sheet writes
`storyboard.brief.lyrics` (derived text), so the storyboard planner needs no knowledge of the sheet.

## 2. Process layout

```
npm run edit -- <projectDir>          scripts/edit.mjs
  └─ analyse audio (python/librosa) + build proxies, if missing
  └─ Vite dev server (vite.config.ts) on :5190
       ├─ serves the React editor (src/editor)
       └─ "mvgen-api" middleware (/api/*)
            ├─ project file read/write, backups, scenes, media, render jobs     (vite.config.ts)
            └─ server/storyApi.ts  →  /api/story  /api/stock  /api/ai  /api/media
                 ├─ server/lyrics.ts     /api/lyrics/*  transcribe · separate · refine (jobs)
                 └─ server/sheetApi.ts   /api/sheet/*   versions · chat tool loop · meaning analysis · cmudict

npm run render -- <projectDir>        scripts/render.mjs  → Remotion (src/remotion/Root.tsx → src/comp/MV.tsx)
npm run analyze / media               scripts/analyze.mjs, scripts/media.mjs (+ analyze/*.py)
```

There is **no separate backend process**: the API is Vite middleware, so editing `server/*.ts` needs the editor
restarted; editing `src/**` hot-reloads. Python is used only for audio analysis, forced alignment and optical-flow
tools (`analyze/`). Node 22, ffmpeg on PATH.

## 3. Project folder (the source of truth)

```
<project>/
  song.wav | *.mp3 …           the produced song (optional — lyrics-first projects have none)
  stock/, any footage          media; stock downloads land in stock/ with credits.json
  scenes/*.frag                per-project GLSL scene layers
  mv.project.json             the Project (see §4). Written by the editor, atomic rename, rolling backups
  lyrics/versions/<id>.json    saved sheet versions (user content: commit-worthy, NOT regenerable)
  lyrics/chat.json             lyrics chat thread
  _mvgen/                      generated / regenerable: analysis.json, proxies, thumbs, backups/, ai-log/,
                               lyrics/ (transcript, vocals stem), lyrics-analysis.json (AI meaning cache)
  out/                         renders
  .env                         API keys (never commit; never print)
```

Rule: **user content lives outside `_mvgen/`; anything inside `_mvgen/` must be safe to delete.**

## 4. The Project document

`Project` (`src/core/types.ts`) is serialisable JSON; times are **seconds** except the lyrics sheet (beats).
Main parts: `tempo` (sections with bpm + downbeat anchor), `layers` (bottom → top; `video | image | gen`),
`params` (constants or `{ $k: keyframes, $mod: modulation }`), masks, `storyboard`, `lyrics` (word-timed lines, after
transcription), `sheet` (the lyric sheet, in beats), `markers`, `cues`.

State handling (`src/editor/store.ts`): one external store; the project is an **immer** document, every change goes
through `store.edit(fn, mergeKey?)` which gives undo/redo (`mergeKey` coalesces drags) and marks it dirty; a debounced
save PUTs the whole file. UI-only state is in the same store or in small modules (`viewState.ts`, `lyrics/state.ts`).
Pure logic that both the editor and renderer need lives in `src/core` and has **no React/DOM/Node imports**.

## 5. Rendering model

- `src/comp/MV.tsx` renders a `Project` at a given frame: layers → generators (`src/gen/registry.ts`) drawn to canvas
  or WebGL, composited with blend modes, masks, clip-to-below, filters.
- Parameters are evaluated per frame by `src/core/params.ts` from keyframes + modulation sources (audio scalars,
  tempo phase, LFO …). Audio features come from `AudioData` (`src/core/audio.ts`): per-frame scalars `rms bass mid high
  onset centroid` and a spectrum, from `_mvgen/analysis.json` + binary.
- **Determinism is a hard rule.** A frame must depend only on (project, frame number). Particles are closed-form per
  particle; feedback trails warm up from stored state or replay a window. Anything stateful must be scrub- and
  parallel-render-safe. `scripts/render.mjs` renders contiguous chunks in parallel processes for that reason.
- Adding a generator: write a `GenDef` (params + draw) and append it to `src/gen/registry.ts`; the editor UI is
  generated from its param definitions.

## 6. AI layer

- `server/ai.ts` — provider-neutral JSON completion (`jsonCompletion`) for Claude (default) and OpenAI, schema-validated.
  Env: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MV_CLAUDE_MODEL`, `MV_OPENAI_MODEL`. Keys come from `.env` (repo, then
  project folder) via `server/env.ts`.
- `server/aiLog.ts` — **every** AI request or job is an `AiRun` (prompts, events, streamed output, usage). Finished runs
  go to `_mvgen/ai-log/`. New AI features must log through it.
- Interactive chat (lyrics) runs a tool loop on the server: read tools resolve against a sheet snapshot posted by the
  client; **write tools never mutate — they return proposals** that the user accepts in the UI (§ lyrics.md).
- Provider differences are hidden in the server layer; the client only picks `'claude' | 'openai'`.

## 7. Conventions for coding agents

1. **Read before writing.** Check the stage spec in `design/` and the file headers (each file starts with a comment
   saying what it is). Match the existing patterns.
2. **Layering:** `src/core` (pure, shared) ← `src/editor` (React) and `server/` (Node, may import core). The renderer
   (`src/comp`, `src/gen`) must not import editor code. `server/` must not import React.
3. **All project edits go through `store.edit`** (lyrics: `editSheet`). Never mutate store state in place; sheets are
   immutable immer drafts, and analysis is memoised per object identity (`WeakMap`) — in-place mutation returns stale
   results.
4. **CSS is global.** `src/editor/styles.css` defines generic class names (`.mid`, `.head`, `.warn`, `.row > label`,
   `.splitter` …). Lyrics code is scoped under `.lyricsscreen` and prefixes its classes (`lx-`, `vt-`); never reuse a
   bare generic name — it silently inherits layout from the old stylesheet.
5. **Units:** lyrics sheet = beats; project/renderer = seconds. Convert only through `SheetClock` (`clockOf(sheet)`)
   or the project `Tempo`.
6. **Persisted UI sizes / preferences** use `usePersistedSize` or the `PERSIST` list in `lyrics/state.ts`
   (localStorage, always try/catch, UI must work without it).
7. **Server changes** need an editor restart; keep endpoints under the existing prefixes and return JSON via `send`.
8. **Secrets:** never read, print or commit `.env`. Don't send user data (including the user's email) to external
   services other than the configured AI/stock providers.
9. **Downloads and network fetches** (CMUdict, stock footage) happen only via the existing scripts/endpoints and
   only when the user has asked for them.
10. **Verify:** `npm run typecheck` must pass. Pure `src/core` logic can be exercised with `tsx` scripts; UI changes
    should be checked in the browser (`npm run edit -- <project>`) — typecheck does not prove layout.
11. **Don't commit** unless asked; the working branch is `master`.

## 8. Where to start for common tasks

| Task | Start at |
|---|---|
| New generator / visualizer | `src/gen/registry.ts`, `src/gen/types.ts`, an existing entry in `visualizers.ts` |
| New layer parameter or modulation source | `src/core/params.ts`, `src/core/types.ts` (`ModSource`) |
| New storyboard AI feature | `server/ai.ts`, `server/storyApi.ts`, `src/editor/storyActions.ts` |
| New lyrics metric / finding rule | `src/core/lyricMetrics.ts` (`RULES`), `design/lyrics.md` §6 |
| New lyrics chat tool | `server/sheetApi.ts` (tool table + `SYSTEM` prompt), `src/editor/lyrics/Chat.tsx` |
| New timeline lane in the lyrics stage | `src/editor/lyrics/VTimeline.tsx` (`LANES`), `state.ts` (`Lane`) |
| Project schema change | `src/core/types.ts`; keep old projects loading (default/migrate on read) |
