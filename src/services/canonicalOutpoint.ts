/**
 * The one spelling of an outpoint the wallet compares and keys on: lower-case txid, '.', and the output index with
 * no leading zeros. Everything a site names passes through here before any check, so what is checked is what is
 * built. Anything else is unreadable and refused.
 */
export const BAD_OUTPOINT_REFUSAL = "This request names a coin in a form the wallet can't read";

const OUTPOINT = /^([0-9a-fA-F]{64})[._](0|[1-9][0-9]{0,9})$/;
const MAX_VOUT = 0xffffffff;

/** Pure: the canonical form of an outpoint (either separator, any hex case), or null when it isn't one. */
export const canonicalOutpoint = (outpoint: unknown): string | null => {
  if (typeof outpoint !== 'string') return null;
  const m = OUTPOINT.exec(outpoint);
  if (!m || Number(m[2]) > MAX_VOUT) return null;
  return `${m[1].toLowerCase()}.${m[2]}`;
};

/** Pure: a wallet row whose transaction has no txid yet (the toolbox spells it 'null.3'). No site can name one. */
export const hasNoTxid = (outpoint: unknown): boolean =>
  typeof outpoint === 'string' && /^(?:null|undefined)[._]\d+$/.test(outpoint);

/**
 * A site's createAction inputs as copies with canonical outpoints (undefined when it named none). Throws on the first
 * one that can't be read. Pass the result on, not the original: the outpoint read here is then the only one used.
 */
export const canonicalInputs = <T extends object>(inputs: unknown): (T & { outpoint: string })[] | undefined => {
  if (inputs === undefined || inputs === null) return undefined;
  if (!Array.isArray(inputs)) throw new Error(BAD_OUTPOINT_REFUSAL);
  return inputs.map((input: T & { outpoint?: unknown }) => {
    const outpoint = canonicalOutpoint(input?.outpoint);
    if (outpoint === null) throw new Error(BAD_OUTPOINT_REFUSAL);
    return { ...input, outpoint };
  });
};
