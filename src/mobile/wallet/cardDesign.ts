import type { AccentId, CardPatternId } from '../theme/accents';

/**
 * Design your card › Patterns / Art / Collections / Subscribe (owner, 14 Oct 2026): what the card front shows when
 * it is not the account's own picture. Kept per account on this device next to the card picture (cardFrontArt.ts),
 * same mechanism: localStorage plus an event so the card re-reads it. A picture or NFT on the card clears it.
 */
export type PackId = 'vexvoid' | 'npg' | 'npgx';
export type SubFeed = 'bart' | 'bmusic' | 'bpics';

export type CardDesign =
  | { kind: 'pattern'; id: CardPatternId; follow: boolean; colour?: AccentId }
  | { kind: 'art'; id: string }
  | { kind: 'pack'; pack: PackId; id: string }
  /** MOCK (card-art subscriptions): weekly pick from a feed, 1p a week. Nothing is paid. */
  | { kind: 'sub'; feed: SubFeed; week: number; paid: number; active: boolean };

export const CARD_DESIGN_EVENT = 'bw-card-design-changed';
const KEY = (k: string) => 'bw-card-design:' + k.toLowerCase();

export function loadCardDesign(identityPubKey: string | null | undefined): CardDesign | null {
  if (!identityPubKey) return null;
  try {
    const v = JSON.parse(localStorage.getItem(KEY(identityPubKey)) ?? 'null');
    return v && typeof v === 'object' && typeof v.kind === 'string' ? (v as CardDesign) : null;
  } catch {
    return null;
  }
}

export function saveCardDesign(identityPubKey: string | null | undefined, d: CardDesign | null): void {
  if (!identityPubKey) return;
  try {
    if (d) localStorage.setItem(KEY(identityPubKey), JSON.stringify(d));
    else localStorage.removeItem(KEY(identityPubKey));
  } catch {
    /* private mode: lasts this session only */
  }
  try {
    window.dispatchEvent(new Event(CARD_DESIGN_EVENT));
  } catch {
    /* no window (tests) */
  }
}
