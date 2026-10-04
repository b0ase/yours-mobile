import { Capacitor } from '@capacitor/core';
import { BchatClient, defaultHttp } from '../chat/api';
import { BWALLET_PAYMAIL_API } from '../names/config';
import { lookupPersonal } from '../names/claimPersonal';
import { cached, parseRoom, roomMeta, type HotRoom } from './indexer';

/**
 * Market › Tokens › X Accounts: personal tokens of people who proved their X account with
 * "Continue with X" (registered as <name>.x on bWalletX's paymail server), e.g. x.com/b0asex → $B0ASEX.
 */
export type XAccount = { name: string | null; alias: string; tokenId: string | null };

export const xAccounts = (): Promise<XAccount[]> =>
  cached(
    'x-accounts',
    async () => {
      // bWalletX's own record: paymail names registered with Continue with X (pay server).
      const r = await fetch(`${BWALLET_PAYMAIL_API}/api/paymail/social?provider=x`);
      if (!r.ok) return [];
      const { accounts } = (await r.json()) as { accounts: { name: string | null; alias: string }[] };
      const client = new BchatClient(defaultHttp(Capacitor.isNativePlatform()));
      const out: XAccount[] = [];
      for (let i = 0; i < accounts.length; i += 6) {
        const batch = accounts.slice(i, i + 6);
        const ids = await Promise.all(batch.map((a) => lookupPersonal(client, a.alias).catch(() => null)));
        batch.forEach((a, j) => out.push({ ...a, tokenId: ids[j] ? ids[j]!.replace('.', '_') : null }));
      }
      return out;
    },
    5 * 60_000,
  );

/** Rows for the board: the X accounts' tokens, using board data when the token is already listed there. */
export async function xAccountRows(board: HotRoom[]): Promise<HotRoom[]> {
  const byId = new Map(board.map((r) => [r.ref.id, r]));
  const rows = await Promise.all(
    (await xAccounts())
      .filter((a) => a.tokenId)
      .map(async (a) => {
        const ref = parseRoom('bsv21', a.tokenId!);
        if (!ref) return null;
        const known = byId.get(ref.id);
        if (known) return known;
        const meta = await roomMeta('bsv21', ref.id).catch(() => null);
        return {
          ref,
          title: meta?.title ?? `$${a.alias.replace(/\.x$/, '').toUpperCase()}`,
          subtitle: `x.com/${a.name ?? a.alias.replace(/\.x$/, '')}`,
          icon: meta?.icon ?? null,
          trades: 0,
          newListings: 0,
          floorLabel: null,
          heat: 0,
        } as HotRoom;
      }),
  );
  return rows.filter((r): r is HotRoom => !!r);
}
