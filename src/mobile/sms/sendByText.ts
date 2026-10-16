/**
 * Send by text: Open Drops / X invites for a phone number. Non-custodial:
 *   1. a fresh one-time key on THIS device; the wallet funds its address (normal approval sheet);
 *   2. the key is kept here, encrypted (same vault as X invites, slot "sms-drops"), so the sender
 *      can sweep it back after expiry;
 *   3. bit-sign gets the address, the BEEF and the link fragment, verifies the funding, and texts
 *      the link. The recipient opens it and sweeps into a new or existing bWalletX.
 * ⚠ The fragment (one-time key) passes through bit-sign and the SMS provider in transit. It is
 * never stored server-side, and it controls only this small amount.
 */
import { P2PKH, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import {
  addressOf,
  newInviteKey,
  rememberInvites,
  loadStoredInvites,
  sweepInvite,
  type StoredInvite,
} from '../chat/xInvites';
import { PhoneApi, normE164 } from './phoneApi';

/** Off until bit-sign switches SMS on (owner). The UI also hides it whenever the server answers 503. */
export const SEND_BY_TEXT_ENABLED = false;
export const DROP_VAULT = 'sms-drops';
export const MIN_DROP_SATS = 1000;

export async function sendByText(
  ctx: OneSatContext,
  api: PhoneApi,
  m: { to: string; sats: number },
): Promise<{ code: string; to: string }> {
  const to = normE164(m.to);
  if (!to) throw new Error('Enter a phone number, e.g. +44 7700 900123');
  if (!Number.isInteger(m.sats) || m.sats < MIN_DROP_SATS) throw new Error(`Send at least ${MIN_DROP_SATS} sats`);
  const key = newInviteKey();
  const address = addressOf(key);
  const res = await ctx.wallet.createAction({
    description: `Send by text to •••• ${to.slice(-4)}`,
    outputs: [{ lockingScript: new P2PKH().lock(address).toHex(), satoshis: m.sats, outputDescription: 'Text claim' }],
    options: { randomizeOutputs: false },
  });
  if (!res.txid || !res.tx) throw new Error('The wallet did not send it');
  const wif = key.toWif();
  const local: StoredInvite = {
    code: '',
    x_handle: to.slice(-4),
    funded_address: address,
    wif,
    txid: res.txid,
    url: '',
    created_at: new Date().toISOString(),
  };
  // keep the key BEFORE the server call, so a failure can always be swept back
  await rememberInvites(ctx.wallet, DROP_VAULT, [{ ...local, code: `pending-${res.txid}` }]);
  const r = await api.createDrop({
    to,
    funded_address: address,
    funding_txid: res.txid,
    beef: Utils.toHex(res.tx),
    amount_sats: m.sats,
    wif,
  });
  if (!r.code) throw new Error('The server did not record the text');
  await rememberInvites(ctx.wallet, DROP_VAULT, [{ ...local, code: r.code }]);
  return { code: r.code, to: r.to || `•••• ${to.slice(-4)}` };
}

/** The sender sweeps an unclaimed drop back with the key kept on this device, then tells bit-sign. */
export async function reclaimDrop(ctx: OneSatContext, api: PhoneApi, code: string): Promise<string> {
  const mine = (await loadStoredInvites(ctx.wallet, DROP_VAULT)).find((d) => d.code === code);
  if (!mine) throw new Error('This device does not hold that claim key');
  const r = await sweepInvite(ctx, mine.wif, mine.txid);
  if (!r.satsTxid) throw new Error('Nothing to reclaim');
  if (!code.startsWith('pending-')) await api.reclaimed(code, r.satsTxid).catch(() => undefined);
  return r.satsTxid;
}
