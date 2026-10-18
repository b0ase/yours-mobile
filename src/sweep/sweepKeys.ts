/**
 * Which key signs each swept BSV input (owner, 18 Oct 2026: BSV airdrops to holders reach the ordinals address).
 * The legacy scan merges plain BSV found at the pay, ordinals and identity addresses into one funding list, so each
 * input must be signed by the key of the address it was found at. Signing them all with the pay key (as before)
 * failed for BSV at the ordinals address, which left it unspendable.
 */
export type ScannedAddress = { address: string; wif: string };

/** outpoint → WIF of the address it was scanned at (first address wins if an outpoint is listed twice). */
export const fundingOwners = (scans: { address: ScannedAddress; funding: { outpoint: string }[] }[]) => {
  const m = new Map<string, string>();
  for (const s of scans) for (const f of s.funding) if (!m.has(f.outpoint)) m.set(f.outpoint, s.address.wif);
  return m;
};

/** The WIF for each input, in order. Throws (nothing is signed) when an input has no known owner. */
export const sweepKeyWifs = (inputs: { outpoint: string }[], owners: Map<string, string>): string[] =>
  inputs.map((i) => {
    const w = owners.get(i.outpoint) ?? owners.get(i.outpoint.replace('.', '_'));
    if (!w) throw new Error(`No key for ${i.outpoint}; nothing was swept.`);
    return w;
  });
