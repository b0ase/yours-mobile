import { QUEUED_MESSAGE } from '../../services/repeatGuard';
import { recordTip, tipAmountError, tipKey, tipLock, type TipContext, type TipLock, type TipRoute } from './tip';
import type { TipSent } from './send';

export const STILL_SENDING = 'That tip is still sending. Check History before sending again.';

export type TipOutcome =
  | { ok: true; toast: string; kind: 'success' | 'info'; txid: string }
  | { ok: false; error: string };

/**
 * The sheet's Send, as one testable step: amount check → in-flight lock → one send (never retried) → record →
 * toast text. `send` is sendTip bound to the wallet; `label` is the money text ("£1").
 */
export async function runTip(a: {
  route: TipRoute;
  sats: number | null;
  name: string;
  label: string;
  context: TipContext;
  send: (route: TipRoute, sats: number) => Promise<TipSent>;
  record?: typeof recordTip;
  lock?: TipLock;
  now?: () => number;
}): Promise<TipOutcome> {
  const bad = tipAmountError(a.sats);
  if (bad || a.sats === null) return { ok: false, error: bad ?? 'Enter an amount.' };
  const sats = a.sats;
  const lock = a.lock ?? tipLock;
  const key = tipKey(a.route, sats);
  if (!lock.take(key)) return { ok: false, error: STILL_SENDING };
  try {
    const r = await a.send(a.route, sats);
    (a.record ?? recordTip)({
      v: 1,
      at: (a.now ?? Date.now)(),
      txid: r.txid,
      sats,
      to: a.route.to,
      route: a.route.kind,
      context: a.context,
      ...(r.pending ? { pending: true } : {}),
    });
    return r.pending
      ? { ok: true, toast: QUEUED_MESSAGE, kind: 'info', txid: r.txid }
      : { ok: true, toast: `Sent ${a.label} to ${a.name}`, kind: 'success', txid: r.txid };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    lock.release(key);
  }
}
