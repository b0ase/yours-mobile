/**
 * OrdLock v1 (the original 1Sat listing contract) had a flaw and was retired on 12 Oct 2026: every new listing is
 * OrdLock v2 and old v1 listings went back to their owners' cancel addresses. The SDK (@1sat/actions 0.0.234)
 * still decodes v1 when buying, so the wallet checks the listing script itself and only ever buys v2.
 */
import { LockingScript, Utils } from '@bsv/sdk';
import { OrdLock, OrdLockV2 } from '@1sat/templates';
import { cached } from './indexer';

/** 2 = OrdLock v2, 1 = retired v1, 0 = not a listing / unknown. */
export type OrdLockVersion = 0 | 1 | 2;

export const ordLockVersion = (script: LockingScript): OrdLockVersion => {
  try {
    if (OrdLockV2.decode(script)) return 2;
    if (OrdLock.decode(script)) return 1;
  } catch {
    /* not a listing */
  }
  return 0;
};

/** A listing output's OrdLock version, read from its locking script (GorillaPool), cached for an hour. */
export const listingVersion = (outpoint: string): Promise<OrdLockVersion> =>
  cached(
    `olv:${outpoint}`,
    async () => {
      try {
        const op = outpoint.replace('.', '_');
        const r = await fetch(`https://ordinals.gorillapool.io/api/txos/${encodeURIComponent(op)}?script=true`);
        if (!r.ok) return 0;
        const j = (await r.json()) as { script?: string };
        if (!j.script) return 0;
        return ordLockVersion(LockingScript.fromBinary(Utils.toArray(j.script, 'base64')));
      } catch {
        return 0;
      }
    },
    60 * 60_000,
  );

export const V1_LISTING_MESSAGE =
  'This is an old OrdLock v1 listing. 1Sat retired v1 (the tokens went back to the seller), so it can’t be bought.';

/** Throws unless the listing is OrdLock v2. Call before every buy. */
export const assertOrdLockV2 = async (outpoint: string) => {
  const v = await listingVersion(outpoint);
  if (v === 2) return;
  throw new Error(v === 1 ? V1_LISTING_MESSAGE : "Couldn't check this listing's contract. Try again in a moment.");
};
