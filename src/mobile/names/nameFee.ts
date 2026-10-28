import { Utils } from '@bsv/sdk';
import { type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { fetchExchangeRate } from '../../utils/wallet';
import { usdToSats } from '../money/money';
import type { NameFee } from './paymail';

/** Matches site/lib/nameFee.js FEE_TAG / feeCommitData. */
const FEE_TAG = 'bwalletx-name-fee';
const utf8Hex = (v: string) => Utils.toHex(Utils.toArray(v, 'utf8'));

/**
 * The send requests for a name fee: the fee itself, plus a 1-sat OP_RETURN committing to the claimant's identity key
 * and the alias. The server accepts the fee only for that key and that name (b-Aware 27 Oct 2026, F-165: a bare fee
 * txid was a bearer receipt anyone watching the chain could claim first). Pure.
 */
export const nameFeeRequests = (fee: NameFee, sats: number, identityKey: string, alias: string) => [
  { address: fee.address, satoshis: sats },
  { data: [FEE_TAG, identityKey.toLowerCase(), alias.toLowerCase()].map(utf8Hex), satoshis: 1 },
];

/**
 * Pay the fee for a priced paymail name with the normal wallet send, bound to this wallet's key and `alias`.
 * Call only after the user confirmed the claim sheet. Returns what claimPaymail sends to the server.
 */
export const payNameFee = async (
  ctx: OneSatContext,
  fee: NameFee,
  alias: string,
): Promise<{ feeTxid: string; feeTx?: string }> => {
  const sats = usdToSats(fee.usd, await fetchExchangeRate('main'));
  if (!sats) throw new Error("Couldn't get the BSV price. Try again in a minute.");
  const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
  const res = await sendBsv.execute(ctx, { requests: nameFeeRequests(fee, sats, publicKey, alias) });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Payment failed'));
  return { feeTxid: res.txid, feeTx: res.tx ? Utils.toHex(res.tx) : undefined };
};
