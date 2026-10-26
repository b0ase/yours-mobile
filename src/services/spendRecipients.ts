/**
 * Where a site's payment goes, on its sheet (b-Aware 26 Oct 2026, N3-3; earlier fzsusanto report). In BRC-100 the site
 * builds its own transaction, so the sheet showed only the amount. createAction's outputs are read here while the
 * action runs, and the spend sheet lists each one: its address (P2PKH, or the owner address of a 1Sat ordinal or
 * token output), "data" for OP_RETURN, or "a custom script".
 *
 * One action per site at a time, as labelsOnSpend.ts: a second concurrent action from the same site shows no list
 * rather than another action's outputs.
 */
import { Utils } from '@bsv/sdk';

export type Recipient = { to: string; satoshis: number };

const runs = new Map<string, Recipient[]>();

const P2PKH = /76a914([0-9a-f]{40})88ac$/i;

/** A short description of a locking script's payee. */
export const describeLockingScript = (hex: unknown): string => {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/i.test(hex)) return 'a custom script';
  if (/^(00)?6a/i.test(hex)) return 'data (OP_RETURN)';
  const m = P2PKH.exec(hex);
  if (!m) return 'a custom script';
  const address = Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
  // Exactly P2PKH, or P2PKH after an inscription envelope (1Sat ordinal / token).
  return hex.length === 50 ? address : `${address} (token or ordinal)`;
};

type Output = { lockingScript?: unknown; satoshis?: unknown };
type CreateArgs = { outputs?: Output[] };

/** The outputs of the action a site is running, for its spend sheet. Empty when unknown. */
export const takeRecipientsForSheet = (originator: string | undefined): Recipient[] =>
  originator ? [...(runs.get(originator) ?? [])] : [];

export function guardSpendRecipients<T extends object>(
  manager: T,
  deps: { adminOriginator: string; normalize: (o: string) => string },
): T {
  const m = manager as Record<string, unknown>;
  const create = m.createAction as ((args: CreateArgs, originator?: string) => Promise<unknown>) | undefined;
  if (typeof create !== 'function') return manager;
  m.createAction = async (args: CreateArgs, originator?: string) => {
    const site = originator && originator !== deps.adminOriginator ? deps.normalize(originator) : '';
    const outputs = Array.isArray(args?.outputs) ? args.outputs : [];
    const mine: Recipient[] | undefined =
      site && !runs.has(site) && outputs.length
        ? outputs.map((o) => ({
            to: describeLockingScript(o?.lockingScript),
            satoshis: typeof o?.satoshis === 'number' ? o.satoshis : 0,
          }))
        : undefined;
    if (mine) runs.set(site, mine);
    try {
      return await create.call(manager, args, originator);
    } finally {
      if (mine && runs.get(site) === mine) runs.delete(site);
    }
  };
  return manager;
}
