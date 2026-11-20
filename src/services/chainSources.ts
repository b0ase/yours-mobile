/**
 * A second chain source for the inbound sync check (services/inboundSync.ts, review 16d D2): one WhatsOnChain outage
 * (429s from a shared address, a timeout, a blocked API) must not decide whether an honest coin is ever admitted.
 * When WhatsOnChain has no clear answer, the 1Sat stack the wallet already talks to is asked the same question:
 *  - spent?   POST /1sat/txo/spends: a spending txid is spent, an explicit null unspent, anything else unclear;
 *  - known?   GET /1sat/beef/<txid>/tx: bytes that hash to the txid are known (and its outputs, D5), 404 unknown.
 * A clear answer from either source stands; "unspent" still counts only for a transaction one of them knows.
 */
import { Transaction } from '@bsv/sdk';
import type { SpendState } from './unsentExpiry';
import type { ChainTxAnswer } from './seedChange';

export type ChainLookups = {
  spent(outpoint: string): Promise<SpendState>;
  txKnown(txid: string): Promise<'known' | 'unknown' | 'unclear'>;
  chainTx(txid: string): Promise<ChainTxAnswer>;
  /**
   * Many outpoints at once (the 1Sat stack's bulk spends lookup, up to SPENDS_BATCH a call), keyed by the outpoint each
   * answer row names. An outpoint with no clear answer is 'unclear'. The live 1sat-stack's rows (pkg/txo/routes.go
   * SpendResponse, Nov 2026) carry only spendTxid, so today every outpoint reads 'unclear' and the caller asks one by one.
   */
  spentMany?(outpoints: string[]): Promise<Map<string, SpendState>>;
};

/** Outpoints the 1Sat stack answers for in one call. */
export const SPENDS_BATCH = 100;

const TXID = /^[0-9a-f]{64}$/;
const OUTPOINT = /^[0-9a-f]{64}\.(?:0|[1-9]\d{0,9})$/;

type OneSatServices = {
  txo?: {
    getSpends?: (outpoints: string[]) => Promise<(string | null | undefined)[]>;
    /** TxoClient's own JSON request (BaseClient.request): the bulk lookup reads the raw rows, outpoints included. */
    request?: (path: string, init?: RequestInit) => Promise<unknown>;
  };
  beef?: { getRawTx?: (txid: string) => Promise<Uint8Array | number[]> };
};

const status = (e: unknown) => (e as { status?: unknown } | null)?.status;

/** The 1Sat stack's answers (the toolbox services the wallet factory returns: OneSatServices). */
export function oneSatChainLookups(services: unknown): ChainLookups | undefined {
  const s = services as OneSatServices | null;
  const txo = s?.txo;
  const beef = s?.beef;
  if (typeof txo?.getSpends !== 'function' || typeof beef?.getRawTx !== 'function') return undefined;
  const chainTx = async (txid: string): Promise<ChainTxAnswer> => {
    if (!TXID.test(txid)) return { state: 'unclear' };
    try {
      const raw = await beef.getRawTx!.call(beef, txid);
      const tx = Transaction.fromBinary(Array.from(raw));
      return tx.id('hex') === txid ? { state: 'found', rawTx: tx.toBinary() } : { state: 'unclear' };
    } catch (e) {
      return status(e) === 404 ? { state: 'unknown' } : { state: 'unclear' };
    }
  };
  return {
    spent: async (outpoint) => {
      if (!OUTPOINT.test(outpoint)) return { state: 'unclear' };
      try {
        const [by] = await txo.getSpends!.call(txo, [outpoint]);
        if (by === null) return { state: 'unspent' };
        if (typeof by === 'string' && TXID.test(by.toLowerCase())) return { state: 'spent', by: by.toLowerCase() };
      } catch {
        // no answer
      }
      return { state: 'unclear' };
    },
    // Only when the raw rows can be read: TxoClient.getSpends keeps each row's spendTxid and drops its outpoint, and an
    // answer matched by position alone could pair a spent outpoint with another's "unspent" (task 69 review, A2).
    ...(typeof txo.request === 'function'
      ? {
          spentMany: async (outpoints: string[]) => {
            const out = new Map<string, SpendState>();
            const unclear: SpendState = { state: 'unclear' };
            for (const o of outpoints) out.set(o, unclear);
            for (let i = 0; i < outpoints.length; i += SPENDS_BATCH) {
              const valid = outpoints.slice(i, i + SPENDS_BATCH).filter((o) => OUTPOINT.test(o));
              if (!valid.length) continue;
              let rows: unknown;
              try {
                rows = await txo.request!.call(txo, '/spends', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(valid),
                });
              } catch {
                continue; // no answer for this batch: all unclear
              }
              if (!Array.isArray(rows)) continue;
              // Keyed by each row's own outpoint. A row without one, for an outpoint not asked, or a second row for the
              // same outpoint is no answer: that outpoint stays unclear.
              const asked = new Set(valid);
              const said = new Map<string, SpendState | 'conflict'>();
              for (const r of rows as { outpoint?: unknown; spendTxid?: unknown }[]) {
                const op = typeof r?.outpoint === 'string' ? r.outpoint.toLowerCase().replace('_', '.') : undefined;
                if (!op || !asked.has(op)) continue;
                const by = r.spendTxid;
                const st: SpendState =
                  by === null
                    ? { state: 'unspent' }
                    : typeof by === 'string' && TXID.test(by.toLowerCase())
                      ? { state: 'spent', by: by.toLowerCase() }
                      : unclear;
                said.set(op, said.has(op) ? 'conflict' : st);
              }
              for (const [op, st] of said) if (st !== 'conflict') out.set(op, st);
            }
            return out;
          },
        }
      : {}),
    txKnown: async (txid) => {
      const r = await chainTx(txid);
      return r.state === 'found' ? 'known' : r.state;
    },
    chainTx,
  };
}

/** Ask `first`; when it has no clear answer, ask `second()` (when there is one). Never throws. */
export function eitherChainSource(first: ChainLookups, second: () => ChainLookups | undefined): ChainLookups {
  const ask = async <T extends { state: string } | string>(
    a: () => Promise<T>,
    b: (s: ChainLookups) => Promise<T>,
    unclear: T,
  ): Promise<T> => {
    const r = await a().catch(() => unclear);
    const isUnclear = (x: T) => (typeof x === 'string' ? x === 'unclear' : x.state === 'unclear');
    if (!isUnclear(r)) return r;
    const s = second();
    return s ? b(s).catch(() => unclear) : r;
  };
  return {
    // The bulk lookup is the 1Sat stack's alone; the caller asks `spent` for any outpoint it leaves unclear.
    spentMany: async (ops) =>
      (await second()
        ?.spentMany?.(ops)
        .catch(() => undefined)) ?? new Map(),
    spent: (op) =>
      ask(
        () => first.spent(op),
        (s) => s.spent(op),
        { state: 'unclear' } as SpendState,
      ),
    txKnown: (txid) =>
      ask(
        () => first.txKnown(txid),
        (s) => s.txKnown(txid),
        'unclear' as const,
      ),
    chainTx: (txid) =>
      ask(
        () => first.chainTx(txid),
        (s) => s.chainTx(txid),
        { state: 'unclear' } as ChainTxAnswer,
      ),
  };
}

/**
 * 'unknown' only when every source answers 'unknown'; 'known' when any knows the transaction; else 'unclear'. A missing
 * source makes it 'unclear'. For a decision that removes something for good (fix 7 review: a token coin relinquished
 * after a refused rebroadcast), never one source's 404 alone.
 */
export function unknownToAll(
  sources: (((txid: string) => Promise<'known' | 'unknown' | 'unclear'>) | undefined)[],
): (txid: string) => Promise<'known' | 'unknown' | 'unclear'> {
  return async (txid) => {
    if (!sources.length || sources.some((s) => !s)) return 'unclear';
    const answers = await Promise.all(sources.map((s) => s!(txid).catch(() => 'unclear' as const)));
    if (answers.includes('known')) return 'known';
    return answers.every((a) => a === 'unknown') ? 'unknown' : 'unclear';
  };
}
