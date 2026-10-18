/**
 * Bought themes follow the person, not the account (owner bug, 18 Oct 2026). A purchase is recorded on the server
 * against the identity key that paid (site/lib/themeBuys.js, theme_purchases.identity_key), and only that key can
 * ask "what do I own". But every account in one wallet is the same person, so a theme bought on one account is usable
 * on all of them. Each account's server answer is remembered on this device; the owned set for the open account is
 * its own answer plus what the wallet's other accounts last reported, each tagged with where it was bought.
 */
const KEY = (identityKey: string) => 'bw-owned-themes:' + identityKey.toLowerCase();

export type WalletAccount = { identityKey: string; name: string };

/** Remembers the packs the server says this identity key owns. */
export function rememberOwned(identityKey: string, packs: readonly string[]): void {
  if (!identityKey) return;
  try {
    localStorage.setItem(KEY(identityKey), JSON.stringify([...new Set(packs)]));
  } catch {
    /* storage blocked: the server answer still applies this session */
  }
}

/** The packs this identity key last reported owning (empty when never asked). */
export function recalledOwned(identityKey: string): string[] {
  if (!identityKey) return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY(identityKey)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Where each pack was bought: null = this account, else the other account's name. This account wins over others. */
export function ownedAcrossWallet(
  current: string,
  currentPacks: readonly string[],
  accounts: readonly WalletAccount[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const p of currentPacks) out.set(p, null);
  const me = current.toLowerCase();
  for (const a of accounts) {
    if (!a.identityKey || a.identityKey.toLowerCase() === me) continue;
    for (const p of recalledOwned(a.identityKey)) if (!out.has(p)) out.set(p, a.name || 'another account');
  }
  return out;
}
