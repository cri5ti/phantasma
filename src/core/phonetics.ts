// Pronunciations for lyric metrics: ARPAbet phones + stress per syllable. CMUdict when it's loaded (setDict), else a
// built-in list of common lyric words, else letter-to-sound rules (marked `est`). English only. Pure, shared.

export interface Pron {
  /** ARPAbet phones without stress digits */
  ph: string[];
  /** stress per syllable: 0 none · 1 primary · 2 secondary */
  st: number[];
  /** estimated by rules (not from a dictionary) */
  est: boolean;
}

export const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
/** lax vowels: short, hard to hold on a long note when an obstruent closes them */
export const LAX = new Set(['AE', 'AH', 'EH', 'IH', 'UH']);
export const OBSTRUENT = new Set(['P', 'B', 'T', 'D', 'K', 'G', 'CH', 'JH', 'F', 'V', 'TH', 'DH', 'S', 'Z', 'SH', 'ZH']);
export const PLOSIVE = new Set(['P', 'B', 'T', 'D', 'K', 'G']);
export const SIBILANT = new Set(['S', 'Z', 'SH', 'ZH', 'CH', 'JH']);
const NASAL = new Set(['M', 'N', 'NG']);
const LIQUID = new Set(['L', 'R']);
const FRIC = new Set(['F', 'V', 'TH', 'DH', 'S', 'Z', 'SH', 'ZH', 'HH']);
const VOICED = new Set(['B', 'D', 'G', 'V', 'DH', 'Z', 'ZH', 'JH', 'M', 'N', 'NG', 'L', 'R', 'W', 'Y']);
/** how open (sustainable, bright) a vowel is, 0..1 */
export const OPENNESS: Record<string, number> = {
  AA: 1, AO: 0.9, AE: 0.9, AW: 0.9, AY: 0.85, OW: 0.7, OY: 0.7, AH: 0.6, EH: 0.6, EY: 0.55, ER: 0.5, UH: 0.3, IH: 0.25, UW: 0.2, IY: 0.15,
};

/** short function words: unstressed when sung unless the music says otherwise */
export const FUNCTION_WORDS = new Set((
  'a an the and or but nor of to in on at by for from with as into onto upon is am are was were be been being it its ' +
  'i me my you your he him his she her we us our they them their this that these those so if than then can could will ' +
  'would shall should do does did has have had not just like oh ah yeah im ive id ill youre youve youll were theyre ' +
  'thats its lets dont cant wont aint gonna wanna gotta til till cause up out off down over'
).split(' '));

export const normWord = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '').replace(/[^a-z0-9]/g, '');

// ---- dictionary ------------------------------------------------------------------------------------

let DICT: Map<string, string> | null = null;
let dictVersion = 0;
const cache = new Map<string, Pron>();

/** CMUdict as {word: "HH AH0 L OW1"} (first pronunciation). Clears the cache. */
export function setDict(d: Record<string, string> | Map<string, string> | null) {
  DICT = d ? (d instanceof Map ? d : new Map(Object.entries(d))) : null;
  dictVersion++;
  cache.clear();
}
export const hasDict = () => !!DICT;
/** bumps when the dictionary changes (memo keys) */
export const phoneticsVersion = () => dictVersion;

// common lyric words (CMUdict pronunciations) so the fallback gets the irregular ones right
const BUILTIN = Object.fromEntries((
  'i:AY1|im:AY1 M|ive:AY1 V|id:AY1 D|youre:Y UH1 R|youve:Y UW1 V|youll:Y UW1 L|were:W ER1|theyre:DH EH1 R|there:DH EH1 R|' +
  'their:DH EH1 R|where:W EH1 R|here:HH IY1 R|the:DH AH0|a:AH0|to:T UW1|do:D UW1|who:HH UW1|whose:HH UW1 Z|whole:HH OW1 L|' +
  'you:Y UW1|your:Y AO1 R|four:F AO1 R|pour:P AO1 R|are:AA1 R|one:W AH1 N|once:W AH1 N S|two:T UW1|eye:AY1|eyes:AY1 Z|' +
  'heart:HH AA1 R T|love:L AH1 V|above:AH0 B AH1 V|come:K AH1 M|some:S AH1 M|done:D AH1 N|none:N AH1 N|gone:G AO1 N|' +
  'give:G IH1 V|live:L IH1 V|have:HH AE1 V|move:M UW1 V|lose:L UW1 Z|prove:P R UW1 V|said:S EH1 D|says:S EH1 Z|' +
  'again:AH0 G EH1 N|been:B IH1 N|though:DH OW1|through:TH R UW1|thought:TH AO1 T|enough:IH0 N AH1 F|tough:T AH1 F|' +
  'rough:R AH1 F|laugh:L AE1 F|ocean:OW1 SH AH0 N|people:P IY1 P AH0 L|heaven:HH EH1 V AH0 N|fire:F AY1 ER0|' +
  'desire:D IH0 Z AY1 ER0|hour:AW1 ER0|our:AW1 ER0|flower:F L AW1 ER0|power:P AW1 ER0|every:EH1 V R IY0|' +
  'evening:IY1 V N IH0 NG|beautiful:B Y UW1 T AH0 F AH0 L|only:OW1 N L IY0|baby:B EY1 B IY0|maybe:M EY1 B IY0|' +
  'lady:L EY1 D IY0|crazy:K R EY1 Z IY0|head:HH EH1 D|dead:D EH1 D|bread:B R EH1 D|breath:B R EH1 TH|death:D EH1 TH|' +
  'heavy:HH EH1 V IY0|ready:R EH1 D IY0|great:G R EY1 T|break:B R EY1 K|steady:S T EH1 D IY0|weather:W EH1 DH ER0|' +
  'ever:EH1 V ER0|never:N EH1 V ER0|forever:F ER0 EH1 V ER0|together:T AH0 G EH1 DH ER0|whatever:W AH0 T EH1 V ER0|' +
  'river:R IH1 V ER0|water:W AO1 T ER0|was:W AA1 Z|what:W AH1 T|want:W AA1 N T|war:W AO1 R|warm:W AO1 R M|' +
  'world:W ER1 L D|word:W ER1 D|words:W ER1 D Z|work:W ER1 K|worth:W ER1 TH|worse:W ER1 S|could:K UH1 D|would:W UH1 D|' +
  'should:SH UH1 D|touch:T AH1 CH|young:Y AH1 NG|country:K AH1 N T R IY0|trouble:T R AH1 B AH0 L|double:D AH1 B AH0 L|' +
  'blood:B L AH1 D|flood:F L AH1 D|sure:SH UH1 R|chorus:K AO1 R AH0 S|echo:EH1 K OW0|ache:EY1 K|how:HH AW1|now:N AW1|' +
  'wow:W AW1|allow:AH0 L AW1|key:K IY1|they:DH EY1|hey:HH EY1|oh:OW1|ah:AA1|ooh:UW1|yeah:Y AE1|na:N AA1|la:L AA1|' +
  'whoa:W OW1|tonight:T AH0 N AY1 T|today:T AH0 D EY1|tomorrow:T AH0 M AA1 R OW2|goodbye:G UH2 D B AY1|' +
  'alright:AO2 L R AY1 T|okay:OW2 K EY1|inside:IH0 N S AY1 D|outside:AW1 T S AY1 D|alone:AH0 L OW1 N|' +
  'around:ER0 AW1 N D|across:AH0 K R AO1 S|away:AH0 W EY1|ago:AH0 G OW1|along:AH0 L AO1 NG|because:B IH0 K AO1 Z|' +
  'cause:K AO1 Z|mother:M AH1 DH ER0|father:F AA1 DH ER0|brother:B R AH1 DH ER0|other:AH1 DH ER0|nothing:N AH1 TH IH0 NG|' +
  'something:S AH1 M TH IH0 NG|anything:EH1 N IY0 TH IH2 NG|everything:EH1 V R IY0 TH IH2 NG|any:EH1 N IY0|' +
  'many:M EH1 N IY0|money:M AH1 N IY0|honey:HH AH1 N IY0|city:S IH1 T IY0|pretty:P R IH1 T IY0|busy:B IH1 Z IY0|' +
  'women:W IH1 M AH0 N|woman:W UH1 M AH0 N|friend:F R EH1 N D|friends:F R EH1 N D Z|door:D AO1 R|floor:F L AO1 R|' +
  'soul:S OW1 L|control:K AH0 N T R OW1 L|ghost:G OW1 S T|most:M OW1 S T|both:B OW1 TH|truth:T R UW1 TH|build:B IH1 L D|' +
  'guitar:G IH0 T AA1 R|style:S T AY1 L|rhythm:R IH1 DH AH0 M|idea:AY0 D IY1 AH0|real:R IY1 L|really:R IH1 L IY0|' +
  'being:B IY1 IH0 NG|lion:L AY1 AH0 N|quiet:K W AY1 AH0 T|diamond:D AY1 M AH0 N D|giant:JH AY1 AH0 N T|' +
  'dont:D OW1 N T|wont:W OW1 N T|cant:K AE1 N T|aint:EY1 N T|isnt:IH1 Z AH0 N T|wasnt:W AA1 Z AH0 N T|' +
  'didnt:D IH1 D AH0 N T|couldnt:K UH1 D AH0 N T|wouldnt:W UH1 D AH0 N T|doesnt:D AH1 Z AH0 N T|gonna:G AA1 N AH0|' +
  'wanna:W AA1 N AH0|gotta:G AA1 T AH0|thats:DH AE1 T S|whats:W AH1 T S|lets:L EH1 T S|its:IH1 T S|' +
  'down:D AW1 N|town:T AW1 N|crown:K R AW1 N|own:OW1 N|known:N OW1 N|shown:SH OW1 N|grown:G R OW1 N|' +
  'kiss:K IH1 S|wish:W IH1 SH|night:N AY1 T|light:L AY1 T|right:R AY1 T|high:HH AY1|sky:S K AY1|why:W AY1|my:M AY1|by:B AY1|' +
  'bye:B AY1|die:D AY1|lie:L AY1|cry:K R AY1|fly:F L AY1|try:T R AY1|goodnight:G UH2 D N AY1 T|feel:F IY1 L|' +
  'machine:M AH0 SH IY1 N|police:P AH0 L IY1 S|music:M Y UW1 Z IH0 K|moment:M OW1 M AH0 N T|' +
  'coming:K AH1 M IH0 NG|becoming:B IH0 K AH1 M IH0 NG|loving:L AH1 V IH0 NG|lover:L AH1 V ER0|cover:K AH1 V ER0|' +
  'month:M AH1 N TH|front:F R AH1 N T|among:AH0 M AH1 NG|become:B IH0 K AH1 M|wonder:W AH1 N D ER0|' +
  'open:OW1 P AH0 N|over:OW1 V ER0|under:AH1 N D ER0|after:AE1 F T ER0|angel:EY1 N JH AH0 L|'
).split('|').filter(Boolean).map((e) => { const [w, p] = e.split(':'); return [w, p] as const; }));

function parseArpa(s: string, est: boolean): Pron {
  const ph: string[] = [], st: number[] = [];
  for (const t of s.trim().split(/\s+/)) {
    const m = t.match(/^([A-Z]+)([012])?$/);
    if (!m) continue;
    ph.push(m[1]);
    if (VOWELS.has(m[1])) st.push(Number(m[2] ?? 0));
  }
  return { ph, st, est };
}

/** pronunciation of one word (memoised) */
export function pron(word: string): Pron {
  const w = normWord(word);
  if (!w) return { ph: [], st: [], est: true };
  const hit = cache.get(w);
  if (hit) return hit;
  let p: Pron;
  const d = DICT?.get(w);
  if (d) p = parseArpa(d, false);
  else if (BUILTIN[w]) p = parseArpa(BUILTIN[w], false);
  else if (/^\d+$/.test(w)) p = numberPron(w);
  else p = guess(w);
  // function words carry no lexical stress in singing (unless the music puts one there)
  if (p.st.length === 1 && FUNCTION_WORDS.has(w)) p = { ...p, st: [0] };
  cache.set(w, p);
  return p;
}

const NUM = ['Z IH1 R OW0', 'W AH1 N', 'T UW1', 'TH R IY1', 'F AO1 R', 'F AY1 V', 'S IH1 K S', 'S EH1 V AH0 N', 'EY1 T', 'N AY1 N'];
function numberPron(w: string): Pron {
  // digits read one by one (good enough for "24/7", "99")
  return parseArpa(w.split('').map((d) => NUM[Number(d)]).join(' '), true);
}

// ---- letter-to-sound rules -------------------------------------------------------------------------

const isV = (c: string | undefined) => !!c && 'aeiou'.includes(c);
const isVy = (w: string, i: number) => isV(w[i]) || (w[i] === 'y' && i > 0 && !isV(w[i + 1]));
const LONG: Record<string, string> = { a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW', y: 'AY' };
const SHORT: Record<string, string> = { a: 'AE', e: 'EH', i: 'IH', o: 'AA', u: 'AH', y: 'IH' };
const FIRST_STRESS = new Set(('every ever after angel anger any also always other only open over under into comfort common ' +
  'concert constant distance perfect pretty problem process promise prison present record rebel recent reckless region desert ' +
  'devil distant enter empty endless engine envy extra rescue restless secret silent center combat compass conquer contour ' +
  'mystery memory minute moment').split(' '));
const PREFIX = /^(a(?=(?:[bcdfglmnprstvwz][aeiouy]|cc|pp|ss|tt|rr|ll))|be|de|re|un|in|im|for|ex|con|com|pre|pro|dis|mis|ob|sub|sur|per|en|em|tra)/;

interface Gr { ph: string[]; v: boolean }

function guess(w: string): Pron {
  const g: Gr[] = [];
  const V = (...ph: string[]) => g.push({ ph, v: true });
  const C = (...ph: string[]) => g.push({ ph, v: false });
  const n = w.length;
  const at = (i: number, s: string) => w.startsWith(s, i);
  const end = (i: number) => i >= n;
  const nucleiBefore = () => g.filter((x) => x.v).length;
  let i = 0;
  while (i < n) {
    const c = w[i];
    const rest = w.slice(i);
    // ---- suffixes and special clusters
    if (i > 0 && /^(tion|sion|cian)s?$/.test(rest)) { C('SH'); V('AH', 'N'); if (rest.endsWith('s')) C('Z'); break; }
    if (i > 0 && /^(tial|cial)$/.test(rest)) { C('SH'); V('AH', 'L'); break; }
    if (i > 0 && /^ture[sd]?$/.test(rest)) { C('CH'); V('ER'); if (rest.length > 4) C(rest.endsWith('s') ? 'Z' : 'D'); break; }
    if (i > 0 && /^ous$/.test(rest)) { V('AH'); C('S'); break; }
    if (i > 0 && rest === 'ful') { C('F'); V('AH', 'L'); break; }
    if (i > 0 && rest === 'less') { C('L'); V('AH', 'S'); break; }
    if (i > 0 && rest === 'ness') { C('N'); V('AH', 'S'); break; }
    if (i > 1 && rest === 'ment') { C('M'); V('AH', 'N', 'T'); break; }
    if (i > 1 && /^(en|on|an)$/.test(rest) && nucleiBefore() > 0) { V('AH', 'N'); break; }
    if (i > 1 && rest === 'al' && nucleiBefore() > 0) { V('AH', 'L'); break; }
    if (i > 0 && rest === 'le' && !isV(w[i - 1])) { V('AH', 'L'); break; }
    if (i > 0 && rest === 'ed' && nucleiBefore() > 0) { if (/[td]/.test(w[i - 1])) { V('IH', 'D'); } else C(/[pksfx]|sh|ch/.test(w.slice(i - 2, i)) ? 'T' : 'D'); break; }
    if (i > 0 && rest === 'es' && nucleiBefore() > 0) {
      if (/(s|x|z|ch|sh|c|g)$/.test(w.slice(0, i))) V('IH', 'Z'); else C('Z');
      break;
    }
    if (i > 0 && rest === 'e' && nucleiBefore() > 0) break; // silent e
    if (i > 0 && (rest === 'ied' || rest === 'ies')) { V(nucleiBefore() <= 1 && !isV(w[i - 1]) && i <= 3 ? 'AY' : 'IY'); C(rest === 'ied' ? 'D' : 'Z'); break; }
    if (i > 0 && w[i - 1] !== 'y' && rest.startsWith('ying')) { V('AY'); V('IH', 'NG'); i += 4; continue; }
    // ---- vowels
    if (isV(c) || (c === 'y' && i > 0 && !isV(w[i + 1]))) {
      const tryV = (pat: string, ...ph: string[]) => { if (at(i, pat)) { V(...ph); i += pat.length; return true; } return false; };
      if (tryV('eigh', 'EY') || tryV('igh', 'AY') || tryV('augh', 'AO') || tryV('ough', 'AO') || tryV('eau', 'OW')) continue;
      if (at(i, 'ould') && end(i + 4)) { V('UH'); C('D'); i += 4; continue; }
      if (at(i, 'ire') && (end(i + 3) || /^[ds]$/.test(w.slice(i + 3)))) { V('AY'); V('ER'); i += 3; continue; }
      if (at(i, 'our') && !isV(w[i + 3])) { V('AW'); V('ER'); i += 3; continue; }
      if (at(i, 'air') || (at(i, 'are') && end(i + 3))) { V('EH', 'R'); i += 3; continue; }
      if (at(i, 'ear') && (end(i + 3) || /[sd]/.test(w[i + 3] ?? '') && end(i + 4))) { V('IH', 'R'); i += 3; continue; }
      if (at(i, 'ear') && !isV(w[i + 3])) { V('ER'); i += 3; continue; }
      if (at(i, 'eer') || (at(i, 'ere') && end(i + 3))) { V('IH', 'R'); i += 3; continue; }
      if (at(i, 'oor') || (at(i, 'ore') && end(i + 3))) { V('AO', 'R'); i += 3; continue; }
      if (at(i, 'ure') && end(i + 3)) { V('UH', 'R'); i += 3; continue; }
      if (at(i, 'ook') || (at(i, 'ood') && !/[fm]/.test(w[i - 1] ?? '')) || at(i, 'oot') && w[i - 1] === 'f') { V('UH'); i += 2; continue; }
      if (at(i, 'ow')) {
        const after = w.slice(i + 2);
        if (after === '' || after === 's' || /^n?$/.test(after) && !/(d|t|cr|g|cl|fr|dr|br)$/.test(w.slice(0, i))) { V('OW'); i += 2; continue; }
        V('AW'); i += 2; continue;
      }
      if (at(i, 'ie')) { V(end(i + 2) && n <= 4 ? 'AY' : 'IY'); i += 2; continue; }
      if (at(i, 'ei')) { V(w[i - 1] === 'c' ? 'IY' : 'EY'); i += 2; continue; }
      if (at(i, 'ey') && end(i + 2)) { V(nucleiBefore() ? 'IY' : 'EY'); i += 2; continue; }
      if (at(i, 'ou') && at(i, 'oul') === false) { V('AW'); i += 2; continue; }
      if (tryV('ee', 'IY') || tryV('ea', 'IY') || tryV('ay', 'EY') || tryV('ai', 'EY') || tryV('oa', 'OW') || tryV('oo', 'UW') ||
        tryV('oi', 'OY') || tryV('oy', 'OY') || tryV('au', 'AO') || (!isV(w[i + 2]) && tryV('aw', 'AO')) || tryV('ew', 'UW') || tryV('ue', 'UW') ||
        tryV('ui', 'UW') || tryV('eu', 'UW') || tryV('oul', 'OW', 'L')) continue;
      // r-coloured single vowels (r not followed by a vowel, or by a final silent e)
      const r = w[i + 1] === 'r' && !(w[i + 2] === 'r' && isVy(w, i + 3)) && (!isVy(w, i + 2) || (w[i + 2] === 'e' && end(i + 3)));
      if (r && c !== 'y') {
        if (c === 'a') V(w[i - 1] === 'w' ? 'AO' : 'AA', 'R');
        else if (c === 'o') V('AO', 'R');
        else V('ER');
        i += 2;
        if (w[i] === 'r') i++;
        continue;
      }
      // context rules for single vowels
      const cl = w.slice(i + 1).match(/^[^aeiouy]*/)![0];
      const after = w.slice(i + 1 + cl.length);
      const ph = singleVowel(w, i, c, cl, after, nucleiBefore());
      V(ph);
      i++;
      continue;
    }
    // ---- consonants
    const tryC = (pat: string, ...ph: string[]) => { if (at(i, pat)) { if (ph.length) C(...ph); i += pat.length; return true; } return false; };
    if (i === 0 && (tryC('kn', 'N') || tryC('wr', 'R') || tryC('gn', 'N') || tryC('ps', 'S'))) continue;
    if (at(i, 'wh')) { C(w === 'who' || w.startsWith('whol') ? 'HH' : 'W'); i += 2; continue; }
    if (i > 0 && at(i, 'nge')) { C('N', 'JH'); i += 2; if (w[i] === 'e' && end(i + 1)) i++; continue; }
    if (tryC('tch', 'CH') || tryC('dge', 'JH') || tryC('sh', 'SH') || tryC('ph', 'F') || tryC('ck', 'K') || tryC('qu', 'K', 'W') || tryC('nk', 'NG', 'K') || tryC('ng', 'NG')) continue;
    if (at(i, 'ch')) { C('CH'); i += 2; continue; }
    if (at(i, 'th')) { C(FUNCTION_WORDS.has(w) || (i > 0 && isV(w[i - 1]) && isVy(w, i + 2)) ? 'DH' : 'TH'); i += 2; continue; }
    if (at(i, 'gh')) { if (i === 0) C('G'); i += 2; continue; }
    if ((at(i, 'mb') || at(i, 'mn')) && end(i + 2)) { C('M'); i += 2; continue; }
    if (at(i, 'gn') && end(i + 2)) { C('N'); i += 2; continue; }
    if ((at(i, 'ti') || at(i, 'ci')) && i > 0 && /[ao]/.test(w[i + 2] ?? '')) { C('SH'); i += 2; continue; }
    const next = w[i + 1];
    if (c === next && c !== 'e') { i++; continue; } // doubled consonant: one phone
    switch (c) {
      case 'c': C(/[eiy]/.test(next ?? '') ? 'S' : 'K'); break;
      case 'g': {
        // soft before e/i/y (age, magic, energy) except the native get / give / girl / together family
        const soft = /[eiy]/.test(next ?? '') && !/^(et|ett|eth|iv|ir|if|ig|ift|in$)/.test(w.slice(i + 1)) && !(i === 0 && /^g[ei][tv]/.test(w));
        C(soft ? 'JH' : 'G');
        break;
      }
      case 'x': C(i === 0 ? 'Z' : 'K'); if (i > 0) C('S'); break;
      case 's': {
        const prev = g[g.length - 1];
        const voicedBefore = !!prev && (prev.v || VOICED.has(prev.ph[prev.ph.length - 1]));
        C((end(i + 1) && voicedBefore) || (i > 0 && isV(w[i - 1]) && isVy(w, i + 1)) ? 'Z' : 'S');
        break;
      }
      case 'j': C('JH'); break;
      case 'y': C('Y'); break;
      case 'h': if (i === 0 || isV(next)) C('HH'); break;
      case 'q': C('K'); break;
      case 'w': C('W'); break;
      default: if (/[bdfklmnprtvz]/.test(c)) C(c.toUpperCase()); break;
    }
    i++;
  }
  if (!g.some((x) => x.v)) g.push({ ph: ['AH'], v: true });
  const ph = g.flatMap((x) => x.ph);
  const nV = ph.filter((p) => VOWELS.has(p)).length;
  return { ph, st: guessStress(w, nV), est: true };
}

function singleVowel(w: string, i: number, c: string, cl: string, after: string, before: number): string {
  const last = after === '' && cl === '';
  const oneSyl = before === 0 && !/[aeiouy]/.test(w.slice(i + 1).replace(/e$/, ''));
  if (c === 'y') return last ? (before ? 'IY' : 'AY') : cl.length === 1 && after === 'e' ? 'AY' : 'IH';
  // open one-syllable words: me, go, hi, she
  if (last && oneSyl) return c === 'e' ? 'IY' : c === 'o' ? 'OW' : c === 'i' ? 'AY' : c === 'a' ? 'AA' : 'UW';
  if (last) return c === 'a' ? 'AH' : c === 'o' ? 'OW' : c === 'i' ? 'IY' : c === 'u' ? 'UW' : 'IY';
  // magic e (and its -es / -ed / -er / -ing forms)
  if (cl.length === 1 && cl !== 'x' && cl !== 'w' && (/^e[sdr]?$/.test(after) || (/^(ing|ed|er|est|en)$/.test(after) && c !== 'e') || (/^(y|ies|ied)$/.test(after) && /[aou]/.test(c)))) return LONG[c];
  if (c === 'o' && cl.length === 1 && cl !== 'x' && after && !/^[aeiouy]?$/.test(after)) return 'OW';
  if (c === 'a' && /^ll/.test(cl + after) || (c === 'a' && /^l[kt]/.test(cl))) return 'AO';
  if (c === 'a' && /^lm/.test(cl)) return 'AA';
  if (c === 'a' && w[i - 1] === 'w' && !/^[gkx]/.test(cl)) return 'AA';
  if (c === 'o' && /^l[dt]/.test(cl)) return 'OW';
  if (c === 'o' && cl === 'st' && after === '' && /(m|p|h|gh)$/.test(w.slice(0, i))) return 'OW';
  if (c === 'i' && /^(nd|ld|gn)$/.test(cl) && after === '') return 'AY';
  if (c === 'u' && /[pbf]$/.test(w.slice(0, i)) && /^(ll|sh|t|ss)$/.test(cl) && after === '') return 'UH';
  if (c === 'o' && w[i - 1] === 'w' && cl.startsWith('r')) return 'ER';
  if (c === 'a' && cl === 'ng' && after.startsWith('e')) return 'EY'; // change, strange, danger
  if (c === 'o' && /^(n[dt]|nth|v)/.test(cl) && /[wmfs]$/.test(w.slice(0, i))) return 'AH';
  return SHORT[c];
}

function guessStress(w: string, n: number): number[] {
  const st = new Array(n).fill(0);
  if (n <= 1) { if (n) st[0] = FUNCTION_WORDS.has(w) ? 0 : 1; return st; }
  let idx = 0;
  if (/(tion|sion|cian|tial|cial|ic|ian|ious|eous|uous)s?$/.test(w)) idx = n - 2;
  else if (/(ity|ify|ogy|graphy|ical|ible|able)s?$/.test(w)) idx = n - 3;
  else if (/(ee|eer|oon|ique|ese|ette|ade)s?$/.test(w)) idx = n - 1;
  else if (!FIRST_STRESS.has(w)) {
    let stem = w, m = n;
    for (let k = 0; k < 3; k++) {
      const s2 = stem.replace(/(ing|ed|er|est|ly|ness|less|ful|ment|ies|ied|es|s|y)$/, '');
      if (s2 === stem || s2.length < 3) break;
      m -= (stem.slice(s2.length).match(/[aeiouy]+/g) ?? []).length;
      stem = s2;
    }
    if (m >= 2 && PREFIX.test(stem) && !FIRST_STRESS.has(stem)) idx = 1;
  }
  idx = Math.max(0, Math.min(n - 1, idx));
  st[idx] = 1;
  if (idx >= 2) st[idx - 2] = 2;
  else if (n - idx >= 4) st[idx + 2] = 2;
  return st;
}

// ---- derived: syllables, rhyme, sounds -------------------------------------------------------------

export const syllableCount = (word: string) => pron(word).st.length;

/** phones from the last stressed vowel to the end (or the last vowel when nothing is stressed) */
export function rhymeTail(p: Pron): string[] {
  let vi = -1, k = 0, best = -1;
  p.ph.forEach((ph, i) => { if (VOWELS.has(ph)) { if (p.st[k] > 0) best = i; vi = i; k++; } });
  const from = best >= 0 ? best : vi;
  return from < 0 ? [] : p.ph.slice(from);
}

const cls = (c: string) => (NASAL.has(c) ? 'N' : PLOSIVE.has(c) ? (VOICED.has(c) ? 'Pv' : 'P') : FRIC.has(c) ? 'F' : LIQUID.has(c) ? 'L' : c);
const coda = (t: string[]) => t.slice(1).filter((x) => !VOWELS.has(x));
const tailVowels = (t: string[]) => t.filter((x) => VOWELS.has(x));

export type RhymeQuality = 'perfect' | 'slant' | 'assonance' | 'consonance' | 'identity';

/** how two words rhyme, judged on sound (null: they don't) */
export function rhymeQuality(a: string, b: string): RhymeQuality | null {
  const na = normWord(a), nb = normWord(b);
  if (!na || !nb) return null;
  if (na === nb) return 'identity';
  const pa = pron(na), pb = pron(nb);
  const ta = rhymeTail(pa), tb = rhymeTail(pb);
  if (!ta.length || !tb.length) return null;
  if (ta.join(' ') === tb.join(' ')) {
    // same tail and the same onset before it is a repetition of sound, still a rhyme for our purposes
    return 'perfect';
  }
  const va = tailVowels(ta), vb = tailVowels(tb);
  const ca = coda(ta), cb = coda(tb);
  const sameV = va[0] === vb[0];
  const sameCls = ca.map(cls).join() === cb.map(cls).join();
  const lastC = (c: string[]) => c[c.length - 1];
  if (sameV && (sameCls || (ca.length && cb.length && cls(lastC(ca)) === cls(lastC(cb))) || (!ca.length && !cb.length))) return 'slant';
  // R-coloured near-misses (fire / higher, ER vs AH R)
  if (sameV) return 'assonance';
  if (ca.length && ca.join() === cb.join() && ca.some((x) => !LIQUID.has(x))) return 'consonance';
  return null;
}

/** a key that groups words rhyming perfectly (tail phones) */
export const rhymeTailKey = (word: string) => rhymeTail(pron(word)).join(' ');

/** vowel of a word's stressed syllable (for sound views / assonance) */
export function stressedVowel(p: Pron): string | null {
  let k = 0, best: string | null = null, last: string | null = null;
  for (const ph of p.ph) if (VOWELS.has(ph)) { if (p.st[k] > 0 && !best) best = ph; last = ph; k++; }
  return best ?? last;
}

/** the vowel of the last syllable + whether it can be held on a long note */
export function sustainOf(p: Pron): { vowel: string; open: boolean } | null {
  let vi = -1;
  p.ph.forEach((ph, i) => { if (VOWELS.has(ph)) vi = i; });
  if (vi < 0) return null;
  const v = p.ph[vi];
  const after = p.ph.slice(vi + 1);
  const closed = LAX.has(v) && after.some((c) => OBSTRUENT.has(c));
  return { vowel: v, open: !closed };
}

/** first consonant sound (alliteration) */
export const onset = (p: Pron) => (p.ph.length && !VOWELS.has(p.ph[0]) ? p.ph[0] : null);

/** ARPAbet → a readable respelling for tooltips: "HH AH0 L OW1" → "hə·LOW" */
const RESPELL: Record<string, string> = {
  AA: 'ah', AE: 'a', AH: 'uh', AO: 'aw', AW: 'ow', AY: 'igh', EH: 'e', ER: 'ur', EY: 'ay', IH: 'i', IY: 'ee', OW: 'oh', OY: 'oy', UH: 'uu', UW: 'oo',
  B: 'b', CH: 'ch', D: 'd', DH: 'th', F: 'f', G: 'g', HH: 'h', JH: 'j', K: 'k', L: 'l', M: 'm', N: 'n', NG: 'ng', P: 'p', R: 'r', S: 's', SH: 'sh', T: 't', TH: 'th', V: 'v', W: 'w', Y: 'y', Z: 'z', ZH: 'zh',
};
export function respell(p: Pron): string {
  const vi = p.ph.map((x, i) => (VOWELS.has(x) ? i : -1)).filter((i) => i >= 0);
  if (!vi.length) return p.ph.map((x) => RESPELL[x] ?? x.toLowerCase()).join('');
  // each syllable starts one consonant before its vowel (the first one takes the whole onset)
  const starts = vi.map((v, j) => (j === 0 ? 0 : v - (v - vi[j - 1] > 1 ? 1 : 0)));
  return starts.map((a, j) => {
    const txt = p.ph.slice(a, starts[j + 1] ?? p.ph.length).map((x) => RESPELL[x] ?? x.toLowerCase()).join('');
    return p.st[j] === 1 ? txt.toUpperCase() : txt;
  }).join('·');
}
