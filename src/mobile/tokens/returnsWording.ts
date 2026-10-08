/**
 * Returns wording (owner, 8 Oct 2026): issuers reward holders with airdrops, not "returns". Launch and token
 * profile text that promises returns gets a soft warning while typing and is blocked at publish / sign.
 * Word-boundary, case-insensitive; phrases that merely contain a word ("returns policy", "free returns",
 * "yield sign") are not flagged. A filter, not legal review (docs/LAUNCH-SOCIAL-PLAN.md).
 */
export const RETURNS_WARNING = 'Avoid promising returns. Consider describing airdrops or room access instead.';
export const RETURNS_BLOCK =
  'Remove wording that promises returns before publishing. Describe airdrops or room access instead.';

const PATTERNS: RegExp[] = [
  /\bprofits?\b(?!\s+and\s+loss)/i,
  /\bprofit[-\s]?shar(e|ing)\b/i,
  /\breturns?\b(?!\s+(policy|polic(y|ies)|label|address|window|form|key)\b)(?<!\b(free|easy|tax|no)\s+returns?)/i,
  /\bdividends?\b/i,
  /\byield(s|ing)?\b(?!\s+(sign|to)\b)/i,
  /\bAPY\b/i,
  /\bAPR\b/i,
  /\bguaranteed?\b/i,
  /\binvest(ment|ments|ing|ors?)?\b/i,
  /\bpassive\s+income\b/i,
  /\bROI\b/i,
  /\b\d+\s*x\s+gains?\b/i,
  /\bto\s+the\s+moon\b/i,
];

/** The flagged words in `text` (as written), deduplicated; empty when the text is fine. */
export const returnsWords = (text: string): string[] => {
  const out = new Set<string>();
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) out.add(m[0]);
  }
  return [...out];
};
export const hasReturnsWording = (text: string) => returnsWords(text).length > 0;
