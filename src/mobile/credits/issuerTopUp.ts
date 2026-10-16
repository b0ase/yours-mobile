/**
 * Pay an issuer's top-up quote (issuerCredits.ts) in one transaction and claim it. BSV: sendBsv with every P2PKH
 * output plus the memo. PNEE: the BSV-21 key check first (tokenSendHeal keysOnly, as SendBsv21View does, so no
 * input is signed with a key record that doesn't match), then sendBsv21 to the quote's token outputs with the
 * quote's P2PKH outputs and the memo appended, guarded so nothing else (beyond one indexer fee) is paid.
 * For BSV and PNEE the claim carries the raw transaction, so the issuer need not wait for an indexer.
 */
import { Beef, P2PKH, Transaction } from '@bsv/sdk';
import { sendBsv, sendBsv21, type OneSatContext } from '@1sat/actions';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { getErrorMessage } from '../../utils/tools';
import { maxOverlayFee, type OverlayFee } from '../wallet/send/tokenFee';
import {
  buildSpend,
  tokenSpendProblem,
  withExtraOutputs,
  type IssuerAccept,
  type Quote,
  type TokenSpend,
} from './issuerCredits';

/** Raw tx hex from what a send returns (AtomicBEEF, BEEF, or raw bytes). */
export function rawTxHex(tx: number[] | undefined, txid: string): string | undefined {
  if (!tx?.length) return undefined;
  try {
    return Transaction.fromAtomicBEEF(tx).toHex();
  } catch {
    /* not atomic */
  }
  try {
    const t = Beef.fromBinary(tx).findTxid(txid)?.tx;
    if (t) return t.toHex();
  } catch {
    /* not BEEF */
  }
  try {
    const t = Transaction.fromBinary(tx);
    return t.id('hex') === txid ? t.toHex() : undefined;
  } catch {
    return undefined;
  }
}

const guardTokenSpend = <W extends object>(
  wallet: W,
  spend: TokenSpend,
  fee: { feeScript: string; maxSats: number } | null,
): W =>
  new Proxy(wallet, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'createAction') return (v as (...a: unknown[]) => unknown).bind(target);
      return (args: { outputs?: { lockingScript: string; satoshis: number }[] }, ...rest: unknown[]) => {
        const problem = tokenSpendProblem(args.outputs ?? [], spend.extraOutputs, fee);
        if (problem) throw new Error(`${problem} Nothing was sent.`);
        return (v as (...a: unknown[]) => unknown).call(target, args, ...rest);
      };
    },
  });

/** The token's indexer fee for this many recipient outputs (shown on the approval sheet), or null. */
export async function tokenIndexerFee(ctx: OneSatContext, tokenId: string, recipients: number) {
  try {
    const d = await ctx.services?.bsv21?.getTokenDetails(tokenId, { fresh: true });
    return maxOverlayFee(d?.status?.fee_address, d?.status?.fee_per_output, recipients);
  } catch {
    return null;
  }
}

export type PaidTopUp = { txid: string; rawtx?: string };

/** Build, sign and broadcast the quote's transaction. Throws with a plain message; nothing is sent on a throw before signing. */
export async function payQuote(
  ctx: OneSatContext,
  quote: Quote,
  accept: IssuerAccept,
  /** The indexer fee the person saw on the approval sheet (PNEE); the send never pays more. */
  confirmedFee?: OverlayFee | null,
): Promise<PaidTopUp> {
  if (quote.expiresAt <= Date.now()) throw new Error('That quote has expired. Try again.');
  const spend = buildSpend(quote, accept);
  if (spend.kind === 'bsv') {
    const res = await sendBsv.execute(ctx, { requests: spend.requests });
    if (!res.txid || res.error) throw new Error(getErrorMessage(res.error ?? 'The top-up was not sent'));
    return { txid: res.txid, rawtx: rawTxHex(res.tx, res.txid) };
  }
  // Never sign with a token record whose key doesn't derive its output (5.2.25): the key check from #121.
  await sendMessageAsync({ action: 'BSV21_FIX_UNSEEN', tokenId: spend.tokenId, keysOnly: true }).catch(() => undefined);
  const fee =
    confirmedFee === undefined ? await tokenIndexerFee(ctx, spend.tokenId, spend.recipients.length) : confirmedFee;
  const wallet = withExtraOutputs(
    guardTokenSpend(
      ctx.wallet,
      spend,
      fee ? { feeScript: new P2PKH().lock(fee.address).toHex(), maxSats: fee.sats } : null,
    ),
    spend.extraOutputs,
  );
  // The guard sees the outputs after ours are appended: wrap the guard inside, ours outside.
  const res = await sendBsv21.execute({ ...ctx, wallet }, { tokenId: spend.tokenId, recipients: spend.recipients });
  if (!res.txid || res.error) throw new Error(getErrorMessage(res.error ?? 'The top-up was not sent'));
  return { txid: res.txid, rawtx: rawTxHex(res.tx, res.txid) };
}
