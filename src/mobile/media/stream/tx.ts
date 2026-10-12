import { P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';

/**
 * Per-second stream payments (bMusic FIRST 12 demo). One transaction per 1-second segment, by design: the demo
 * shows Teranode throughput, so the count is never batched down. Each tx spends the previous change of the
 * session key (unconfirmed chain) and has two outputs: the server's payTo lockingScript and change.
 */

/** Fee policy agreed with the bMusic server: 100 sat/kB. */
export const FEE_SATS_PER_KB = 100;
/** 1 P2PKH input (≤148 bytes with a 73-byte DER sig) + 2 P2PKH outputs (34 each) + 10 bytes overhead. */
export const SEGMENT_TX_BYTES = 10 + 148 + 34 * 2;
/** Sweep: 1 input, 1 output. */
export const SWEEP_TX_BYTES = 10 + 148 + 34;

export const feeFor = (bytes: number, satsPerKb = FEE_SATS_PER_KB) => Math.ceil((bytes * satsPerKb) / 1000);
export const SEGMENT_FEE = feeFor(SEGMENT_TX_BYTES);

/** Estimated sats for `seconds` of listening at `satsPerSecond` (artist + network fee per tx). */
export const estimateTotal = (seconds: number, satsPerSecond = 1) => seconds * (satsPerSecond + SEGMENT_FEE);

/** The message the listener signs for each paid segment. */
export const sigMessage = (trackId: string, segment: number, txid: string) => `${trackId}:${segment}:${txid}`;
export const signSegment = (key: PrivateKey, trackId: string, segment: number, txid: string) =>
  key.sign(Utils.toArray(sigMessage(trackId, segment, txid), 'utf8')).toDER('hex') as string;

/** A spendable session coin: the tx that holds it (with ancestry linked) and its output index. */
export type Coin = { tx: Transaction; vout: number };
export const coinSats = (c: Coin) => c.tx.outputs[c.vout].satoshis ?? 0;

export class InsufficientBudget extends Error {
  constructor() {
    super('Budget used up');
  }
}

/** Build and sign one segment payment: coin in, `sats` to `lockingScript`, change back to the session key. */
export async function buildSegmentTx(key: PrivateKey, coin: Coin, lockingScript: string, sats: number): Promise<Coin> {
  const change = coinSats(coin) - sats - SEGMENT_FEE;
  if (change < 1) throw new InsufficientBudget();
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: coin.tx,
    sourceOutputIndex: coin.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  });
  tx.addOutput({ lockingScript: Script.fromHex(lockingScript), satoshis: sats });
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: change });
  await tx.sign();
  return { tx, vout: 1 };
}

/** Sweep a session coin to `lockingScript` (a wallet-derived output). Null when the coin can't pay its fee. */
export async function buildSweepTx(key: PrivateKey, coin: Coin, lockingScript: string): Promise<Transaction | null> {
  const out = coinSats(coin) - feeFor(SWEEP_TX_BYTES);
  if (out < 1) return null;
  const tx = new Transaction();
  tx.addInput({
    sourceTransaction: coin.tx,
    sourceOutputIndex: coin.vout,
    unlockingScriptTemplate: new P2PKH().unlock(key),
  });
  tx.addOutput({ lockingScript: Script.fromHex(lockingScript), satoshis: out });
  await tx.sign();
  return tx;
}
