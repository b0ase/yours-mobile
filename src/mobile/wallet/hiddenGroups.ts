/**
 * Hidden tokens folder (owner, 15 Oct 2026): one place under "Refresh token balances" for every token the
 * wallet list leaves out, so nothing vanishes for good.
 *  - Archived: rows the user archived (tokenRows.ts), each with Unarchive.
 *  - Quarantined: unsolicited airdrops still in Quarantine (airdrops/quarantine.ts), with Keep / Hide.
 *  - Worthless: tokens with no balance. The wallet has no token market prices yet (Bsv21TokensList's price
 *    fetch is a TODO), so "no price" cannot be told apart from "every token": only zero balance counts here.
 * None of them count toward the wallet total: that total is BSV + locked BSV + MNEE only (WalletCard /
 * PortfolioScreen), and tokens carry no USD value in this wallet. Pure.
 */
import type { AirdropItem } from '../airdrops/inbox';
import { normId } from '../airdrops/quarantine';

export type HiddenToken = { id: string; confirmed: bigint; pending: bigint };

/** A token is worthless here when it has no confirmed and no pending balance. */
export const isWorthless = (t: Pick<HiddenToken, 'confirmed' | 'pending'>) => t.confirmed <= 0n && t.pending <= 0n;

export type HiddenGroups<T> = { archived: T[]; worthless: T[]; quarantined: AirdropItem[] };

/**
 * Split held tokens into the folder's sections. `tokens` is the wallet's own list (already without quarantined
 * ids); `inbox` is the Airdrops items still waiting for Keep / Hide. An archived token stays in Archived even when
 * worthless (that's where the user put it). Quarantined: token airdrops whose id is in `quarantine`, one per id.
 */
export const hiddenGroups = <T>(
  tokens: readonly T[],
  view: (t: T) => HiddenToken,
  archived: readonly string[],
  inbox: readonly AirdropItem[] = [],
  quarantine: ReadonlySet<string> = new Set(),
): HiddenGroups<T> => {
  const arch = new Set(archived);
  const out: HiddenGroups<T> = { archived: [], worthless: [], quarantined: [] };
  for (const t of tokens) {
    const v = view(t);
    if (arch.has(v.id)) out.archived.push(t);
    else if (isWorthless(v)) out.worthless.push(t);
  }
  const seen = new Set<string>();
  for (const i of inbox) {
    if (i.asset.kind !== 'token' || !i.asset.id) continue;
    const id = normId(i.asset.id);
    if (!quarantine.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.quarantined.push(i);
  }
  return out;
};

export const hiddenCount = (g: HiddenGroups<unknown>) => g.archived.length + g.worthless.length + g.quarantined.length;
