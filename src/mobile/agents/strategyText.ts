/**
 * Strategy text the owner can actually see (b-Aware 315, third review). A strategy's goals go straight into b's prompt,
 * so nothing in a strategy may carry text the approval sheet can't show: Unicode tag characters, bidi controls,
 * zero-width and other format characters, variation selectors and blank-looking fillers are removed, control
 * characters too, and long runs of blank lines (which could push an instruction below the visible box) are collapsed.
 * Pure helpers; strategy.ts applies them when a strategy is parsed, loaded and read back.
 */

/**
 * Characters that render as nothing (or can hide text): every format character (Cf: bidi controls, zero-width, BOM,
 * soft hyphen, tag characters…), every default-ignorable code point (U+2065, U+FFF0-FFF8, U+E0000-E0FFF, variation
 * selectors, the combining grapheme joiner, Hangul and Khmer fillers…), private-use, unassigned and lone surrogate code
 * points, and U+FFFC. Braille blank U+2800 is a blank, not text: BLANK turns it into a space.
 */
export const INVISIBLE =
  /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\uFFFC\u115F\u1160\u3164\uFFA0]|\p{Variation_Selector}|\u034F|\u17B4|\u17B5/gu;
const CONTROL = /\p{Cc}/gu;
/** Blank-looking characters that count as spaces: everything \s matches (NBSP, U+2007, U+202F…) plus braille blank. */
const BLANK = /[\s\u2800]+/gu;
/** More than two combining marks on one base (stacked "Zalgo" text that can cover other lines) keep only the first two. */
const MARK_STACK = /(\p{M}{2})\p{M}+/gu;

/** The first `n` code points (never half a surrogate pair), trimmed: cleaning a cut string again changes nothing. */
export const cut = (s: string, n: number) => [...s].slice(0, n).join('').trim();

/** One-line text (names, versions, list items, listing spec, changelog): no hidden characters, no line breaks. */
export const cleanLine = (s: string) =>
  s.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(MARK_STACK, '$1').replace(BLANK, ' ').trim();

/**
 * Free text (goals): no hidden characters; inside a line every run of blanks is one space and trailing blanks go, so a
 * line of only blanks is empty; then at most two empty lines in a row (padding can't push text below the box).
 */
export const cleanText = (s: string) =>
  s
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(INVISIBLE, '')
    .replace(CONTROL, (c) => (c === '\n' ? c : ' '))
    .replace(MARK_STACK, '$1')
    .split('\n')
    .map((l) => l.replace(BLANK, ' ').trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

/** Every string in a value cleaned: `goals` (top level) as free text, everything else as one line. */
export const cleanDeep = <T>(v: T, key = ''): T => {
  if (typeof v === 'string') return (key === 'goals' ? cleanText(v) : cleanLine(v)) as T;
  // A list item that cleans to nothing is dropped: an empty token or address must never match anything.
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, '[]')).filter((x) => x !== '') as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, cleanDeep(x, key === '' ? k : `${key}.${k}`)]),
    ) as T;
  return v;
};

const hex = (c: string) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`;

/** One-line display: line breaks, control and hidden characters shown as escapes, so nothing forges a line. */
export const escapeLine = (s: string) =>
  s.replace(INVISIBLE, hex).replace(CONTROL, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : hex(c)));

/** Free-text display: line breaks kept, control and hidden characters shown as escapes. */
export const escapeText = (s: string) => s.replace(INVISIBLE, hex).replace(CONTROL, (c) => (c === '\n' ? c : hex(c)));

/** A list item, quoted and escaped: ["ABC, DEF"] and ["ABC", "DEF"] never look alike. */
export const quote = (s: string) => `"${escapeLine(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;

/** JSON with object keys sorted at every level, so two values compare equal exactly when their content is equal. */
export const canonicalJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
};
