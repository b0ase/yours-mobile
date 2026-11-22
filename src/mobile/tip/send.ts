import { type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import type { WalletInterface } from '@bsv/sdk';
import { sendMail } from '../bmail/client';
import { destinationFor } from '../names/names';
import { queuedResult } from '../../services/repeatGuard';
import { cleanNote, type TipRoute } from './tip';
import { PAYEE_CHANGED, defaultResolve, payeeChanged, type Resolve, type TipPayee } from './payee';

export type TipSent = { txid: string; pending: boolean };

/** Test seams: the name resolver and the guarded send. */
export type TipDeps = { resolve?: Resolve; send?: typeof sendBsv.execute };

/**
 * Send one tip through the wallet's normal send path (one approval: the sheet's Send button). Throws on failure.
 * Never retries: a queued send (slow network) comes back as `pending`, so the caller says "don't pay again".
 *
 * `shown` is the payee the sheet showed (payee.ts). A paymail is resolved again here and refused if it changed
 * (b-Aware row 234); it is paid with requireVerified unless the sheet showed it as not verified (row 348). Without
 * `shown` nothing was shown, so the send is strict.
 */
export async function sendTip(
  ctx: OneSatContext,
  route: TipRoute,
  sats: number,
  label: string,
  note = '',
  shown?: TipPayee,
  deps: TipDeps = {},
): Promise<TipSent> {
  const memo = cleanNote(note);
  const send = deps.send ?? sendBsv.execute;
  try {
    if (shown && (shown.route.kind !== route.kind || shown.route.to !== route.to)) throw new Error(PAYEE_CHANGED);
    if (route.kind === 'identity') {
      // BRC-29 to the identity key, delivered as a bMail (subject "Tip"), so the note travels with it.
      const sent = await sendMail(ctx.wallet as unknown as WalletInterface, {
        to: route.to,
        toLabel: label,
        sealed: { subject: 'Tip', body: memo || `A tip for ${label}` },
        sats,
        replyPaidSats: 0,
      });
      if (!sent.txid) throw new Error('The wallet did not send the tip.');
      return { txid: sent.txid, pending: false };
    }
    let to = route.to;
    let paymail = false;
    if (route.kind === 'paymail') {
      const r = await (deps.resolve ?? defaultResolve)(route.to);
      const d = destinationFor(r, 'bsv');
      if (!d.ok) throw new Error(d.error);
      const why = shown ? payeeChanged(shown, r) : null;
      if (why) throw new Error(why);
      // A host-served address may rotate: pay the one the sheet showed, never a new one it didn't.
      to = r.via === 'paymail-address' && shown?.resolved ? shown.resolved.target : d.to;
      paymail = r.targetKind === 'paymail';
    }
    const requireVerified = paymail && (!shown || shown.check === 'verified');
    const res = await send(ctx, {
      requests: [
        paymail ? { paymail: to, satoshis: sats, ...(memo ? { memo } : {}) } : { address: to, satoshis: sats },
      ],
      ...(requireVerified ? { requireVerified: true } : {}),
    } as Parameters<typeof sendBsv.execute>[1]);
    if (res.error || !res.txid) throw new Error(String(res.error ?? 'The tip did not send.'));
    return { txid: res.txid, pending: false };
  } catch (e) {
    const q = queuedResult(e);
    if (q) return { txid: q.txid, pending: true };
    throw e;
  }
}
