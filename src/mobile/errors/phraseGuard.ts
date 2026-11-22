import { Hash } from '@bsv/sdk';
import * as bip39 from 'bip39';

/**
 * Finds recovery phrases in free text, however they were written down: numbered ("1." "1)" "01:"), one word per
 * line, in a grid, upper case, joined by any punctuation (":" "=" "-" "." "+" "_" "/" quotes, brackets…), after a
 * label like "seed:", with filler words between the words, and in any of the ten BIP39 languages, accents typed or
 * not. Shared by redactSecrets (errorReport.ts) and the Ask b guard (agent.ts looksLikeSecret).
 *
 * Text is split into letter runs (words) and digit runs (numbering, ignored). Everything else separates. Then, for
 * each BIP39 wordlist on its own (a phrase is in one language, and mixing lists would make ordinary text look denser):
 *  1. Dense: a stretch holding at least MIN_WORDS words of the list, where they are at least MIN_DENSITY of the
 *     words and no more than MAX_GAP other words sit together. Ordinary English fails the density test: "the",
 *     "and", "of", "to", "is" and most other glue words are not BIP39 words.
 *  2. Filler: a phrase with filler words between its words ("abandon zz ability zz …", "word 1 abandon word 2 …")
 *     fails the density test, so a stretch (gaps of up to MAX_GAP) also counts when it holds FILL_WORDS list words
 *     and its other words repeat (at most FILL_DISTINCT different ones), or when its list words, in order, hold a
 *     run of 12/15/18/21/24 different words that passes the BIP39 checksum.
 *  3. Whole line: a line, or the whole text, of exactly 12/15/18/21/24 words with at most two outside the list.
 * Passes 1 and 2 run a second time when a list word repeats 3 or more times in a stretch: such a word is filler
 * ("word 1 is abandon. word 2 is ability", "the abandon then the ability", JSON "index"/"value" keys), counted as
 * an other word for that run. A match from that run counts only with such a word between every two of its words.
 * Long text: lists with fewer than MIN_HITS words in the text are skipped, the checksum is worked out from list
 * positions, and the loops stop as soon as no later word can make a match, so the cost grows with the length of the
 * text, not its square (review of row 353: 20,000 list words took 16s).
 * Audits: '.', '+' and '_' joins (25 Oct 2026); ':' '=' and other punctuation, filler words (b-Aware row 353,
 * 19 Nov 2026); the nine non-English wordlists (b-Aware row 364, 19 Nov 2026); list words as filler, and speed
 * (review of row 353, 22 Nov 2026).
 */

/** 12 words, or 11 when one was mistyped. */
const MIN_WORDS = 11;
const MIN_DENSITY = 0.8;
const MAX_GAP = 2;
/** The filler pass needs the whole phrase (no mistyped word): it has no density test to lean on. */
const FILL_WORDS = 12;
const FILL_DISTINCT = 2;
const PHRASE_LENGTHS = [12, 15, 18, 21, 24];
/** The fewest list words any pass can match on (a 12-word line with two typos). A list with fewer is skipped. */
const MIN_HITS = 10;
/** A list word seen this often in one stretch is filler, not part of a phrase. */
const FILLER_REPEATS = 3;

/** Letter runs (accents and kana voicing marks stay on the word) or digit runs. Everything else is a separator. */
const TOKEN = /[\p{L}\p{M}]+|\p{N}+/gu;
const fold = (w: string) => w.normalize('NFKD').toLowerCase();
const bare = (w: string) => w.replace(/\p{M}/gu, '');
const LATIN = /^[\p{Script=Latin}\p{M}]+$/u;

type Wordlist = { words: string[]; latin: boolean; lookup: Map<string, string>; index: Map<string, number> };

/** Every distinct wordlist bip39 ships (it lists English and Japanese twice, as EN and JA). */
const LISTS: Wordlist[] = Array.from(new Set(Object.values(bip39.wordlists))).map((words) => {
  const lookup = new Map<string, string>();
  const latin = LATIN.test(words[0]);
  for (const w of words) lookup.set(fold(w), w);
  // A Latin-script phrase is often typed without its accents; the Spanish and French lists are unique without them.
  if (latin) for (const w of words) if (!lookup.has(bare(fold(w)))) lookup.set(bare(fold(w)), w);
  return { words, latin, lookup, index: new Map(words.map((w, i) => [w, i])) };
});

type Raw = { start: number; end: number; text: string; digits: boolean };
type Token = { start: number; end: number; kind: 'bip' | 'other' | 'noise'; form: string; word?: string };

/**
 * An ordinal ending glued to a number is numbering: "1st", "2nd", "3rd", "4th", "1er", "2º". Read as words they were four
 * different fillers, and "1st word: X," missed the 1 in 30 valid phrases that repeat a word (review of b-Aware row 353).
 * Named endings only: single letters such as "a" and "e" are also hex digits ("3fa2"), which must stay other words.
 */
const ORDINAL = /^(?:st|nd|rd|th|er|re|º|ª)$/iu;

const rawTokens = (text: string): Raw[] => {
  const out: Raw[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const prev = out[out.length - 1];
    const digits = /^\p{N}+$/u.test(m[0]) || (prev?.digits === true && prev.end === start && ORDINAL.test(m[0]));
    out.push({ start, end: start + m[0].length, text: m[0], digits });
  }
  return out;
};

const classify = (raw: Raw[], list: Wordlist): Token[] =>
  raw.map((r) => {
    if (r.digits) return { start: r.start, end: r.end, kind: 'noise', form: '' };
    const form = fold(r.text);
    const word = list.lookup.get(form) ?? (list.latin && LATIN.test(form) ? list.lookup.get(bare(form)) : undefined);
    return { start: r.start, end: r.end, kind: word ? 'bip' : 'other', form, word };
  });

/**
 * The BIP39 checksum of a 12–24 word run, from the words' list positions. Same answer as bip39.validateMnemonic, which
 * looks each word up with indexOf (2,048 compares) and was far too slow run once per window.
 */
const checksumOk = (idx: number[]): boolean => {
  const bits = idx.length * 11;
  const cs = bits / 33;
  const ent = bits - cs;
  const bytes = new Array<number>(ent / 8).fill(0);
  let got = 0;
  for (let b = 0; b < bits; b++) {
    const bit = (idx[Math.floor(b / 11)] >> (10 - (b % 11))) & 1;
    if (b < ent) bytes[b >> 3] |= bit << (7 - (b & 7));
    else got = (got << 1) | bit;
  }
  return got === Hash.sha256(bytes)[0] >> (8 - cs);
};

/** Passes 1 and 2 over one classification. Spans are [first word index, last word index] into `words`. */
const passes = (words: Token[], list: Wordlist): Array<[number, number]> => {
  const n = words.length;
  const out: Array<[number, number]> = [];
  // Pass 1 holds at e when bip - 4 * other >= 0 over [s, e], i.e. pre[e + 1] >= pre[s]. ahead[i]: the highest
  // pre[e + 1] for a list word e from i up to where the stretch ends (the third other word in a row).
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (words[i].kind === 'bip' ? 1 : -4);
  const ahead = new Float64Array(n + 1).fill(-Infinity);
  // gapAt[i]: other words in a row ending at i.
  const gapAt = new Int32Array(n);
  for (let i = 0, g = 0; i < n; i++) gapAt[i] = g = words[i].kind === 'bip' ? 0 : g + 1;
  for (let i = n - 1; i >= 0; i--) {
    if (gapAt[i] > MAX_GAP) continue; // the loop from any s stops here
    ahead[i] = Math.max(words[i].kind === 'bip' ? pre[i + 1] : -Infinity, ahead[i + 1]);
  }
  // 1 and 2a: dense stretches, and stretches whose fillers repeat.
  let s = 0;
  while (s < n) {
    if (words[s].kind !== 'bip') {
      s++;
      continue;
    }
    let bip = 0;
    let other = 0;
    let gap = 0;
    let best = -1;
    const fillers = new Set<string>();
    const seen = new Set<string>();
    for (let e = s; e < n; e++) {
      if (words[e].kind === 'bip') {
        bip++;
        gap = 0;
        seen.add(words[e].word as string);
        if (bip >= MIN_WORDS && bip / (bip + other) >= MIN_DENSITY) best = e;
        // Markup and code repeat their own words ("label", "path", "media"); a phrase rarely repeats one.
        else if (bip >= FILL_WORDS && fillers.size <= FILL_DISTINCT && seen.size >= bip - 1) best = e;
      } else {
        other++;
        fillers.add(words[e].form);
        if (++gap > MAX_GAP) break;
      }
      // Stop once nothing later can match: 2a never recovers from a third filler or a second repeat, and pass 1
      // needs a later list word that brings the density back up.
      const fillOpen = fillers.size <= FILL_DISTINCT && seen.size >= bip - 1;
      if (!fillOpen && ahead[e + 1] < pre[s]) break;
    }
    if (best < 0) {
      s++;
      continue;
    }
    out.push([s, best]);
    s = best + 1;
  }
  // 2b: any fillers, but the list words hold a whole phrase with a valid checksum. Each maximal stretch once; a
  // window passes 1 or 2a already took is not checked again. Ordinary text passes the 4-bit checksum of a 12-word
  // window 1 time in 16, so the checksum alone is not enough: a window must also hold no repeated word, which prose
  // and code nearly always do and a phrase rarely does.
  const taken = new Int32Array(n).fill(-1);
  out.forEach(([a, b], k) => taken.fill(k, a, b + 1));
  let idx: number[] = [];
  let gap = 0;
  const flush = () => {
    const m = idx.length;
    if (m >= FILL_WORDS) {
      const seq = idx.map((i) => words[i].word as string);
      const pos = seq.map((w) => list.index.get(w) as number);
      // distinctTo[a]: the end (exclusive) of the longest run of different words from a.
      const distinctTo = new Int32Array(m);
      const last = new Map<string, number>();
      for (let a = m - 1, end = m; a >= 0; a--) {
        const again = last.get(seq[a]);
        if (again !== undefined) end = Math.min(end, again);
        last.set(seq[a], a);
        distinctTo[a] = end;
      }
      for (let a = 0; a + FILL_WORDS <= m; a++)
        for (const len of PHRASE_LENGTHS) {
          if (a + len > distinctTo[a]) break;
          const first = idx[a];
          const lastW = idx[a + len - 1];
          if (taken[first] >= 0 && taken[first] === taken[lastW]) continue;
          if (checksumOk(pos.slice(a, a + len))) out.push([first, lastW]);
        }
    }
    idx = [];
  };
  for (let i = 0; i < n; i++) {
    if (words[i].kind === 'bip') {
      idx.push(i);
      gap = 0;
    } else if (idx.length && ++gap > MAX_GAP) {
      flush();
      gap = 0;
    }
  }
  flush();
  return out;
};

/**
 * A list word seen FILLER_REPEATS or more times in one stretch (gaps of up to MAX_GAP other words) is a label or a
 * key, not a phrase word: "word" in "word 1 is abandon. word 2 is ability", "index" and "value" in JSON. Returns the
 * words with those counted as other words, or null when there are none.
 */
const demoteRepeats = (words: Token[]): Token[] | null => {
  const out = words.slice();
  let changed = false;
  let a = 0;
  while (a < words.length) {
    let b = a;
    for (let gap = 0; b < words.length; b++) {
      gap = words[b].kind === 'bip' ? 0 : gap + 1;
      if (gap > MAX_GAP) break;
    }
    const count = new Map<string, number>();
    for (let i = a; i < b; i++)
      if (words[i].kind === 'bip') count.set(words[i].form, (count.get(words[i].form) ?? 0) + 1);
    for (let i = a; i < b; i++)
      if (words[i].kind === 'bip' && (count.get(words[i].form) ?? 0) >= FILLER_REPEATS) {
        out[i] = { ...words[i], kind: 'other', word: undefined };
        changed = true;
      }
    a = b + 1;
  }
  return changed ? out : null;
};

/**
 * A match made only once repeated words were counted as filler must look like a labelled list: a demoted word between
 * every two of its words ("word 2 is", "then the", `"index":1,"value"`). Without this, demoting a common word in long
 * prose leaves runs of different words, and 1 in 16 of those passes the checksum.
 */
const labelledThroughout = (demoted: Token[], words: Token[], [a, b]: [number, number]): boolean => {
  let label = true;
  for (let i = a + 1; i <= b; i++) {
    if (demoted[i].kind === 'bip') {
      if (!label) return false;
      label = false;
    } else if (words[i].kind === 'bip') label = true;
  }
  return true;
};

/** Spans [first word index, last word index] (into `words`, the non-numbering tokens) found in one wordlist. */
const spansInList = (words: Token[], list: Wordlist): Array<[number, number]> => {
  const found = passes(words, list);
  const demoted = demoteRepeats(words);
  if (demoted) for (const span of passes(demoted, list)) if (labelledThroughout(demoted, words, span)) found.push(span);
  return found;
};

/**
 * A line, or the whole text, made of exactly 12/15/18/21/24 words with at most two not in the list: a phrase written
 * down with a typo or two (too few list words for the dense test).
 */
const wholeLineSpans = (words: Token[], text: string): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  const check = (a: number, b: number) => {
    const n = b - a + 1;
    if (!PHRASE_LENGTHS.includes(n)) return;
    let bip = 0;
    for (let i = a; i <= b; i++) if (words[i].kind === 'bip') bip++;
    if (bip >= n - 2) out.push([a, b]);
  };
  if (words.length) check(0, words.length - 1);
  let a = 0;
  for (let i = 1; i <= words.length; i++)
    if (i === words.length || /[\r\n]/.test(text.slice(words[i - 1].end, words[i].start))) {
      check(a, i - 1);
      a = i;
    }
  return out;
};

/** Character ranges [start, end) of every recovery phrase found, including its numbering. */
export const findPhraseSpans = (text: string): Array<[number, number]> => {
  text = String(text ?? '');
  const raw = rawTokens(text);
  const found: Array<[number, number]> = [];
  for (const list of LISTS) {
    const all = classify(raw, list);
    let hits = 0;
    for (const t of all) if (t.kind === 'bip') hits++;
    if (hits < MIN_HITS) continue;
    const words = all.map((t, i) => ({ t, i })).filter((x) => x.t.kind !== 'noise');
    const toks = words.map((x) => x.t);
    for (const [a, b] of [...spansInList(toks, list), ...wholeLineSpans(toks, text)]) {
      // Take in the numbering just before the first word ("1." on its own) as well.
      let first = words[a].i;
      while (first > 0 && all[first - 1].kind === 'noise') first--;
      found.push([all[first].start, all[words[b].i].end]);
    }
  }
  // Lists can find overlapping stretches (words common to two lists): merge them.
  found.sort((x, y) => x[0] - y[0]);
  const spans: Array<[number, number]> = [];
  for (const [a, b] of found) {
    const last = spans[spans.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  return spans;
};

export const containsPhrase = (text: string): boolean => findPhraseSpans(text).length > 0;

/** Replace every recovery phrase (words and numbering) with `mask`. */
export const hidePhrases = (text: string, mask = '[recovery words hidden]'): string => {
  const src = String(text ?? '');
  let out = '';
  let at = 0;
  for (const [a, b] of findPhraseSpans(src)) {
    out += src.slice(at, a) + mask;
    at = b;
  }
  return out + src.slice(at);
};
