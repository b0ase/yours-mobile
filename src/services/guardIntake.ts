/**
 * The receive guard's direct intake (initWallet receiveGuardOnce): each transaction with outputs on chain at our receive
 * addresses that storage does not count is internalized directly, bypassing the processed-tx store.
 *
 * Review 20 (5 Nov 2026):
 *  - M1: with the remote store active there is no device store to read. The guard then skipped every transaction as
 *    "held" and reported it internalized, so a payment only it could take in stayed "arriving" for good. Without a
 *    device store it internalizes as it always did.
 *  - L3: a device-store row the balance does not count (a coin waiting on admission, a quarantined row) was downloaded
 *    on every run and then "internalized" by skipping. It is now its own outcome ('held'), backed off, never downloaded
 *    and never rewritten.
 *  - What the address sync or the receive watcher took in since the guard's check ('taken-since') is neither downloaded
 *    nor internalized again; it is re-checked inside the shared internalize lock too.
 */
import type { OutpointState } from './heldOutpoints';
import type { InternalizeLock } from './internalizeLock';
import { normOutpoint, type ChainOutput } from './receiveGuard';

export type GuardIntakeOutcome = 'internalized' | 'no-match' | 'failed' | 'waiting' | 'taken-since' | 'held';

export type GuardIntakeDeps = {
  /** What the device store holds for each outpoint; undefined when this device's store is not the active one. */
  states: (outpoints: string[]) => Promise<Map<string, OutpointState> | undefined>;
  getBeef: (txid: string) => Promise<number[] | Uint8Array>;
  internalize: (beef: number[] | Uint8Array) => Promise<{ internalized: number }>;
  lock: InternalizeLock;
  backoff: { due(txid: string): boolean; fail(txid: string, err?: unknown): number; clear(txid: string): void };
};

/** 'taken-since' when every output is counted now, 'held' when all are in storage but some not counted, else null. */
const settled = (states: Map<string, OutpointState> | undefined, ops: string[]) => {
  if (!states || !ops.length) return null;
  const s = ops.map((o) => states.get(o) ?? 'absent');
  if (s.every((x) => x === 'accounted')) return 'taken-since' as const;
  if (s.every((x) => x !== 'absent')) return 'held' as const;
  return null;
};

export async function guardIntake(
  missing: ChainOutput[],
  d: GuardIntakeDeps,
): Promise<{ txid: string; outcome: GuardIntakeOutcome; error?: unknown }[]> {
  const out: { txid: string; outcome: GuardIntakeOutcome; error?: unknown }[] = [];
  const txids = [...new Set(missing.map((o) => normOutpoint(o.outpoint).split('.')[0]))];
  for (const txid of txids) {
    if (!d.backoff.due(txid)) {
      out.push({ txid, outcome: 'waiting' });
      continue;
    }
    const ops = missing.map((o) => normOutpoint(o.outpoint)).filter((o) => o.startsWith(`${txid}.`));
    try {
      // Before any download (L3).
      const before = settled(await d.states(ops), ops);
      if (before) {
        if (before === 'held') d.backoff.fail(txid, 'held in storage, not counted');
        else d.backoff.clear(txid);
        out.push({ txid, outcome: before });
        continue;
      }
      const beef = await d.getBeef(txid);
      const r = await d.lock(async () => {
        const now = settled(await d.states(ops), ops);
        return now ? { settled: now } : await d.internalize(beef);
      });
      if ('settled' in r) {
        if (r.settled === 'held') d.backoff.fail(txid, 'held in storage, not counted');
        else d.backoff.clear(txid);
        out.push({ txid, outcome: r.settled });
      } else if (r.internalized) {
        d.backoff.clear(txid);
        out.push({ txid, outcome: 'internalized' });
      } else {
        d.backoff.fail(txid, 'no output matched');
        out.push({ txid, outcome: 'no-match' });
      }
    } catch (error) {
      d.backoff.fail(txid, error);
      out.push({ txid, outcome: 'failed', error });
    }
  }
  return out;
}
