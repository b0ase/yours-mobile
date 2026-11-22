import { Hash } from '@bsv/sdk';
import * as bip39 from 'bip39';

/**
 * Finds recovery phrases in free text, however they were written down: numbered ("1." "1)" "01:"), one word per
 * line, in a grid, upper case, joined by any punctuation (":" "=" "-" "." "+" "_" "/" quotes, brackets…), after a
 * label like "seed:", with filler words between the words, and in any of the ten BIP39 languages, accents typed or
 * not. Shared by redactSecrets (errorReport.ts) and the Ask b guard (agent.ts looksLikeSecret).
 *
 * Text is split into letter runs (words) and digit runs (numbering, ignored). Everything else separates; invisible
 * format characters inside a word are dropped. Then, for each BIP39 wordlist on its own (a phrase is in one language,
 * and mixing lists would make ordinary text look denser):
 *  1. Dense: a stretch holding at least MIN_WORDS words of the list, where they are at least MIN_DENSITY of the
 *     words and no more than MAX_GAP other words sit together. Ordinary English fails the density test: "the",
 *     "and", "of", "to", "is" and most other glue words are not BIP39 words.
 *  2. Filler: a phrase with filler words between its words ("abandon zz ability zz …", "word 1 abandon word 2 …")
 *     fails the density test, so a stretch (gaps of up to MAX_GAP) also counts when it holds FILL_WORDS list words
 *     and its other words repeat (at most FILL_DISTINCT different ones), or when its list words, in order, hold a
 *     run of 12/15/18/21/24 different words that passes the BIP39 checksum (repeatsAllowed repeats with fillers between).
 *  3. Whole line: a line, or the whole text, of exactly 12/15/18/21/24 words with at most two outside the list.
 * Passes 1 and 2 run a second time when a list word repeats 3 or more times in a stretch: such a word is filler
 * ("word 1 is abandon. word 2 is ability", "the abandon then the ability", JSON "index"/"value" keys), counted as
 * an other word for that run, but not toward the gap or the fillers, unless it stands where a phrase word goes (after
 * "is" or ":"). A match from that run counts only with such a word between every two of its words, and may have up
 * to LABELLED_GAP other words together ("X and the second word is Y"). With MIN_SPELLED or more spelled numbers that
 * count a list ("first", "second", "third"…) in the text, the passes run again with those read as numbering: once for
 * numbers before the phrase words ("the first word is X"), once for numbers after "is" or ":" ("X is first"). A match
 * from those readings needs one between its words, and may also have LABELLED_GAP other words together.
 *
 * Known limits (CTO, 22 Nov 2026: after round 5, a way of writing a phrase that is not a common English one is
 * recorded here, not fixed in another round):
 *  - Chinese or Japanese words written with no space between them, and fragments of 10 words or fewer, are not blocked
 *    (owner's decision).
 *  - A phrase split across two or more messages is out of scope (owner's decision).
 *  - Spelled numbers are read in English only ("primero", "premier" are other words).
 *  - A phrase word that is also a label repeated 3+ times, in a list with no "is" or ":" before the phrase words
 *    ("the then then"), is read as a label, so that list is not blocked.
 *  - In a list numbered in words with no "is" or ":" ("fifth six sixth X"), a phrase word that is the next number
 *    after its own numbering is read as numbering.
 *  - Look-alike letters are folded for Cyrillic and Greek only (NFKD already folds full-width and styled letters);
 *    look-alikes from other scripts, such as Cherokee or Armenian, are not.
 * Long text: lists with fewer than MIN_HITS words in the text are skipped, the checksum is worked out from list
 * positions, and the loops stop as soon as no later word can make a match, so the cost grows with the length of the
 * text, not its square (review of row 353: 20,000 list words took 16s).
 * Audits: '.', '+' and '_' joins (25 Oct 2026); ':' '=' and other punctuation, filler words (b-Aware row 353,
 * 19 Nov 2026); the nine non-English wordlists (b-Aware row 364, 19 Nov 2026); list words as filler, and speed
 * (review of row 353, 22 Nov 2026); labelled plain-English lists, spelled numbers, a repeated word with mixed fillers,
 * invisible characters (round-3 review of row 353, 22 Nov 2026); lists joined with "and", phrases holding a label word
 * or spelled number, Hangul fillers and look-alike letters (round-4 review of row 353, 22 Nov 2026); "X is first" and
 * "word one of twelve is X" (round-5 review of row 353, 22 Nov 2026).
 */

/** 12 words, or 11 when one was mistyped. */
const MIN_WORDS = 11;
const MIN_DENSITY = 0.8;
const MAX_GAP = 2;
/**
 * The gap in a labelled or word-numbered list: "the first word is X and the second word is Y" puts "and", "the" and "is"
 * between two phrase words (round-4 review of b-Aware row 353). Such matches must show a label or a spelled number
 * between their words, which ordinary text does not.
 */
const LABELLED_GAP = 4;
/** The filler pass needs the whole phrase (no mistyped word): it has no density test to lean on. */
const FILL_WORDS = 12;
const FILL_DISTINCT = 2;
const PHRASE_LENGTHS = [12, 15, 18, 21, 24];
/** The fewest list words any pass can match on (a 12-word line with two typos). A list with fewer is skipped. */
const MIN_HITS = 10;
/**
 * Repeated words a phrase of n words may hold: about 1 valid 12-word phrase in 30 repeats a word, and about 1 24-word
 * phrase in 125 repeats two (round-3 review of b-Aware row 353).
 */
const repeatsAllowed = (n: number) => (n >= 18 ? 2 : 1);
/** A list word seen this often in one stretch is filler, not part of a phrase. */
const FILLER_REPEATS = 3;

/**
 * Letter runs (accents and kana voicing marks stay on the word) or digit runs. Everything else is a separator.
 * Invisible characters inside a letter run stay in it and are dropped from the word, so "aban\u200Bdon" is still
 * "abandon": format characters (zero-width space and joiners, word joiner, byte order mark, soft hyphen, direction
 * marks: Unicode Cf; round-3 review of b-Aware row 353) and the Hangul fillers, which are letters that show nothing
 * (U+115F, U+1160, U+3164, U+FFA0; round-4 review). When the word without them is no list word, the invisible
 * characters were joining words ("abandon\u200Bability") and the run is split there instead.
 */
const TOKEN = /[\p{L}\p{M}][\p{L}\p{M}\p{Cf}]*|\p{N}+/gu;
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;
const HAS_INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/u;
/**
 * Cyrillic and Greek letters that look like Latin ones. A word whose Cyrillic or Greek letters are all look-alikes
 * ("аbаndоn" with Cyrillic а and о) is read in Latin letters; a real Russian or Greek word holds other letters too and is
 * left as it is (round-4 review of b-Aware row 353: look-alikes got past Ask b every time).
 */
const LOOK_ALIKES = new Map<string, string>(
  Object.entries({
    а: 'a',
    е: 'e',
    о: 'o',
    р: 'p',
    с: 'c',
    у: 'y',
    х: 'x',
    і: 'i',
    ј: 'j',
    ѕ: 's',
    һ: 'h',
    ԁ: 'd',
    ԛ: 'q',
    ԝ: 'w',
    ӏ: 'l',
    А: 'a',
    В: 'b',
    Е: 'e',
    К: 'k',
    М: 'm',
    Н: 'h',
    О: 'o',
    Р: 'p',
    С: 'c',
    Т: 't',
    У: 'y',
    Х: 'x',
    І: 'i',
    Ј: 'j',
    Ѕ: 's',
    ο: 'o',
    α: 'a',
    ι: 'i',
    ν: 'v',
    ρ: 'p',
    Α: 'a',
    Β: 'b',
    Ε: 'e',
    Ζ: 'z',
    Η: 'h',
    Ι: 'i',
    Κ: 'k',
    Μ: 'm',
    Ν: 'n',
    Ο: 'o',
    Ρ: 'p',
    Τ: 't',
    Υ: 'y',
    Χ: 'x',
  }),
);
const CYRILLIC_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
const latinise = (w: string): string => {
  if (!CYRILLIC_GREEK.test(w)) return w;
  let out = '';
  for (const ch of w) {
    const latin = LOOK_ALIKES.get(ch);
    if (latin) out += latin;
    else if (CYRILLIC_GREEK.test(ch)) return w;
    else out += ch;
  }
  return out;
};
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
/** A word of any list, accents typed or not. */
const anyListWord = (w: string): boolean => {
  const f = fold(w);
  return LISTS.some((l) => l.lookup.has(f) || (l.latin && l.lookup.has(bare(f))));
};

type Raw = { start: number; end: number; text: string; digits: boolean };
/**
 * `label`: a list word demoted to filler because it repeats ("word" in "my 1st word is X, my 2nd word is Y").
 * `slot`: the word stands where a phrase word goes, straight after "is", "was", ":" or "=" and not followed by
 * numbering, so it is never a label ("word 4 is word"); a spelled number there is never numbering ("the fifth word is
 * three"). `numbered`: a spelled number read as numbering sits just
 * before it.
 */
type Token = {
  start: number;
  end: number;
  kind: 'bip' | 'other' | 'noise';
  form: string;
  word?: string;
  label?: boolean;
  slot?: boolean;
  numbered?: boolean;
};

/**
 * An ordinal ending glued to a number is numbering: "1st", "2nd", "3rd", "4th", "1er", "2º". Read as words they were four
 * different fillers, and "1st word: X," missed the 1 in 30 valid phrases that repeat a word (review of b-Aware row 353).
 * Named endings only: single letters such as "a" and "e" are also hex digits ("3fa2"), which must stay other words.
 */
const ORDINAL = /^(?:st|nd|rd|th|er|re|º|ª)$/iu;

const rawTokens = (text: string): Raw[] => {
  const out: Raw[] = [];
  const push = (piece: string, start: number) => {
    const word = latinise(piece.replace(INVISIBLE, ''));
    if (!word) return; // invisible characters on their own separate
    const prev = out[out.length - 1];
    const digits = /^\p{N}+$/u.test(word) || (prev?.digits === true && prev.end === start && ORDINAL.test(word));
    out.push({ start, end: start + piece.length, text: word, digits });
  };
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (!HAS_INVISIBLE.test(m[0]) || anyListWord(latinise(m[0].replace(INVISIBLE, '')))) {
      push(m[0], start);
      continue;
    }
    // Invisible characters joining words: split there.
    let at = 0;
    for (const piece of m[0].split(INVISIBLE)) {
      push(piece, start + m[0].indexOf(piece, at));
      at = m[0].indexOf(piece, at) + piece.length;
    }
  }
  return out;
};

/**
 * Numbers written out, "one" to "twenty", "first" to "twentieth" ("twenty-first" is two of them), and their values.
 * Eleven are BIP39 words ("one", "two", "three", "six", "seven", "eight", "ten", "twelve", "twenty", "first", "second"),
 * and in "the first word is X. the second word is Y" each is a different word between the phrase words (round-3 review
 * of b-Aware row 353). A second reading of the text treats those that count a list as numbering, like digits; the first
 * reading keeps them all as words.
 */
const SPELLED_VALUE = new Map<string, number>();
'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'
  .split(' ')
  .forEach((w, i) => SPELLED_VALUE.set(w, i + 1));
'first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth'
  .split(' ')
  .forEach((w, i) => SPELLED_VALUE.set(w, i + 1));
/** Spelled numbers needed in the text before the second reading runs: a numbered phrase has 12 or more. */
const MIN_SPELLED = 3;

/** Raw tokens that stand where a phrase word goes: straight after "is" or "was", or after ":" or "=". */
const phraseSlots = (raw: Raw[], text: string): boolean[] =>
  raw.map(
    (r, i) =>
      i > 0 && (/[:=]/.test(text.slice(raw[i - 1].end, r.start)) || ['is', 'was'].includes(fold(raw[i - 1].text))),
  );

/**
 * The spelled numbers that count a list: each one that continues the count from the last (first, second, third…), or
 * that the next one continues (a skipped or mistyped number). Two readings, by where the numbering sits:
 *  - `inSlot` false, numbers outside phrase slots only: a phrase that holds a spelled number keeps it as a word, "the
 *    fifth word is three", "word one is two, word two is …". Reading every spelled number as numbering dropped such a
 *    phrase word and the list got through (round-4 review of b-Aware row 353: about 1 list in 16 at 12 words).
 *  - `inSlot` true, numbers in phrase slots only: "X is first, Y is second" puts the numbering after "is", and with
 *    only the first reading 88% of such 12-word lists got through (round-5 review). A phrase word there is never in a
 *    slot, so "seven is seventh" keeps its "seven".
 * A spelled number straight after "of" is a count, not a position ("word eleven of twelve is X"): it is numbering but
 * does not move the count, which made "word twelve" look out of order (round-5 review: 47% of 12-word lists got through).
 * "twenty-first" and "twenty one" are one number. Null when fewer than MIN_SPELLED numbers count.
 */
const countingNumbers = (raw: Raw[], text: string, slots: boolean[], inSlot: boolean): boolean[] | null => {
  const out = new Array<boolean>(raw.length).fill(false);
  const found: Array<{ from: number; to: number; value: number }> = [];
  const totals: Array<{ from: number; to: number }> = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].digits || slots[i] !== inSlot) continue;
    const form = fold(raw[i].text);
    const value = SPELLED_VALUE.get(form);
    if (value === undefined) continue;
    const unit = i + 1 < raw.length && !raw[i + 1].digits ? SPELLED_VALUE.get(fold(raw[i + 1].text)) : undefined;
    const compound =
      form === 'twenty' && unit !== undefined && unit < 10 && /^[\s-]*$/.test(text.slice(raw[i].end, raw[i + 1].start));
    const n = { from: i, to: compound ? i + 1 : i, value: compound ? 20 + (unit as number) : value };
    if (i > 0 && !raw[i - 1].digits && fold(raw[i - 1].text) === 'of') totals.push(n);
    else found.push(n);
    i = n.to;
  }
  let last = 0;
  let counted = 0;
  found.forEach(({ from, to, value }, k) => {
    // The first number must be continued by the next, or by the one after when it is the same number straight after
    // it ("the first one is X and the second one is Y"): "eight is first, view is second" starts at "first", and taking
    // "eight" (a phrase word) as the start dropped it (round-5 review layout, after "Restore failed:").
    const next = found[k + 1];
    const continued = next?.value === value + 1;
    const starts = continued || (next?.value === value && next.from === to + 1 && found[k + 2]?.value === value + 1);
    if (last ? value !== last + 1 && !continued : !starts) return;
    out.fill(true, from, to + 1);
    last = value;
    counted++;
  });
  if (counted < MIN_SPELLED) return null;
  for (const { from, to } of totals) out.fill(true, from, to + 1);
  return out;
};

/** One wordlist's reading of the text. `numbers`: the spelled numbers read as numbering, or null for none. */
const classify = (raw: Raw[], list: Wordlist, slots: boolean[], numbers: boolean[] | null): Token[] => {
  let numbered = false;
  return raw.map((r, i) => {
    if (r.digits) return { start: r.start, end: r.end, kind: 'noise', form: '' };
    const form = fold(r.text);
    if (numbers?.[i]) {
      numbered = true;
      return { start: r.start, end: r.end, kind: 'noise', form };
    }
    const word = list.lookup.get(form) ?? (list.latin && LATIN.test(form) ? list.lookup.get(bare(form)) : undefined);
    // A word with numbering straight after it is a label even after ":" ("Restore failed: word one is …").
    const next = raw[i + 1];
    const slot = slots[i] && !(next && (next.digits || SPELLED_VALUE.has(fold(next.text))));
    const t: Token = { start: r.start, end: r.end, kind: word ? 'bip' : 'other', form, word, slot, numbered };
    numbered = false;
    return t;
  });
};

/** Gaps between the list words of tokens[a..b] that hold a spelled number read as numbering. */
const numberedGaps = (tokens: Token[], [a, b]: [number, number]): number => {
  let n = 0;
  let seen = false;
  for (let i = a + 1; i <= b; i++) {
    if (tokens[i].numbered) seen = true;
    if (tokens[i].kind === 'bip') {
      if (seen) n++;
      seen = false;
    }
  }
  return n;
};

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

/**
 * Passes 1 and 2 over one classification. Spans are [first word index, last word index] into `words`. A label (a
 * demoted repeat) counts as an other word for density, but not toward MAX_GAP or the fillers of 2a: "my 2nd word is X"
 * puts "my", "word" and "is" between two phrase words, and counting "word" broke every such list (round-3 review).
 */
const passes = (words: Token[], list: Wordlist, maxGap: number): Array<[number, number]> => {
  const n = words.length;
  const out: Array<[number, number]> = [];
  // Pass 1 holds at e when bip - 4 * other >= 0 over [s, e], i.e. pre[e + 1] >= pre[s]. ahead[i]: the highest
  // pre[e + 1] for a list word e from i up to where the stretch ends (the third other word in a row).
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + (words[i].kind === 'bip' ? 1 : -4);
  const ahead = new Float64Array(n + 1).fill(-Infinity);
  // gapAt[i]: other words in a row ending at i.
  const gapAt = new Int32Array(n);
  for (let i = 0, g = 0; i < n; i++) gapAt[i] = g = words[i].kind === 'bip' ? 0 : words[i].label ? g : g + 1;
  for (let i = n - 1; i >= 0; i--) {
    if (gapAt[i] > maxGap) continue; // the loop from any s stops here
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
        else if (bip >= FILL_WORDS && fillers.size <= FILL_DISTINCT && seen.size >= bip - repeatsAllowed(bip)) best = e;
      } else {
        other++;
        if (!words[e].label) {
          fillers.add(words[e].form);
          if (++gap > maxGap) break;
        }
      }
      // Stop once nothing later can match: 2a never recovers from a third filler or a second repeat, and pass 1
      // needs a later list word that brings the density back up.
      const fillOpen =
        fillers.size <= FILL_DISTINCT && seen.size >= bip - repeatsAllowed(PHRASE_LENGTHS[PHRASE_LENGTHS.length - 1]);
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
  // and code nearly always do and a phrase rarely does. About 1 valid phrase in 30 does repeat one word, and with a
  // different filler after each word it got through (round-3 review of b-Aware row 353). So a window may repeat
  // repeatsAllowed words when at least one other word sits between every two of its words, as in a phrase written out
  // with fillers. Allowing a repeat without that found 52 new stretches in the repo's source and docs; with it, none.
  const taken = new Int32Array(n).fill(-1);
  out.forEach(([a, b], k) => taken.fill(k, a, b + 1));
  let idx: number[] = [];
  let gap = 0;
  const flush = () => {
    const m = idx.length;
    if (m >= FILL_WORDS) {
      const seq = idx.map((i) => words[i].word as string);
      const pos = seq.map((w) => list.index.get(w) as number);
      // uniqueTo[a] / oneTo[a] / distinctTo[a]: the end (exclusive) of the longest run from a, up to the longest
      // phrase, with no repeated word / at most one / at most two.
      const maxLen = PHRASE_LENGTHS[PHRASE_LENGTHS.length - 1];
      const uniqueTo = new Int32Array(m);
      const oneTo = new Int32Array(m);
      const distinctTo = new Int32Array(m);
      for (let a = 0; a < m; a++) {
        const inRun = new Set<string>();
        let repeats = 0;
        let end = a;
        for (; end < m && end - a < maxLen; end++) {
          if (inRun.has(seq[end])) {
            if (repeats === 0) uniqueTo[a] = end;
            if (repeats === 1) oneTo[a] = end;
            if (++repeats > 2) break;
          }
          inRun.add(seq[end]);
        }
        if (repeats === 0) uniqueTo[a] = end;
        if (repeats <= 1) oneTo[a] = end;
        distinctTo[a] = end;
      }
      const spacedOut = (a: number, len: number): boolean => {
        for (let k = a; k < a + len - 1; k++) if (idx[k + 1] - idx[k] < 2) return false;
        return true;
      };
      for (let a = 0; a + FILL_WORDS <= m; a++)
        for (const len of PHRASE_LENGTHS) {
          if (a + len > distinctTo[a]) break;
          const first = idx[a];
          const lastW = idx[a + len - 1];
          if (taken[first] >= 0 && taken[first] === taken[lastW]) continue;
          const repeatsOk = a + len <= (repeatsAllowed(len) > 1 ? distinctTo[a] : oneTo[a]);
          if (a + len > uniqueTo[a] && !(repeatsOk && spacedOut(a, len))) continue;
          if (checksumOk(pos.slice(a, a + len))) out.push([first, lastW]);
        }
    }
    idx = [];
  };
  for (let i = 0; i < n; i++) {
    if (words[i].kind === 'bip') {
      idx.push(i);
      gap = 0;
    } else if (idx.length && !words[i].label && ++gap > maxGap) {
      flush();
      gap = 0;
    }
  }
  flush();
  return out;
};

/**
 * A list word seen FILLER_REPEATS or more times in one stretch (gaps of up to MAX_GAP other words) is a label or a
 * key, not a phrase word: "word" in "word 1 is abandon. word 2 is ability", "index" and "value" in JSON. One in a
 * phrase slot stays a word: in "word 4 is word" the second "word" is the phrase's (round-4 review of b-Aware row 353).
 * Returns the words with the labels counted as other words, or null when there are none.
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
      if (words[i].kind === 'bip' && !words[i].slot && (count.get(words[i].form) ?? 0) >= FILLER_REPEATS) {
        out[i] = { ...words[i], kind: 'other', word: undefined, label: true };
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

/**
 * Spans [first word index, last word index] (into `words`, the non-numbering tokens) found in one wordlist. Labelled
 * matches, and in the word-numbered reading (`numbered`) all matches, may have LABELLED_GAP other words together; a
 * word-numbered match must have a spelled number in all but one of its gaps (an edge word may join it).
 */
const spansInList = (words: Token[], list: Wordlist, numbered: boolean): Array<[number, number]> => {
  const counted = (tokens: Token[], span: [number, number]) =>
    !numbered || numberedGaps(tokens, span) >= FILL_WORDS - 1;
  const found = passes(words, list, numbered ? LABELLED_GAP : MAX_GAP)
    .filter((span) => counted(words, span))
    .map((span) => withLabel(words, span));
  const demoted = demoteRepeats(words);
  if (demoted)
    for (const span of passes(demoted, list, LABELLED_GAP))
      if (labelledThroughout(demoted, words, span) && counted(demoted, span)) found.push(withLabel(demoted, span));
  return found;
};

/**
 * A labelled or word-numbered match also hides the first item's label: "my 1st word is" before the first phrase word
 * ("my [recovery words hidden]"). The label can be a phrase word too ("word" in "word 4 is word").
 */
const withLabel = (tokens: Token[], [a, b]: [number, number]): [number, number] => {
  let start = a;
  for (let j = a - 1, other = 0; j >= 0 && tokens[j].kind !== 'bip'; j--) {
    if (tokens[j].label || tokens[j].numbered) start = j;
    else if (++other > LABELLED_GAP) break;
  }
  return [start, b];
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
  const slots = phraseSlots(raw, text);
  const readings: Array<boolean[] | null> = [null];
  for (const inSlot of [false, true]) {
    const numbers = countingNumbers(raw, text, slots, inSlot);
    if (numbers) readings.push(numbers);
  }
  for (const list of LISTS)
    for (const numbers of readings) {
      const all = classify(raw, list, slots, numbers);
      let hits = 0;
      for (const t of all) if (t.kind === 'bip') hits++;
      if (hits < MIN_HITS) {
        if (numbers === null) break; // the numbered readings have no more list words than the first
        continue;
      }
      const words = all.map((t, i) => ({ t, i })).filter((x) => x.t.kind !== 'noise');
      const toks = words.map((x) => x.t);
      // The second reading only finds lists numbered in words: a spelled number before each word after the first.
      // Without this it gave ordinary text with a few numbers in it ("one step", "ten years") a second checksum try.
      const lines = wholeLineSpans(toks, text).filter((span) => !numbers || numberedGaps(toks, span) >= FILL_WORDS - 1);
      for (const [a, b] of [...spansInList(toks, list, numbers !== null), ...lines]) {
        // Take in the numbering just before the first word ("1." on its own) as well.
        let first = words[a].i;
        while (first > 0 && all[first - 1].kind === 'noise') first--;
        // And, in a word-numbered list, the numbering just after the last word ("X is twenty-fourth"): its "twenty" is
        // also a list word.
        let last = words[b].i;
        if (numbers)
          for (let j = last + 1; j < all.length && j <= words[b].i + LABELLED_GAP + 1 && all[j].kind !== 'bip'; j++)
            if (all[j].kind === 'noise' && numbers[j]) last = j;
        found.push([all[first].start, all[last].end]);
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
