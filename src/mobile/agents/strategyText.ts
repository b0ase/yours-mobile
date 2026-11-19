/**
 * Strategy text the owner can actually see (b-Aware 315, third review). A strategy's goals go straight into b's prompt,
 * so nothing in a strategy may carry text the approval sheet can't show: Unicode tag characters, bidi controls,
 * zero-width and other format characters, variation selectors and blank-looking fillers are removed, control
 * characters too, and long runs of blank lines (which could push an instruction below the visible box) are collapsed.
 * Pure helpers; strategy.ts applies them when a strategy is parsed, loaded and read back.
 */

/**
 * Characters that render as nothing (or can hide text): every format character (Cf: bidi controls U+200E/F,
 * U+202A-202E, U+2066-2069, zero-width U+200B-200D, U+2060-2064, U+FEFF, soft hyphen, tag characters U+E0001,
 * U+E0020-E007F…), the rest of the tag block, variation selectors, the combining grapheme joiner and blank fillers.
 */
export const INVISIBLE =
  /[\p{Cf}\u{E0000}-\u{E007F}\u115F\u1160\u3164\uFFA0]|\p{Variation_Selector}|\u034F|\u17B4|\u17B5/gu;
const CONTROL = /\p{Cc}/gu;

/** One-line text (names, versions, list items, listing spec, changelog): no hidden characters, no line breaks. */
export const cleanLine = (s: string) => s.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

/**
 * Free text (goals): no hidden characters; tabs become spaces; trailing whitespace trimmed on every line; at most two
 * blank lines in a row.
 */
export const cleanText = (s: string) =>
  s
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/\t/g, ' ')
    .replace(CONTROL, (c) => (c === '\n' ? c : ''))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

/** Every string in a value cleaned: `goals` (top level) as free text, everything else as one line. */
export const cleanDeep = <T>(v: T, key = ''): T => {
  if (typeof v === 'string') return (key === 'goals' ? cleanText(v) : cleanLine(v)) as T;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, '[]')) as T;
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
