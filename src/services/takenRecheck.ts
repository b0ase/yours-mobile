/**
 * Coins taken in on an "unspent" (or unclear) spend answer, asked about again for a while (review 20 re-check, H1).
 *
 * The 1sat spend index answers null for an output it has not seen spent yet, so for the seconds it lags behind the other
 * copy of this wallet's sweep, "unspent" is not proof. The address sync (and the guard) take such a coin in, and once the
 * pull brought that sweep's change the coin counted twice (13,999,980 shown for 7,999,980).
 *
 * Every coin taken in is remembered for RECHECK_FOR_MS (at most RECHECK_MAX of them). The receive watcher and the guard
 * run this; each run asks the index about the ones due in batches, and WhatsOnChain only to confirm a spender the index
 * names, a few per run (review 20, second re-check, R2). A coin is marked spent here only under the automatic coin
 * check's own rule (autoCoinResync.ts clearingSpender; second re-check, Q1): both sources name the same spender, and it
 * is not one of this wallet's own unfinished actions (unsigned, nosend, sending, unprocessed, failed). Spendability only
 * goes down, and a pull is asked for when the spender is not here. A mark is watched for MARKED_FOR_MS: when both
 * sources call the coin unspent on two runs in a row (the spender was dropped), under the coin check's own undo rule
 * (bothCallUnspent), it goes back; a confirmed spend is final.
 */
import { bothCallUnspent, clearingSpender, type WocAnswer } from './autoCoinResync';

export const RECHECK_FOR_MS = 10 * 60_000;
export const RECHECK_GAP_MS = 15_000;
/** Coins remembered at once; after a restore the oldest go first (they had the longest to be caught). */
export const RECHECK_MAX = 200;
/** WhatsOnChain lookups per run (each confirms a spender the index named). */
export const RECHECK_WOC_PER_RUN = 10;
/** How long a mark is watched for a dropped spender. */
export const MARKED_FOR_MS = 60 * 60_000;
/** Runs in a row WhatsOnChain must call a marked coin unspent before it goes back. */
export const UNDO_AFTER = 2;
const BATCH = 100;
const TXID = /^[0-9a-f]{64}$/i;

const norm = (o: string) => o.replace('_', '.');
const under = (o: string) => norm(o).replace('.', '_');

export function createTakenRecheck(d: {
  /** The 1sat spend index ("txid_vout"): spender, null/undefined when it calls it unspent; throws when it can't tell. */
  index: (batch: string[]) => Promise<(string | null | undefined)[]>;
  /** WhatsOnChain ("txid_vout"), with its deadline: spender and whether mined, null (404); throws when it can't tell. */
  woc?: (outpoint: string) => Promise<WocAnswer>;
  /** This wallet's own unfinished actions (unsigned, nosend, sending, unprocessed, failed): never spenders. */
  ownPendingTxids: () => Promise<Set<string>>;
  /** Of these txids, the ones storage holds (a spender not held means another copy: pull). */
  heldTxids: (txids: string[]) => Promise<Set<string>>;
  /** Mark this outpoint spent by `spender` here (spendability only goes down). Resolves the rows changed. */
  markSpent: (outpoint: string, spender: string) => Promise<number>;
  /** Put back a coin this marked (only rows still as it left them). Resolves the rows changed. */
  markUnspent: (outpoint: string, spender: string) => Promise<number>;
  askPull: (spenders: string[]) => boolean;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}) {
  const now = d.now ?? Date.now;
  /** Taken in, not yet shown spent. Insertion order = age. */
  const taken = new Map<string, { until: number; nextAt: number }>();
  /** Marked spent by this; watched for a dropped spender. */
  const marked = new Map<string, { spender: string; until: number; nextAt: number; misses: number }>();
  let running: Promise<{ checked: number; spent: number; restored: number }> | null = null;

  /** The index's answers for these outpoints ("txid.vout" → spender | null); missing = can't tell. */
  const askIndex = async (ops: string[]) => {
    const out = new Map<string, string | null>();
    for (let i = 0; i < ops.length; i += BATCH) {
      const b = ops.slice(i, i + BATCH);
      try {
        const r = await d.index(b.map(under));
        if (!Array.isArray(r) || r.length !== b.length) continue;
        b.forEach((o, j) => {
          const v = r[j];
          if (typeof v === 'string' && TXID.test(v)) out.set(o, v.toLowerCase());
          else if (v === null || v === undefined) out.set(o, null);
        });
      } catch {
        /* can't tell: next run */
      }
    }
    return out;
  };

  const once = async (force: boolean) => {
    const t = now();
    for (const [k, e] of taken) if (e.until <= t) taken.delete(k);
    for (const [k, e] of marked) if (e.until <= t) marked.delete(k);
    const dueTaken = [...taken].filter(([, e]) => force || e.nextAt <= t).map(([k]) => k);
    const dueMarked = [...marked].filter(([, e]) => force || e.nextAt <= t).map(([k]) => k);
    if (!dueTaken.length && !dueMarked.length) return { checked: 0, spent: 0, restored: 0 };
    for (const k of dueTaken) taken.set(k, { ...taken.get(k)!, nextAt: t + RECHECK_GAP_MS });
    for (const k of dueMarked) marked.set(k, { ...marked.get(k)!, nextAt: t + RECHECK_GAP_MS });

    const ix = await askIndex([...dueTaken, ...dueMarked]);
    // Read only when the index names a spender for a coin taken in (the common run asks storage nothing).
    const named = dueTaken.some((k) => typeof ix.get(k) === 'string');
    const own = named ? await d.ownPendingTxids().catch(() => null) : new Set<string>();
    if (!own) return { checked: 0, spent: 0, restored: 0 }; // can't tell which spenders are ours: next run
    const isSpender = (x: unknown): x is string => typeof x === 'string' && TXID.test(x) && !own.has(x.toLowerCase());
    let wocLeft = RECHECK_WOC_PER_RUN;
    /** WhatsOnChain's answers this run (a spend already confirmed when it is marked is final). */
    const seen = new Map<string, WocAnswer>();
    const askWoc = d.woc
      ? (o: string) => async (): Promise<WocAnswer | undefined> => {
          if (wocLeft <= 0) return undefined;
          wocLeft--;
          try {
            const w = await d.woc!(under(o));
            seen.set(o, w);
            return w;
          } catch {
            return undefined;
          }
        }
      : undefined;

    let spent = 0;
    const foreign: string[] = [];
    for (const k of dueTaken) {
      // WhatsOnChain only when the index names a spender (confirmedAlone false): R2.
      if (!isSpender(ix.get(k))) continue;
      const by = await clearingSpender(ix.get(k), askWoc?.(k), isSpender, false);
      if (!by) continue;
      const n = await d.markSpent(k, by).catch((e: unknown) => {
        d.log?.(`[takenRecheck] ${k} spent by ${by}: could not mark it here:`, e);
        return -1;
      });
      if (n < 0) continue;
      taken.delete(k);
      if (n > 0) {
        spent++;
        // Watched for a dropped spender, unless WhatsOnChain already has it mined.
        if (!seen.get(k)?.confirmed)
          marked.set(k, { spender: by, until: t + MARKED_FOR_MS, nextAt: t + RECHECK_GAP_MS, misses: 0 });
      }
      foreign.push(by);
    }

    // The undo, under the coin check's own rule (autoCoinResync bothCallUnspent): only when the index answers unspent
    // AND WhatsOnChain says not spent, on two runs in a row. While either still names the spender it stays marked (a
    // WhatsOnChain that flaps never undoes a real spend; third re-check). WhatsOnChain naming it mined: final.
    let restored = 0;
    for (const k of dueMarked) {
      const m = marked.get(k);
      if (!m) continue;
      let w: WocAnswer | undefined;
      const clear = await bothCallUnspent(
        ix.get(k),
        askWoc
          ? async () => {
              w = await askWoc(k)();
              return w;
            }
          : undefined,
      );
      if (w && w.confirmed && w.txid.toLowerCase() === m.spender) {
        marked.delete(k); // mined: final
        continue;
      }
      if (!clear) {
        // A source still names a spender: the count starts again. Neither could answer: left as it was.
        if (typeof ix.get(k) === 'string' || w) marked.set(k, { ...m, misses: 0 });
        continue;
      }
      if (m.misses + 1 < UNDO_AFTER) {
        marked.set(k, { ...m, misses: m.misses + 1 });
        continue;
      }
      const n = await d.markUnspent(k, m.spender).catch(() => -1);
      if (n < 0) continue;
      marked.delete(k);
      if (n > 0) restored++;
      d.log?.(`[takenRecheck] ${k}: both sources call it unspent (its spender ${m.spender} was dropped); put back`);
    }

    if (spent) d.log?.(`[takenRecheck] ${spent} coin(s) taken in here were already spent elsewhere: marked spent`);
    if (foreign.length) {
      const held = await d.heldTxids([...new Set(foreign)]).catch(() => new Set(foreign));
      const pull = [...new Set(foreign)].filter((x) => !held.has(x));
      if (pull.length) d.askPull(pull);
    }
    return { checked: dueTaken.length + dueMarked.length, spent, restored };
  };

  return {
    /** Remember coins just taken in on an "unspent" or unclear answer (the oldest drop past RECHECK_MAX). */
    add(outpoints: string[]) {
      const t = now();
      for (const o of outpoints) {
        const k = norm(o);
        taken.delete(k);
        taken.set(k, { until: t + RECHECK_FOR_MS, nextAt: t + RECHECK_GAP_MS });
      }
      while (taken.size > RECHECK_MAX) taken.delete(taken.keys().next().value!);
    },
    /** Ask about the ones due (all of them with force). One run at a time. */
    run(o: { force?: boolean } = {}) {
      if (!running) running = once(!!o.force).finally(() => (running = null));
      return running;
    },
    size: () => taken.size,
  };
}
