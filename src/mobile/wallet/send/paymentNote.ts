import type { WalletInterface } from '@bsv/sdk';
import { resolveCallee } from '../../calls/peer';
import { sendMail } from '../../bmail/client';

/** Longest message a payment can carry (it travels as a bMail body). */
export const PAYMENT_NOTE_MAX = 500;

/** Trimmed, length-capped message, or '' when there is nothing to send. */
export const cleanPaymentNote = (raw: string | undefined) => (raw ?? '').trim().slice(0, PAYMENT_NOTE_MAX);

/**
 * The message typed on Send, delivered after the payment as a sealed bMail to the payee's identity key (subject
 * "Payment: <amount>"). Unstamped: the payment itself is the reason to read it. Only $handles and paymails resolve
 * to an identity key; a bare address has no inbox, so it returns false and nothing is sent.
 */
export const sendPaymentNote = async (
  wallet: WalletInterface,
  to: string,
  note: string,
  amountLabel: string,
  deps: { resolve?: (to: string) => Promise<{ key: string; label: string }>; send?: typeof sendMail } = {},
): Promise<boolean> => {
  const body = cleanPaymentNote(note);
  if (!body || !/[@$]/.test(to)) return false;
  const peer = await (deps.resolve ?? ((t: string) => resolveCallee((u, i) => fetch(u, i), t)))(to.trim());
  await (deps.send ?? sendMail)(wallet, {
    to: peer.key,
    toLabel: peer.label,
    sealed: { subject: `Payment: ${amountLabel}`, body },
    sats: 0,
    replyPaidSats: 0,
  });
  return true;
};
