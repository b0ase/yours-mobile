/**
 * Coins taken in on an "unspent" (or unclear) spend answer, asked about again for a while (review 20 re-check, H1).
 *
 * The 1sat spend index answers null for an output it has not seen spent yet, so for the seconds it lags behind the other
 * copy of this wallet's sweep, "unspent" is not proof. The address sync takes such a coin in (it fails open, so a payment
 * is never left out because an index is slow), and once the pull brought that sweep's change the coin counted twice
 * (13,999,980 shown for 7,999,980) until this device's own sweep of it was refused.
 *
 * Every coin taken in is remembered for RECHECK_FOR_MS. The receive watcher (each look) and the receive guard (each run)
 * ask about the ones due, at most every RECHECK_GAP_MS each, through the spend index and WhatsOnChain (both with
 * deadlines). Spent by a transaction this wallet holds: our own sweep, forgotten. Spent by one it does not hold: another
 * copy took it, so it is marked spent here (spendability only goes down; the automatic coin check re-checks it and puts
 * it back if both sources later call it unspent) and a device-sync pull is asked for. Unspent or unclear: asked again.
 */
import type { SpendCheck } from './spendCheck';

export const RECHECK_FOR_MS = 10 * 60_000;
export const RECHECK_GAP_MS = 15_000;

const norm = (o: string) => o.replace('_', '.');

export function createTakenRecheck(d: {
  spends: SpendCheck;
  /** Of these txids, the ones storage holds (our own spends). */
  heldTxids: (txids: string[]) => Promise<Set<string>>;
  /** Mark this outpoint spent by `spender` here: lower its spendability only. Resolves the rows changed. */
  markSpent: (outpoint: string, spender: string) => Promise<number>;
  /** Another copy spent these: a throttled device-sync pull. */
  askPull: (spenders: string[]) => boolean;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}) {
  const now = d.now ?? Date.now;
  const list = new Map<string, { until: number; nextAt: number }>();
  let running: Promise<{ checked: number; spent: number }> | null = null;

  const once = async (force: boolean) => {
    const t = now();
    for (const [k, e] of list) if (e.until <= t) list.delete(k);
    const due = [...list].filter(([, e]) => force || e.nextAt <= t).map(([k]) => k);
    if (!due.length) return { checked: 0, spent: 0 };
    for (const k of due) list.set(k, { ...list.get(k)!, nextAt: t + RECHECK_GAP_MS });
    const answer = await d.spends(due).catch(() => new Map<string, string | null>());
    const spentBy = new Map<string, string>();
    for (const k of due) {
      const v = answer.get(k);
      if (typeof v === 'string') spentBy.set(k, v);
    }
    if (!spentBy.size) return { checked: due.length, spent: 0 };
    const ours = await d.heldTxids([...new Set(spentBy.values())]).catch(() => null);
    if (!ours) return { checked: due.length, spent: 0 }; // can't tell whose spend it is: next time
    const foreign: string[] = [];
    let spent = 0;
    for (const [k, by] of spentBy) {
      // Ours (this device's sweep) or theirs, the coin left: mark it here unless storage already has it spent.
      const n = await d.markSpent(k, by).catch((e: unknown) => {
        d.log?.(`[takenRecheck] ${k} spent by ${by}: could not mark it here:`, e);
        return -1;
      });
      if (n < 0) continue;
      list.delete(k);
      if (n > 0) spent++;
      if (!ours.has(by)) foreign.push(by);
    }
    if (spent) d.log?.(`[takenRecheck] ${spent} coin(s) taken in here were already spent elsewhere: marked spent`);
    if (foreign.length) d.askPull([...new Set(foreign)]);
    return { checked: due.length, spent };
  };

  return {
    /** Remember coins just taken in on an "unspent" or unclear answer. */
    add(outpoints: string[]) {
      const t = now();
      for (const o of outpoints) list.set(norm(o), { until: t + RECHECK_FOR_MS, nextAt: t + RECHECK_GAP_MS });
    },
    /** Ask about the ones due (all of them with force). One run at a time. */
    run(o: { force?: boolean } = {}) {
      if (!running) running = once(!!o.force).finally(() => (running = null));
      return running;
    },
    size: () => list.size,
  };
}
