/**
 * Is this name NFT really the OpNS name it says (owner, 28 Oct 2026)? Anyone can inscribe an application/op-ns blob
 * with any text, so a name card must not say "You own it" or offer handle / bAvatar / token / sell actions until
 * the OpNS index agrees. Three outcomes:
 *  - verified: the index's current outpoint for the name is this NFT, or the index's owner is one of our addresses.
 *  - unverified: the index disagrees or is unreachable ("The name index doesn't show this as yours yet"). It may
 *    be index lag after a real send (the owner's own miner sent aaap/a47 and the index still shows other owners),
 *    so it is never called counterfeit on that alone.
 *  - not-yours: the index clearly shows another owner AND this NFT's traced inscription origin differs from the
 *    index's origin for the name.
 * Only 'verified' unlocks actions.
 */
import { SERVICES, type Fetch } from './names';

export type OpnsVerdict = 'verified' | 'unverified' | 'not-yours';
export type OpnsIndexRecord = { outpoint?: string; origin?: string; owner?: string };

const norm = (o: unknown) => (typeof o === 'string' ? o.toLowerCase().replace('.', '_') : '');

/** Pure rule. `index` null/undefined = unreachable. `origin` = the NFT's traced origin (indexer), if known. */
export const opnsVerdict = (
  index: OpnsIndexRecord | null | undefined,
  item: { outpoint?: string; origin?: string },
  ours: Iterable<string>,
): OpnsVerdict => {
  if (!index) return 'unverified';
  const mine = new Set([...ours].filter(Boolean));
  const op = norm(item.outpoint);
  if ((op && norm(index.outpoint) === op) || (index.owner && mine.has(index.owner))) return 'verified';
  const origin = norm(item.origin);
  if (index.owner && !mine.has(index.owner) && origin && norm(index.origin) && origin !== norm(index.origin))
    return 'not-yours';
  return 'unverified';
};

/** The index record for a name (null when unreachable or unknown). */
export const fetchOpnsIndex = async (f: Fetch, name: string): Promise<OpnsIndexRecord | null> => {
  try {
    const r = await f(`${SERVICES.opnsApi}/${encodeURIComponent(name)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object') return null;
    const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : undefined);
    return { outpoint: s('outpoint'), origin: s('origin'), owner: s('owner') };
  } catch {
    return null;
  }
};

/** What the card says instead of "You own it" when not verified. */
export const verdictText = (v: OpnsVerdict | 'checking', name: string): string =>
  v === 'checking'
    ? `Checking the name index for ${name}…`
    : v === 'not-yours'
      ? `Not yours: the name index shows ${name} belongs to someone else, and this NFT is a different inscription.`
      : `Can't verify yet: the name index doesn't show this as yours yet. Actions stay hidden until it does.`;
