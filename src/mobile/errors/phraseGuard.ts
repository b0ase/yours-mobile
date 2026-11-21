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
 * Audits: '.', '+' and '_' joins (25 Oct 2026); ':' '=' and other punctuation, filler words (b-Aware row 353,
 * 19 Nov 2026); the nine non-English wordlists (b-Aware row 364, 19 Nov 2026).
 */

/** 12 words, or 11 when one was mistyped. */
const MIN_WORDS = 11;
const MIN_DENSITY = 0.8;
const MAX_GAP = 2;
/** The filler pass needs the whole phrase (no mistyped word): it has no density test to lean on. */
const FILL_WORDS = 12;
const FILL_DISTINCT = 2;
const PHRASE_LENGTHS = [12, 15, 18, 21, 24];

/** Letter runs (accents and kana voicing marks stay on the word) or digit runs. Everything else is a separator. */
const TOKEN = /[\p{L}\p{M}]+|\p{N}+/gu;
const fold = (w: string) => w.normalize('NFKD').toLowerCase();
const bare = (w: string) => w.replace(/\p{M}/gu, '');
const LATIN = /^[\p{Script=Latin}\p{M}]+$/u;

type Wordlist = { words: string[]; latin: boolean; lookup: Map<string, string> };

/** Every distinct wordlist bip39 ships (it lists English and Japanese twice, as EN and JA). */
const LISTS: Wordlist[] = Array.from(new Set(Object.values(bip39.wordlists))).map((words) => {
  const lookup = new Map<string, string>();
  const latin = LATIN.test(words[0]);
  for (const w of words) lookup.set(fold(w), w);
  // A Latin-script phrase is often typed without its accents; the Spanish and French lists are unique without them.
  if (latin) for (const w of words) if (!lookup.has(bare(fold(w)))) lookup.set(bare(fold(w)), w);
  return { words, latin, lookup };
});

type Raw = { start: number; end: number; text: string; digits: boolean };
type Token = { start: number; end: number; kind: 'bip' | 'other' | 'noise'; form: string; word?: string };

const rawTokens = (text: string): Raw[] =>
  Array.from(text.matchAll(TOKEN), (m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    text: m[0],
    digits: /^\p{N}+$/u.test(m[0]),
  }));

const classify = (raw: Raw[], list: Wordlist): Token[] =>
  raw.map((r) => {
    if (r.digits) return { start: r.start, end: r.end, kind: 'noise', form: '' };
    const form = fold(r.text);
    const word = list.lookup.get(form) ?? (list.latin && LATIN.test(form) ? list.lookup.get(bare(form)) : undefined);
    return { start: r.start, end: r.end, kind: word ? 'bip' : 'other', form, word };
  });

/**
 * Ordinary text passes the 4-bit checksum of a 12-word window 1 time in 16, so the checksum alone is not enough: a
 * window must also hold no repeated word, which prose and code nearly always do and a phrase rarely does.
 */
const distinct = (words: string[]) => new Set(words).size === words.length;

const validRun = (words: string[], list: Wordlist): boolean => {
  try {
    return bip39.validateMnemonic(words.join(' '), list.words);
  } catch {
    return false;
  }
};

/** Spans [first word index, last word index] (into `words`, the non-numbering tokens) found in one wordlist. */
const spansInList = (words: Token[], list: Wordlist): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  // 1 and 2a: dense stretches, and stretches whose fillers repeat.
  let s = 0;
  while (s < words.length) {
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
    for (let e = s; e < words.length; e++) {
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
    }
    if (best < 0) {
      s++;
      continue;
    }
    out.push([s, best]);
    s = best + 1;
  }
  // 2b: any fillers, but the list words hold a whole phrase with a valid checksum. Each maximal stretch once.
  let run: number[] = [];
  let gap = 0;
  const flush = () => {
    if (run.length >= FILL_WORDS) {
      const seq = run.map((i) => words[i].word as string);
      for (let a = 0; a + FILL_WORDS <= seq.length; a++)
        for (const n of PHRASE_LENGTHS)
          if (a + n <= seq.length && distinct(seq.slice(a, a + n)) && validRun(seq.slice(a, a + n), list))
            out.push([run[a], run[a + n - 1]]);
    }
    run = [];
  };
  for (let i = 0; i < words.length; i++) {
    if (words[i].kind === 'bip') {
      run.push(i);
      gap = 0;
    } else if (run.length && ++gap > MAX_GAP) {
      flush();
      gap = 0;
    }
  }
  flush();
  return out;
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
