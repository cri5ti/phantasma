# Lyrics stage — specification

Status: implemented (editor, timeline, chat, library, song link, measurements). Written from the two earlier plans;
those are folded in here and removed. Not yet exercised end-to-end in a browser by the author of this document, and
the pronunciation dictionary (CMUdict) is optional and not installed by default (§5.2).

Parent: `design/architecture.md`. Code: `src/editor/lyrics/*`, `src/core/{sheet,lyricMetrics,phonetics,lyrics}.ts`,
`server/sheetApi.ts`.

## 1. Purpose

A stage (`Mode = 'lyrics'`) for writing a song **before it exists**, and lining it up with the produced song after:

1. Block out the structure (verses, choruses, gaps) on a vertical timeline, in bars, at a planned BPM.
2. Write lyrics next to it, with directions (`[whisper]`, `[building intensity]`) parsed and coloured.
3. Paint arrangement **layers** (labels like `male`, `intense piano`) and an **energy curve** along the timeline.
4. Tag words (replace / keep / note) and talk to an AI that sees all of it and proposes edits.
5. **Measure** the lyrics (rhythm, rhyme, repetition, sound, meaning) and show it where you write.
6. Export a prompt for a song generator (style + lyrics with directions and layers).
7. When the song comes back: seed from or align to the transcript, compare plan vs sung, keep editing.
8. Keep named **versions** in a library.

## 2. Core ideas

- **Musical time first.** Everything on the sheet is in **beats**. Before a song exists beats→seconds uses the planned
  tempo (`bpm` + BPM layer); after, it uses the song's tempo map (`songTempo`). A BPM change keeps bar lengths and only
  changes durations. `clockOf(sheet)` (`SheetClock`) is the only converter.
- **A profile, not a score.** Metrics are amounts ("more / less of"), never grades. Findings flag **mismatches**
  (with the tempo, a sibling section, or a target the user set) — a sparse chorus and a dense verse are both fine.
- **Sequences over averages.** Per-line sequences (`[8,8,9,8]`, `AABB`, stress strings) are the primary data.
- **Local, instant, free vs AI, on request.** Objective metrics are pure functions in `src/core`, memoised per sheet.
  Subjective ones (emotion, imagery, cliché) come from the AI only when asked and are cached by text hash.
- **We know the music.** Text × time metrics (syllables per beat, breath, stress on beats, held notes) are the point.
- **The AI proposes; the user decides.** Write tools never mutate the sheet.

## 3. Data model (`src/core/types.ts`)

```ts
interface LyricSheet {
  style: string;                  // global style prompt (also AI context + export)
  bpm: number; beatsPerBar: number; offset?: number;   // base tempo; seconds at beat 0
  tempo: TempoSpan[];             // BPM layer: overrides over beat ranges
  blocks: SheetBlock[];           // ordered by `at`
  tracks: SheetTrack[];           // arrangement layers + energy curve
  labels: SheetLabel[];           // shared vocabulary (tracks + tags)
  tags: WordTag[];
  target?: number;                // target length (s)
  songTempo?: boolean;            // tempo taken from the produced song
  version?: { id: string; name: string };
  lint?: LintOpts;                // finding rules on/off + thresholds, strict meter
  targets?: Partial<Record<BlockKind, SectionTarget>>;
  exportOpts?: { layers; gaps; energy; styleLimit; lyricsLimit };
}
interface SheetBlock { id; kind: BlockKind; name; at: number; len: number;      // beats
                       lines: SheetLine[]; link?: string; color?: string; shape?: BlockShape }
interface SheetLine  { id: string; text: string; beats?: number }                // stable id; text has inline [directions]
interface SheetTrack { id; name; kind: 'channel' | 'mixed' | 'energy'; label?; spans: SheetSpan[]; points?: {at, v}[] }
interface WordTag    { id; line: string; from: number; to: number; kind: 'replace'|'keep'|'note'; label?; note? }
```

- `Line.id` is stable across edits, alignment and versions; tags, spans and alignment hang off ids/beats.
- `link` makes blocks with the same id **linked repeats** (they share lines; editing one updates all; "unlink" to vary).
- **Channel** track = one label, spans mean on/off. **Mixed** = each span carries a label set. **Energy** = a 0..1 curve.
  Split-by-label and Merge-tracks convert between channel and mixed.
- `storyboard.brief.lyrics` is **derived** from the sheet (`sheetToText`) on every edit. `project.lyrics` (word timing)
  stays the timing truth after a song exists; `LyricLine.sheet` back-references sheet lines.
- Versions are stored outside the project file: `<project>/lyrics/versions/<id>.json` (+ profile), chat in
  `lyrics/chat.json`, AI meaning cache in `_phantasma/lyrics-analysis.json`.

## 4. The editor

### 4.1 Layout

Header (bpm, meter, duration vs target, Templates, Raw, Style, Tags, Song ▾, play, zoom, meter / sound toggles,
Analysis, Library, Export, Chat, Keys) over: **lyrics pane | splitter | vertical timeline | splitter | chat**.
Both splitters are draggable and persisted, double-click resets. The first one resizes the **blocks column** (the
lyrics pane takes what's left, never below ~320 px); the second resizes the chat, which gives way first.

### 4.2 Vertical timeline (`VTimeline.tsx`)

Time runs down, unit = px per beat (wheel scrolls, ctrl/⌘+wheel zooms). Columns, left to right: link connectors, bar
ruler, **blocks**, **BPM**, aligned-song lane `♪` (when aligned), analysis lanes, one column per track, ＋.

- **Blocks:** drag to move (ripples later blocks; Alt = this block only); bottom edge = length (bars; Shift = beats);
  gaps are hatched and draggable; ⠿ reorders; double-click empty space makes a block; line dividers inside a block set
  `Line.beats`.
- **Tracks:** drag to draw spans (snap to bars/block edges; Shift = beats, Alt = free); drag/trim spans; brush
  painting; Alt-drag erases; energy tracks are drawn as a curve (left = low).
- **BPM column:** drag to make tempo spans; ramp toggle.
- **Analysis lanes** (toggle from the ＋ menu or a lane header): **wave** (the song's loudness, needs audio),
  **density** (syllables/second heat), **breath** (unbroken sung stretches, red when too long), **hooks**, **emotion**
  (AI: valence colour, intensity width; compare with the energy curve). Defaults: density + breath.
- **Song ▾ → Set energy from the sound:** replaces the energy curve with the song's loudness (one point per beat,
  smoothed, normalised to the loud parts) — one undo step. Implemented in `lyrics/sound.ts` (`loudness`, `energyFromSound`).
- The playhead is the song when it plays, else the click track.

### 4.3 Lyrics pane and sync (`SheetView.tsx`)

- **Locked** (zoomed in): each line sits at its time on the timeline's axis and both scroll together. **Flow**
  (zoomed out): the lyrics scroll as a document, centred on the timeline's centre line, with connector curves. The
  header badge shows `locked` / `blend` / `flow`; the layouts blend over a short zoom range so nothing jumps.
- **Click to edit:** a block becomes a textarea over a mirror div (identical font metrics) with the caret at the
  click point; commit on blur / Esc / Ctrl+Enter = one undo step. Line ids survive edits through an LCS diff
  (`matchLines`); tags are rebased on char offsets (`rebaseTag`) and dropped when their text is gone.
- **Paste / Raw view** runs `parseSheetText` (extends `parseLyricsText`): `[Verse 1]` headers, `[direction]` lines,
  `(adlib)`, blank lines, LRC stamps as timing hints. New blocks default to ~2 bars per line.
- **Directions** are classified (`dirCategory`): section, performance, dynamics, instrument, adlib, unknown — each a
  chip colour.
- **Word tags:** drag selects whole words → toolbar (Replace / Keep / Note / Ask AI). `keep` is a hard constraint for
  AI proposals (violations are shown); `replace` = change this; `note` = context.
- **Keyboard:** ↑/↓ focus line, Enter edit, Space play, Ctrl+Z/Y, Ctrl+S save version, Ctrl+C/V/D blocks,
  Alt+[ / ] cycle alternatives, F analysis, S sound view; `?` lists all.

## 5. Measuring lyrics

### 5.1 Principles in code

`analyzeSheet(sheet, { sung, sem })` (`src/core/lyricMetrics.ts`) is memoised per sheet object (sheets are immutable)
and returns per-line, per-block and per-song data plus **findings**. Per-text work is cached by text hash.

### 5.2 Pronunciation (`src/core/phonetics.ts`)

ARPAbet pronunciations: **CMUdict** when `data/cmudict.json` exists (served at `/api/sheet/cmudict`, created by
`node scripts/cmudict.mjs`, ~3.6 MB download — only when the user asks); otherwise a built-in list of common lyric
words plus letter-to-sound rules, marked **estimated** (`est`). English only. Provides syllable counts, stress,
rhyme tail (from the last stressed vowel), rhyme quality (`perfect | slant | assonance | consonance | identity`),
held-note suitability (`sustainOf`: closed = lax vowel + obstruent) and a "respell" for AI text.

### 5.3 What is measured

| Area | Measures |
|---|---|
| Structure | section sequence (`I V1 C …`), bars/lines per section, symmetry with sibling sections, time to first chorus |
| Rhythm | syllables per line / beat / second; **sung-time model** (eighth-note pace capped by the planned line length → rest, breath runs, held notes); stress strings; meter drift vs the first section of the same kind |
| Rhyme | letters per block (union-find over perfect/slant/identical), per-pair quality, internal and multisyllabic rhymes, rhyme distance/diversity; arcs in the gutter and a **sound view** tinting rhyme families (S) |
| Repetition | repetition ratio, lexical diversity, **hooks** (recurring 2–8-word n-grams, dedup'd), near-duplicate sections (suggest *link*), chorus consistency, anaphora |
| Sound | sustain (closed vowel on a long note), articulation load, plosive/sibilance share, vowel openness |
| Language | pronouns / perspective shifts, tense |
| Meaning (AI) | per-line valence + intensity, emotion words, imagery/concreteness, narrative role + summary, clichés with reasons, coherence with the style prompt |
| After the song | real density, rests, breath, stress-on-beat share, **plan vs sung** per block (rushed / stretched / dropped) |

### 5.4 Findings

Lint-style rules in the registry `RULES` (id, category, default on/off, threshold). **On by default:** `dense`,
`breath`, `meter-drift`, `near-dup`, `shape`, `target`, `cliche`, `sung`. Opt-in: `stress-drift`, `rhyme-break`,
`sustain`, `articulation`, `sibilance`, `perspective`, `tense`, `sung-stress`. Rules and thresholds are per sheet
(`lint`); "strict meter" (`lint.strict`) is global and makes AI proposals that break the shape an error instead of a
badge. Findings list lives in the **Analysis drawer** (F): click jumps to the line; a "Link" fix appears for
identical unlinked sections.

### 5.5 Views

- **Gutter** (meter): per-line heat bar, syllables (actual / target), rhyme letter, finding dot, detail tooltip.
- **Profile card** (hover a block header): sequences + a six-axis radar (syllable consistency, rhyme density,
  repetition, phonetic flow, imagery, narrative) — labelled *amounts*.
- **Analysis drawer tabs:** findings (+ rule settings), profile (+ *Analyse meaning*), shape, targets ("Pop defaults"),
  song scorecard (section sequence, hook stats, per-block table).
- **Fingerprint** (`fingerprint`, `profileSummary`, `profileDelta`): the structured shape of a song/block. Saved with
  every library version; the Library's Diff shows the text diff plus the profile delta.
- **Reference shape:** paste a lyric you like the feel of → only its fingerprint is extracted (text not stored) and
  laid out as blocks with per-line syllable/rhyme/stress targets (`SheetBlock.shape`); the gutter shows target vs actual.
- **Section targets:** per `BlockKind` (`maxDensity`, `minRepetition`, `openEnds`).

### 5.6 AI meaning analysis

One structured call per changed block (`/api/sheet/analyze`, batches of 10, JSON schema `SEM_SCHEMA`), cached by
`blockHash` in `_phantasma/lyrics-analysis.json`; runs **only on request**; unchanged blocks cost nothing. Logged in the AI log.

## 6. AI chat (`Chat.tsx`, `server/sheetApi.ts`)

The server runs the tool loop on Claude (Messages API, streamed, adaptive thinking, append-only history) or OpenAI
(Responses API, `previous_response_id`). Each turn sends a small context: style, meter/duration, the **focus**
(selection / block under the caret / timeline centre) with overlapping layers, tags in focus, its target shape,
targets and warnings, and optionally the sung lines.

- **Read tools:** `get_selection`, `get_lyrics`, `get_structure`, `get_layers`, `get_tags`, `get_style`,
  `list_versions`, `get_version`, `check_lines`, `analyze_block`, `get_findings`, `get_hook`.
- **Write tools (proposals only):** `propose_lines`, `propose_alternatives` (cycle with Alt+[ / ]), `propose_blocks`,
  `propose_layers` (incl. energy ramps), `propose_tags`, `propose_style`.
- `propose_lines` / `propose_alternatives` are checked with `checkEdits` against the target shape → **badges**
  (`8 → 9 syl`, `rhyme B ✗`, `closed vowel on long note`) or, in strict meter, an error the model must correct. A
  corrected proposal for the same lines in the same turn **supersedes** the earlier one.
- Accepting is one undo step; the first accept after a turn **auto-snapshots** the previous state into the library
  ("before AI: …"). `keep` tags reject proposals that change kept text.
- The system prompt says metrics are profiles: keep the shape unless asked, and say so when trading meter for meaning.
- Thread is stored per project; "New thread" clears it. Every turn is an `AiRun` in the AI log.

## 7. Library (versions)

Drawer from the header: name, time, source (`manual`, `before AI …`, `from transcript`, …), profile summary.
Save (Ctrl+S), Switch (auto-saves a dirty working copy), Duplicate, Rename, Delete, Compare (line diff + structure
diff + profile delta). Files: `lyrics/versions/<id>.json`, working copy in `mv.project.json → sheet`.

## 8. Export

`compileExport` renders the generator prompt: style field, lyrics with section headers, layers compiled into section
directions (e.g. `[Chorus | male + female vocals, intense piano]`), inline directions kept, energy compiled to
dynamics words (option). Character counts against configurable limits (`exportOpts`) and a copy button per field.
Target generator and exact tag syntax are open (§11).

## 9. Song link

- **No-audio projects** are first-class: duration comes from the sheet, playback is a **click track** at the planned
  tempo (read along to check pacing).
- **Seed from the transcript** (`blocksFromTimed`): lines → blocks split at gaps over ~1 bar, times converted through
  the song tempo map and snapped to bars. **Seed from aligned lyrics** likewise.
- **Align** (`Song ▾`): `sheetToText` → `alignLyrics` (carries sheet line ids) → `project.lyrics`; blocks move to the
  aligned first/last word; the **planned layout stays as a ghost** so drift is visible; **Adopt song timing** moves the
  plan to match (undoable); **Use song tempo** takes the analysed tempo map. Tags, directions and spans survive
  (keyed by id / beats). **Re-align** reuses the stored transcript, no API call.
- **Set energy from the sound** and the **wave** lane use `AudioData` scalars (`rms`).
- Optional later: link generated takes (`song-take2.wav`) to the version that produced them.

## 10. Persistence and state

- Working sheet: `project.sheet` via `editSheet` (one undo step per edit; `merge` coalesces drags).
- UI state (`lyrics/state.ts`): zoom, centre, selection, focus, panel, lanes, sound/meter, chat open — a subset is
  persisted to localStorage (`PERSIST`); pane sizes via `usePersistedSize` (`lyrics-chat`, `lyrics-blocks`).
- The AI meaning cache is mirrored client-side (`analysis.ts`: `useSem`, `syncSem`, `runMeaning`).

## 11. Not built / open questions

- **Language:** heuristics and CMUdict are English-only. Fall back to vowel-group syllables, or an IPA/phonemizer?
- **CMUdict bundle:** ~3.6 MB raw (~1 MB gzipped as a compact table), loaded lazily only in this stage — commit
  `data/cmudict.json` or gitignore it and fetch via the script?
- Should meaning analysis ever run automatically on block change (token cost)? Current: on request only.
- Should strict meter be per block rather than global?
- In locked mode, should editing keep time spacing instead of collapsing to flow spacing for the edited block?
- Should a line be able to straddle a block boundary (pickups into a chorus)? Currently lines live inside one block.
- One global style, or per-block style overrides that also compile into the prompt?
- Which song generator(s) does export target first (tag syntax, limits)?
- A "trusted" mode where the AI writes directly, or always proposals?
- Shared label vocabulary (fixed order/colour) across versions, or per version?
- Downstream reuse: blocks → storyboard sections/cues, labels → shot tags, energy → planner energy per section.
- Stress-on-beat **before** the song (spread syllables evenly over line beats) is approximate; accurate only after alignment.
