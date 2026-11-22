import { OPNS_KEY_UNVERIFIED, opnsKeyUnverified, type Resolved } from '../names/names';

/**
 * The wallet key a $name is handed to (releaseName). Never an OpNS key that only the index vouches for: a lying
 * index could otherwise name its own key and take the name (b-Aware opns-indexer, round 3).
 */
export const handoverKey = (
  r: Pick<Resolved, 'input' | 'via' | 'pubkey' | 'opnsChecked' | 'opnsKeySigned'>,
): string => {
  if (opnsKeyUnverified(r)) throw new Error(OPNS_KEY_UNVERIFIED(r.input));
  if (!r.pubkey) throw new Error("Couldn't find that wallet's key");
  return r.pubkey;
};
