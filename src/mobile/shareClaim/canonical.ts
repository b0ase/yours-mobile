import { Utils } from '@bsv/sdk';

/**
 * Canonical JSON, shared with the NPG side byte for byte: object keys sorted (UTF-16 code unit order, as
 * Array.prototype.sort), no whitespace, `undefined` members dropped, arrays kept in order, then UTF-8 bytes.
 * Numbers use JSON.stringify's form; only safe integers are signed, so there is no float ambiguity.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export const canonicalBytes = (v: unknown): number[] => Utils.toArray(canonicalJson(v), 'utf8');
