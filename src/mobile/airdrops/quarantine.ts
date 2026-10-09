/**
 * Token Quarantine (owner, 9 Oct 2026). Tokens that arrive from a sender you have not accepted are held in
 * Quarantine: left out of your balance, the home and token lists, and every send/sweep path, so they are never
 * spent together with your own coins (spending them together would link your coins to the sender on chain).
 * Nothing is burned or swept: the tokens stay at the same address. Keep moves one into your normal holdings
 * (un-quarantine); Hide leaves it in Quarantine, out of sight. Keep can offer "Trust this sender".
 *
 * Granularity is the token id: @1sat/actions selects token UTXOs by token id and cannot exclude single outputs,
 * so a token you already hold (bought, minted, received in a tx you made) is never quarantined, even if someone
 * airdrops more of it (that gap is documented in docs/BMAIL.md).
 */
import type { AirdropItem, InboxState } from './inbox';

export const normId = (id: string) => (id || '').toLowerCase().replace('.', '_');

/**
 * Token ids in Quarantine: unsolicited token airdrops (items) where no item of that token was kept, the issuer
 * is not trusted, and the wallet has no solicited history of that token (`solicited`: ids seen in History rows
 * that were not unsolicited transfers in).
 */
export const quarantinedTokenIds = (
  items: AirdropItem[],
  s: Pick<InboxState, 'kept'> & { trustedIssuers?: string[] },
  solicited: Iterable<string> = [],
): Set<string> => {
  const kept = new Set(s.kept);
  const trusted = new Set((s.trustedIssuers ?? []).map(normId));
  const mine = new Set([...solicited].map(normId));
  const accepted = new Set<string>();
  const seen = new Set<string>();
  for (const i of items) {
    if (i.asset.kind !== 'token' || !i.asset.id) continue;
    const id = normId(i.asset.id);
    seen.add(id);
    if (kept.has(i.key) || trusted.has(normId(i.issuer))) accepted.add(id);
  }
  return new Set([...seen].filter((id) => !accepted.has(id) && !mine.has(id)));
};

/** NFT outpoints in Quarantine (same rule, per item). */
export const quarantinedNfts = (
  items: AirdropItem[],
  s: Pick<InboxState, 'kept'> & { trustedIssuers?: string[] },
): Set<string> => {
  const kept = new Set(s.kept);
  const trusted = new Set(s.trustedIssuers ?? []);
  return new Set(
    items
      .filter((i) => i.asset.kind === 'nft' && !kept.has(i.key) && !trusted.has(i.issuer))
      .map((i) => normId(i.asset.id)),
  );
};

/** Drop quarantined tokens from a balance list (home, token list, send pickers, agent views, sweeps). */
export const withoutQuarantined = <T extends { id?: string }>(xs: T[], q: Set<string>): T[] =>
  q.size ? xs.filter((x) => !q.has(normId(x.id ?? ''))) : xs;

/** Trust an issuer: every current and future airdrop from them skips Quarantine. Also un-hides them. */
export const trustIssuer = <S extends InboxState & { trustedIssuers?: string[] }>(s: S, issuer: string): S => ({
  ...s,
  trustedIssuers: [...new Set([...(s.trustedIssuers ?? []), issuer])],
  hiddenIssuers: s.hiddenIssuers.filter((x) => x !== issuer),
});
