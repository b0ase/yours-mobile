/**
 * Sweep plan: which classes of coins (BSV, NFTs, each token) the user can move, which are ticked by
 * default, and what a sweep actually spends. Pure, so the safety rules are tested (owner, 13 Oct 2026):
 *  - a class the user has not ticked is never swept;
 *  - a 1-sat "ordinal" whose origin traces to a BSV-20 / BSV-21 token, or whose origin could not be
 *    looked up, is a possible token: listed, never swept as an NFT (spending it as an NFT could burn it);
 *  - token classes with nothing in them (amount 0) are not offered and never show as failures.
 */
import type { IndexedOutput } from '@1sat/types';
import type { EnrichedOrdinal, ScannedAssets, TokenBalance } from '../../sweep/scanner';

export type OrdinalKind = 'nft' | 'token' | 'unknown';

const TOKEN_MARK = /bsv-?2[01]|"bsv2[01]"|bsv2[01]:|application\/bsv-20|type:Token\b/i;

/**
 * What a 1-sat output really is. `own` = its own indexer events; `origin` = the indexer's record for its
 * origin outpoint (null when the lookup failed or returned nothing). Only a positive non-token
 * inscription answer counts as an NFT; anything token-like or unknown is not swept.
 */
export function classifyOrdinal(own: readonly string[], origin: unknown): OrdinalKind {
  if (own.some((e) => TOKEN_MARK.test(e))) return 'token';
  if (origin == null) return 'unknown';
  let text = '';
  try {
    text = JSON.stringify(origin);
  } catch {
    return 'unknown';
  }
  if (TOKEN_MARK.test(text)) return 'token';
  // A real inscription: a content type on the output itself or on its origin.
  const typed =
    own.some((e) => /^type:[^/]+\/.+/.test(e)) || /"(type|contentType|content_type)"\s*:\s*"[^"/]+\/[^"]+"/.test(text);
  return typed ? 'nft' : 'unknown';
}

export type SweepClass =
  | { key: 'bsv'; label: string; safe: true }
  | { key: 'nft'; label: string; safe: true; outputs: EnrichedOrdinal[] }
  | { key: `token:${string}`; label: string; safe: true; token: TokenBalance };

export type Plan = {
  classes: SweepClass[];
  /** 1-sat outputs that may be tokens: shown with a warning, never swept. */
  possibleTokens: EnrichedOrdinal[];
};

/** Classes worth offering. `kinds` maps an ordinal outpoint to its classification (missing = unknown). */
export function buildPlan(
  assets: Pick<ScannedAssets, 'funding' | 'ordinals' | 'bsv21Tokens'>,
  kinds: ReadonlyMap<string, OrdinalKind>,
  label: { bsv: string; token: (t: TokenBalance) => string },
): Plan {
  const nfts = assets.ordinals.filter((o) => kinds.get(o.outpoint) === 'nft');
  const possibleTokens = assets.ordinals.filter((o) => kinds.get(o.outpoint) !== 'nft');
  const classes: SweepClass[] = [];
  if (assets.funding.length) classes.push({ key: 'bsv', label: label.bsv, safe: true });
  if (nfts.length) classes.push({ key: 'nft', label: `NFTs (${nfts.length})`, safe: true, outputs: nfts });
  for (const t of assets.bsv21Tokens) {
    if (t.totalAmount <= 0n || !t.outputs.length) continue;
    classes.push({ key: `token:${t.tokenId}`, label: label.token(t), safe: true, token: t });
  }
  return { classes, possibleTokens };
}

/** Ticked by default: every known-safe class. (Possible tokens are not classes, so never ticked.) */
export const defaultSelection = (p: Plan): Set<string> => new Set(p.classes.filter((c) => c.safe).map((c) => c.key));

/** "Sweep all" only when everything found is known-safe and ticked; otherwise "Sweep selected". */
export const sweepButtonLabel = (p: Plan, selected: ReadonlySet<string>): string =>
  !p.possibleTokens.length && p.classes.every((c) => selected.has(c.key))
    ? 'Sweep all to this account'
    : 'Sweep selected to this account';

/** What will be spent: only ticked classes, in a fixed order (BSV first, then NFTs, then tokens). */
export function selectedWork(p: Plan, selected: ReadonlySet<string>) {
  const pick = p.classes.filter((c) => selected.has(c.key));
  return {
    bsv: pick.some((c) => c.key === 'bsv'),
    nfts: pick.flatMap((c) => (c.key === 'nft' ? c.outputs : [])) as IndexedOutput[],
    tokens: pick.flatMap((c) => ('token' in c ? [c.token] : [])),
  };
}

/** Errors that only mean "this class had nothing to move" — neutral, not a red failure. */
const NOTHING = /^(no-inputs|no-token-amount|no-tokens|invalid-amount|insufficient-token|nothing)/i;
export const isNothingToMove = (error: string | undefined, amount?: bigint): boolean =>
  !!error && (NOTHING.test(error.trim()) || (/overlay-validation-failed/i.test(error) && amount === 0n));

export type Result = { label: string; txid?: string; error?: string; amount?: bigint };

/** Result lines to show: what moved and real failures; classes that had nothing are dropped. */
export const visibleResults = (rs: readonly Result[]): Result[] =>
  rs.filter((r) => !isNothingToMove(r.error, r.amount));
