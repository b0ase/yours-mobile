/**
 * A manual re-tap must not pay twice (re-review 17b, M1).
 *
 * The automatic retry is safe (spentRetry.ts), but the person can still tap Send again. When the wallet's own send is
 * refused and the refused transaction may still be on (or reach) the chain, this guard remembers it against the
 * payment's payee and amounts:
 *   - 'refused': REJECTED, but WhatsOnChain and the 1Sat stack don't both say "unknown txid" (a refusal can come for a
 *     transaction that already went out, refusalRecheck.ts; reproduced: the re-tap picked another coin and paid BOB
 *     twice);
 *   - 'doubleSpend': DOUBLE_SPEND_ATTEMPTED with a competing payment not proven mined (ARC keeps it and may mine it).
 * The next send of the same payment (same payee scripts and amounts, same account) within SEND_GUARD_WINDOW_MS first
 * asks the chain about the earlier try:
 *   - it is known: refused with "your earlier payment to this payee already went out", once (the entry is dropped, so a
 *     deliberate second payment after that goes ahead);
 *   - it is proven dead (not known, or for a double spend every competitor mined): the entry is dropped and the send
 *     goes ahead;
 *   - anything else: refused with "your last try may have gone out; check History", and kept.
 * Nothing here builds, signs or sends. Kept in session storage (the extension's worker sleeps between taps).
 */
import { EARLIER_MAYBE_OUT_MESSAGE, ownPaymentOutMessage } from '../utils/sendErrors';
import type { MayBeOut } from './spentRetry';

export const SEND_GUARD_WINDOW_MS = 60 * 60 * 1000;
export const SEND_GUARD_KEY = 'bwxSendGuard';
export const SEND_GUARD_CODE = 'WERR_EARLIER_TRY_MAY_BE_OUT';

export type SendGuardEntry = MayBeOut & { at: number };
export type SendGuardState = Record<string, SendGuardEntry>;

/** The send stopped before anything was built: an earlier try of the same payment may have gone out. */
export class SendGuardError extends Error {
  readonly code = SEND_GUARD_CODE;
  readonly isError = true;
  constructor(
    message: string,
    readonly txid?: string,
  ) {
    super(message);
    this.name = SEND_GUARD_CODE;
  }
}

/** Pure: the payment's payee scripts and amounts, order-free, for one account. Null when there is nothing to key. */
export function paymentKey(
  identityKey: string,
  outputs: { lockingScript?: string; satoshis?: number }[] | undefined,
): string | null {
  const parts = (outputs ?? []).map((o) => `${(o.lockingScript ?? '').toLowerCase()}:${Number(o.satoshis) || 0}`);
  return identityKey && parts.length ? `${identityKey}|${parts.sort().join('|')}` : null;
}

export interface SendGuardDeps {
  load: () => Promise<SendGuardState>;
  save: (s: SendGuardState) => Promise<void>;
  /** Is this txid known to the chain? true/false, null when it can't tell. */
  txKnown: (txid: string) => Promise<boolean | null>;
  /** Is this outpoint's spend by `spender` mined? */
  spendMined: (outpoint: string, spender: string) => Promise<boolean | null>;
  now?: () => number;
}

export type SendGuardDecision = { go: true } | { go: false; message: string; txid?: string };

const ask = <T>(f: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(f)
    .catch(() => null);

export function createSendGuard(d: SendGuardDeps) {
  const now = d.now ?? Date.now;
  const read = async (): Promise<SendGuardState> => {
    const s = (await ask(d.load)) ?? {};
    const t = now();
    for (const [k, e] of Object.entries(s)) if (!e || t - e.at > SEND_GUARD_WINDOW_MS || t < e.at) delete s[k];
    return s;
  };
  const write = (s: SendGuardState) => ask(() => d.save(s));
  return {
    /** May this payment go ahead? Never throws; a guard that can't read its state lets the send go ahead. */
    async check(key: string | null): Promise<SendGuardDecision> {
      if (!key) return { go: true };
      const s = await read();
      const e = s[key];
      if (!e) return { go: true };
      const known = await ask(() => d.txKnown(e.txid));
      if (known === true) {
        delete s[key];
        await write(s);
        return { go: false, message: ownPaymentOutMessage(e.txid), txid: e.txid };
      }
      let dead = known === false && e.kind === 'refused';
      if (e.kind === 'doubleSpend') {
        const comps = Object.entries(e.competitors ?? {});
        dead =
          comps.length > 0 &&
          (await Promise.all(comps.map(([op, by]) => ask(() => d.spendMined(op, by))))).every((m) => m === true);
      }
      if (dead) {
        delete s[key];
        await write(s);
        return { go: true };
      }
      return { go: false, message: EARLIER_MAYBE_OUT_MESSAGE, txid: e.txid };
    },
    /** Remember a refused try that may still go out. Never throws. */
    async record(key: string | null, m: MayBeOut | undefined): Promise<void> {
      if (!key || !m) return;
      const s = await read();
      s[key] = { ...m, at: now() };
      await write(s);
    },
  };
}

export type SendGuard = ReturnType<typeof createSendGuard>;
