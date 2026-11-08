# Lyrics stage — design plan

Status: draft, nothing locked. Sections marked **(idea)** are proposals beyond the original brief.

## 1. What this is

A dedicated **Lyrics** stage (a new top-bar mode next to Storyboard / Edit, `Mode = 'lyrics'`) for writing a song
*before* it exists and then lining it up with the song once it's produced:

1. Block out the song structure (verses, choruses, gaps) on a vertical timeline, in bars, at a planned BPM.
2. Write and edit the lyrics next to it, with directions (`[whisper]`, `[building intensity]`) parsed and coloured.
3. Paint arrangement / performance **layers** (labels such as `male`, `female`, `intense piano`) along the timeline.
4. Tag words (replace / keep / custom notes) and use an AI chat that can see all of this to rewrite parts.
5. Export a prompt for the song generator (style + lyrics with directions).
6. Once a song comes back: seed from or align to the Whisper transcript, and keep editing.
7. Save and switch between versions in a **library**.

The workflow implies that `[whisper]` / `[Chorus]` style tags are meant for an AI music generator. The design treats
"compile to a generator prompt" as a first-class output (§9).

## 2. Core idea: musical time first, seconds second

Everything on the lyrics timeline is stored in **beats**, not seconds:

- Before a song exists, beats → seconds comes from the **planned tempo** (the BPM field plus the BPM layer).
- After a song exists, beats → seconds comes from the **song tempo map** (`project.tempo`, from analysis, user-fixable).
  Word-level truth comes from alignment (`project.lyrics`).

This makes a BPM tweak behave correctly: blocks keep their bar lengths and only the duration changes. Adding a 2-bar
pause also stays a 2-bar pause whatever the tempo.

## 3. Data model

New `project.sheet` (working copy, undoable through `store.edit`). Versions live outside the project file (§10).

```ts
interface LyricSheet {
  style: string;                 // global style prompt (genre, voice, mood, production); also AI context
  meter: { bpm: number; beatsPerBar: number };   // the BPM field at the top
  tempo: TempoSpan[];            // BPM layer: overrides over beat ranges (optional ramps)
  blocks: Block[];               // verse blocks, ordered by `at`
  tracks: Track[];               // layer columns
  labels: Label[];               // label vocabulary (shared by tracks + word tags)
  tags: WordTag[];               // word-level replace/keep/notes
  linkedFrom?: string;           // version id this working copy was loaded from
}

interface Block {
  id: string;
  kind: 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'outro' | 'break' | 'custom';
  name: string;                  // "Verse 2", "Chorus"
  at: number;                    // start, beats from song start
  len: number;                   // length in beats (bars × beatsPerBar)
  lines: Line[];
  linkId?: string;               // (idea) linked repeats: all blocks with the same linkId share `lines`
  color?: string;
}

interface Line {
  id: string;                    // stable: survives edits, alignment and versions
  text: string;                  // raw text incl. inline directions, e.g. "[whisper] hold me close"
  kind: 'lyric' | 'direction' | 'adlib';   // derived by the parser, kept for fast rendering
  beats?: number;                // planned length inside the block; undefined = share the rest evenly
}

interface TempoSpan { at: number; len: number; bpm: number; ramp?: boolean }

interface Track {
  id: string;
  name: string;                  // "Vocals", "Piano", "Energy"
  mode: 'channel' | 'mixed';     // channel: one label, spans mean on/off. mixed: each span carries a label set
  label?: string;                // channel mode
  spans: { id: string; at: number; len: number; labels: string[] }[];
}

interface Label { id: string; name: string; color: string; group?: 'voice' | 'instrument' | 'dynamics' | 'mood' | 'fx' }

interface WordTag {
  id: string;
  line: string;                  // Line.id
  from: number; to: number;      // char offsets into Line.text
  kind: 'replace' | 'keep' | 'note';
  label?: string;                // custom annotation label id, or free text
  note?: string;                 // "too cliché", "rhyme with 'fire'"
}
```

Relationship to what already exists:

- `storyboard.brief.lyrics` (plain/LRC text) becomes **derived**: `sheetToText(sheet)` writes it, so the storyboard
  planner keeps working unchanged. Migration: when a project has `brief.lyrics` but no `sheet`, parse it into one.
- `project.lyrics` (word timing) stays the timing truth after a song exists. `LyricLine` gets an optional
  `sheetLine?: string` back-reference so alignment output maps back onto sheet lines, tags and blocks.
- Channel vs mixed tracks cover both requested styles: split channels (`male` | `female` as two columns), or one
  combined layer whose spans carry several labels. Two conversion ops: **Split by label** (mixed → one channel per
  label) and **Merge tracks** (channels → mixed, spans unioned and cut at boundaries).

## 4. Layout

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│ BPM [ 92 ] 4/4   ≈ 3:42 (incl. 0:18 gaps)   target [3:30] +0:12   Style ▾   ⌸ Library   ↗ Export│
├───────────────────────────────────────────┬─────────────────────────────────┬─────────────────┤
│ LYRICS (scrolls)                          │ TIMELINE (vertical, time ↓)     │ AI CHAT          │
│                                           │ bar│Blocks │BPM│Vocals │Piano   │                  │
│ ▌Verse 1                       8 bars     │  1 ┌──────┐   │▒male  │        │ context: Verse 1 │
│   I walked out in the cold [whisper]      │    │Verse1│92 │▒      │░soft   │ L3–L4 · 2 tags   │
│   streetlights humming low                │  5 │      │   │▒      │░       │ layers: male,    │
│   (ooh)                                   │    └──────┘   │       │        │  soft piano      │
│   ┄┄ 2 bar gap ┄┄                         │  9 ┄┄gap┄┄    │       │        │                  │
│ ▌Chorus                        8 bars     │ 11 ┌──────┐   │▒male  │▓intense│ > make L3 less   │
│   [building intensity]                    │    │Chorus│96 │▒female│▓       │   literal, keep  │
│   ...                                     │    └──────┘   │       │        │   "cold"         │
│                                           │                ↑ playhead/center line              │
└───────────────────────────────────────────┴─────────────────────────────────┴─────────────────┘
```

- Lyrics column on the left. The vertical timeline sits to its right, columns: bar ruler, **Blocks**, **BPM**, then
  one column per track. AI chat on the far right (collapsible, resizable with the existing `Resizer`).
- Reuse the existing pane-size persistence (`usePersistedSize`) and the editor's dark theme tokens.

## 5. The vertical timeline

**Zoom/scroll:** wheel scrolls, ctrl/⌘ + wheel or pinch zooms around the cursor (same feel as `useZoomPan`, along
one axis). The zoom unit is **px per beat**. Bar lines are always drawn; beat ticks appear once zoomed in.

**Blocks column**

- Drag a block body to move it. By default this **ripples**: later blocks move with it, so the gap before it
  changes. Alt-drag moves only this block (it can't overlap neighbours; it eats into their gaps).
- Drag the bottom edge to change length (snaps to bars; Shift = beats).
- Gaps are just the empty space between blocks. Shown as a hatched "pause" with its length in bars; drag it to resize
  (ripple). Right-click a gap: "Insert 1/2/4 bars", "Remove gap".
- Drag a block from its handle onto another position to **reorder** (swap order, keep lengths).
- Double-click empty space to create a block there. Duplicate (Ctrl+D) offers "linked copy" for choruses (idea).
- Inside a block, faint line dividers show planned line lengths. Drag a divider to give one line more time
  (sets `Line.beats`).

**Track columns**

- Drag in empty space to draw a span. In a channel track it's the track's label. In a mixed track the label picker
  pops up with recent labels first. Snaps to bars or block edges; Shift = beats, Alt = free.
- Drag a span to move it, drag its edges to trim. Drag across the column with a label "brush" active to paint
  (quick fill across several blocks).
- **Paint mode (idea):** pick a label in the palette, then drag down any column to paint it. Drag over an existing span
  of the same label to erase.
- Multi-select spans (box drag with Shift) to move them together. Delete removes them.
- "Fill block" from a block's context menu: span exactly covering that block on the chosen track.

**BPM column**: shows the planned tempo. Drag in it to create a tempo span (`TempoSpan`), and type or drag the value.
A ramp toggle interpolates to the next span. The top-bar BPM is the default for anything without an override.

**Estimated duration** (top bar): `seconds(lastBlock.at + lastBlock.len)` through the tempo spans, with the share
that's gaps. **(idea)** An optional *target length* shows over/under, and "fit" offers to scale gaps or BPM to hit it.

## 6. Lyrics ↔ timeline sync

Two layout regimes, chosen by zoom:

- **Locked** (zoomed in): each lyric line is absolutely positioned at its time on the timeline's vertical axis, and
  block headers sit at block starts. Lyrics and timeline share a single scroll.
- **Flow** (zoomed out): lyrics are a normal document that scrolls on its own. The timeline follows so the line at the
  lyrics viewport's **centre** sits at the timeline's centre line, and timeline scroll moves the lyrics the other way.

**Switching rule:** locked while every visible line gets at least its rendered height in timeline pixels, i.e.
`min(lineBeats × pxPerBeat) ≥ lineHeight` over the visible lines (with a little hysteresis). Otherwise flow.

**(idea) No jump at the switch:** blend between the two layouts over a short zoom range: `y = lerp(flowY, lockedY, k)`.
In flow mode, draw thin connector curves from each line (or block header) to its time span on the timeline, like a
side-by-side diff. That keeps the mapping readable even when they don't line up.

When a song exists, playback highlights the current line and word (from `project.lyrics`), and in flow mode
auto-scrolls the lyrics to keep it centred.

## 7. Editing lyrics

**Click to edit in place.** Clicking a line turns its **block** into a multi-line editor with the caret at the clicked
character:

- Use a `<textarea>` over a **mirror div** (the "highlight-within-textarea" technique). The textarea has transparent
  text and a visible caret. The mirror underneath renders the same text with direction colours and tag underlines.
  Font, size, letter-spacing, line-height, padding, wrapping (`white-space: pre-wrap`) and width are shared through
  one CSS class, so entering edit mode only changes the caret.
- Caret placement: `document.caretPositionFromPoint` (Firefox) / `caretRangeFromPoint` (Chromium) on the static
  render. Map the DOM offset to a block text offset, then `setSelectionRange`.
- In **locked** mode the lines are spread out in time, which a textarea can't show. While editing, that block
  temporarily switches to flow spacing, anchored at its start, and goes back on commit. (Open question: alternatively
  pad with blank lines to approximate positions.)
- Commit on blur / Esc / Ctrl+Enter. Each commit is one undo step. Line ids are kept by diffing old and new lines
  (an LCS on line text, unchanged lines keep ids, edited lines keep the id of the line they replaced, new lines get new
  ids). Tags are rebased on char offsets through the same diff, and a tag whose text was deleted is dropped (listed in
  the undo toast).

**Paste full lyrics.** Pasting multi-line text into an editor, or into **Raw view** (a whole-song textarea toggle),
runs the parser:

```
[Verse 1]                      → block header (kind from vocabulary, name kept)
I walked out [whisper] cold    → lyric line with inline direction
[building intensity]           → direction line (own line, not a section name)
(ooh, ah)                      → adlib / backing line
Verse 2:  /  VERSE 2           → also block headers
blank line(s)                  → line/stanza break; 2+ blank lines inside a block = soft split suggestion
[00:12.40] text                → LRC timestamp: kept as a timing hint (seeds `at` if the song exists)
```

Extend the existing `parseLyricsText` in `src/core/lyrics.ts` rather than writing a second parser. It already knows
section headers and LRC stamps. New block lengths default to `ceil(lines / 2) × 2` bars (2 bars per line, rounded to
even bars). **(idea)** A syllable count could set this better (§12).

**Direction colours** (parser assigns a category, the label vocabulary can override):

| category | examples | style |
|---|---|---|
| section | `[Chorus]`, `[Bridge]` | block header, block colour |
| performance | `[whisper]`, `[spoken]`, `[belt]`, `[falsetto]` | violet chip |
| dynamics | `[building intensity]`, `[drop]`, `[quiet]` | amber chip |
| instrument | `[piano solo]`, `[guitar break]` | teal chip |
| adlib | `(ooh)`, `(yeah)` | dimmed italic |
| unknown | anything else in `[]` | grey chip |

## 8. Word tags

- Outside edit mode, dragging across the lyrics selects **whole words** (selection snaps to word boundaries).
  Double-click selects one word.
- A floating toolbar appears on the selection: **Replace** · **Keep** · **Note…** · recent custom labels · **Ask AI**.
- Rendering: replace = dashed red underline, keep = solid green underline plus a lock glyph on hover, note/custom =
  label-coloured underline with a superscript dot. Hovering shows the note.
- A **Tags** list (filter chip in the lyrics header) shows all tags. Click one to jump to it.
- Semantics for the AI: `replace` = "change this", `keep` = hard constraint (proposals that change kept text are
  rejected client-side and shown as violations), `note` = context.

## 9. AI chat

A chat panel on the right that works through **tools** over the current sheet. It doesn't paste the whole song into
every prompt.

**Context sent each turn (small, always):** the style, the meter/duration, the *focus* (current selection, or the
block under the caret or the timeline centre) with the layers overlapping it, and the tags in focus.

**Read tools** (served from a snapshot of the sheet the client posts with the message):

| tool | returns |
|---|---|
| `get_selection` | selected text, line ids, block, surrounding lines |
| `get_lyrics(range?)` | full sheet text (or a block / beat range) with line ids and inline directions |
| `get_structure` | blocks with kinds, bars, gaps, seconds |
| `get_layers(range)` | track spans overlapping a beat range, by label |
| `get_tags(range?)` | word tags with kinds and notes |
| `get_style` | global style prompt |
| `get_versions` / `get_version(id)` | library entries (for "go back to how the chorus was in v3") |
| `count_syllables(lines)` (idea) | per-line syllables and stress pattern, for meter-preserving rewrites |

**Write tools** return **proposals**. They never mutate directly:

- `propose_lines([{ lineId, text }])`: replace lines (shown as an inline diff on the lyrics, accept/reject per line)
- `propose_alternatives({ target, options[] })`: N variants for the selection; cycle them inline (Alt+[ / Alt+])
- `propose_blocks(ops)`: add / remove / move / resize blocks, insert gaps
- `propose_spans(ops)`: add / change layer spans
- `propose_tags(ops)`, `propose_style(text)`

Accepting a proposal is one undo step, and the first accept after a chat turn auto-snapshots the previous state into
the library ("before AI: make L3 less literal").

**Example queries:** "change these to something less literal", "rewrite verse 2 to rhyme ABAB and keep the meter",
"suggest where the female voice should come in", "make the bridge 4 bars shorter and tighten the lines",
"give me three hooks for the chorus".

**Server:** `server/ai.ts` currently only does one-shot JSON completions. Add `chat()` with a Claude tool-use loop
(read tools resolve server-side against the posted snapshot, write tools end the turn and come back as proposals).
Stream through the existing AI-log run mechanism so chat runs appear in the AI log tab like other runs. Claude first.
OpenAI tool calling can be adapted later behind the same `LLMProvider` switch.

**Chat history** is kept per version (`sheet` working copy → `lyrics/chat.json`), so reopening the project keeps the
thread. "New thread" clears it.

## 10. Library (versions)

- Panel (drawer from the top bar): a list of versions with name, time, source (`manual`, `before AI …`,
  `from transcript`, `aligned to take 2`), a one-line diff summary, and an optional linked audio take.
- **Save version** (Ctrl+S in this stage: name prompt, default "v4"), **Switch** (loads into the working copy and
  auto-saves the current one if dirty), **Duplicate / branch**, **Rename**, **Delete**, **Compare** (two versions
  side by side, line-level diff plus structure diff).
- Storage: `<song folder>/lyrics/versions/<id>.json` (user content, so not in `_mvgen/`, which is regenerable) plus
  `lyrics/index.json`. The working copy stays in `mv.project.json` → `sheet`.
- **(idea) Takes:** a generated song (`song.wav`, `song-take2.wav`, …) can be linked to the version it was made from,
  so it's clear which lyrics produced which audio, and switching takes offers to switch the lyrics version too.

## 11. After the song exists

**Seed from Whisper** (no sheet yet, or "new version from transcript"):
`fromTranscript()` → lines → blocks split at instrumental gaps longer than ~1 bar. **(idea)** Detect repeated line
groups to label choruses and offer to link them. Block `at`/`len` are converted from seconds to beats through the song
tempo map and snapped to bars.

**Align sheet to song** (sheet exists): `sheetToText()` → existing `alignLyrics()` (extended to carry `sheetLine` ids)
→ `project.lyrics`. Then:

- Block `at`/`len` move to the aligned first/last word (snapped to bars, Shift-click to keep unsnapped).
- The **planned** layout stays visible as a ghost outline, so drift between plan and song is visible.
  "Adopt song timing" moves the plan to match, and that's undoable.
- Tags, directions and layer spans are kept because they're keyed by line id / beats.
- Everything stays editable. Editing a line's text marks its words stale (hatched), and **⇄ Re-align** reuses the
  stored transcript without a new API call (existing flow).
- Track spans are in beats, so they follow the song tempo map automatically. Offer "snap spans to block edges" after
  alignment.

**Prerequisite:** `scripts/edit.mjs` throws when the folder has no audio. A lyrics-first project needs a no-audio mode:
skip analysis and give the project a nominal duration from the sheet. The player/waveform then show an empty state, and
the Lyrics stage plays a **click track** at the planned tempo **(idea)** so pacing can be checked by reading along.

## 12. Extra ideas (not in the brief)

- **Compile view / export:** render the generator prompt. The style goes in the style field, the lyrics get section
  headers, and layers compile into section directions, e.g. `[Chorus | male + female vocals, intense piano]`. Inline
  directions are kept. Show character counts against configurable limits, and a one-click copy for each field.
  Layers become useful even before there's audio.
- **Linked repeats:** choruses as linked blocks (edit one and all update). "Unlink" to vary the last chorus.
- **Meter gutter:** syllable count per line plus a rhyme-scheme letter (A/B/…), computed client-side (CMU-dict-style
  heuristic). It shows when verse 2 doesn't scan like verse 1, and gives the AI a concrete target.
- **Energy curve track:** a track type drawn as a curve (0–1) instead of spans, which compiles to dynamics directions
  and later feeds the storyboard planner's energy per section.
- **Structure templates:** "Verse–Chorus–Verse–Chorus–Bridge–Chorus" at N bars each, to block out a song in one click.
- **Downstream reuse:** blocks become storyboard sections and cues, and labels become shot tags, so the storyboard
  planner knows "female enters here, intense piano".
- **Keyboard:** ↑/↓ moves the focus line, Enter edits, Esc commits, Alt+↑/↓ moves a line between blocks, B inserts a
  block break at the caret, G inserts a 1-bar gap after the focused block.

## 13. Build order

1. **Model + parser + flow view**: `src/core/sheet.ts` (types, parse, `sheetToText`, beats↔seconds via tempo
   spans), migration from `brief.lyrics`, Lyrics mode with a static lyrics column, direction colours.
2. **Inline editor**: textarea-over-mirror, caret placement, line-id-preserving diff, paste parsing, Raw view.
3. **Vertical timeline**: ruler, blocks (move/ripple/resize/gaps/reorder), BPM field + BPM column, duration estimate.
4. **Sync**: locked/flow regimes, centre-line coupling, blend + connectors.
5. **Tracks + labels**: channel/mixed tracks, draw/move/trim/paint, split/merge.
6. **Word tags**: word-snapped selection, toolbar, rendering, rebase on edit.
7. **Library**: versions on disk, save/switch/branch/compare.
8. **AI chat**: server tool loop, proposals as diffs, auto-snapshots.
9. **Song link**: no-audio projects, seed from transcript, align with `sheetLine` ids, plan ghost, re-align.
10. **Compile/export**, linked repeats, meter gutter, energy track, click track.

Steps 1–4 give a usable writing and blocking tool. Each later step is independent enough to reorder.

## 14. Open questions

- In locked mode, should editing keep the time spacing (blank-line padding) or collapse to flow spacing as proposed?
- Should ripple be the default for block drags, or should free move be the default with ripple on a modifier?
- Should a line be able to straddle a block boundary (pickup notes into a chorus), or are lines always inside a block?
- Is there one global style, or per-block style overrides that also compile into the prompt?
- Which song generator(s) should the export target first? This decides tag syntax and length limits.
- Should the AI chat be allowed to write directly in a "trusted" mode, or always go through proposals?
- Do tracks need a fixed order and colour per label across versions (shared vocabulary), or per version?
