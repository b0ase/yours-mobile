/**
 * Sign OUR inputs of a checked Memepool template, and nothing else, through the wallet's own BRC-100 signing path
 * (createSignature with hashToDirectlySign, as @1sat/actions signP2PKHInput and launchpad tokenSpends do). The
 * signature type is fixed here to SIGHASH_ALL|FORKID: it commits to every input and output, so Memepool cannot add,
 * drop or reroute anything after we sign. THIS FILE MOVES MONEY (money-paths.txt).
 */
import {
  Hash,
  PublicKey,
  TransactionSignature,
  UnlockingScript,
  Utils,
  LockingScript,
  type Transaction,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk';
import { SIGHASH_ALL_FORKID } from './constants';
import { parseBsv21Transfer, parseP2pkh } from './script';
import type { Template } from './validate';

/** The BRC-100 key that controls one of our offered coins. */
export type CoinKey = { protocolID: WalletProtocol; keyID: string };

/** The BIP-143 (FORKID) digest our input `index` signs, from the template alone. */
export function sighashDigest(t: Template, index: number): number[] {
  const input = t.inputs[index];
  const preimage = TransactionSignature.format({
    sourceTXID: input.txid,
    sourceOutputIndex: input.vout,
    sourceSatoshis: input.satoshis,
    transactionVersion: t.version ?? 1,
    otherInputs: t.inputs
      .filter((_, j) => j !== index)
      .map((i) => ({ sourceTXID: i.txid, sourceOutputIndex: i.vout, sequence: 0xffffffff })) as never,
    inputIndex: index,
    outputs: t.outputs.map((o) => ({ lockingScript: LockingScript.fromHex(o.script), satoshis: o.satoshis })) as never,
    inputSequence: 0xffffffff,
    subscript: LockingScript.fromHex(input.script),
    lockTime: t.lockTime ?? 0,
    scope: SIGHASH_ALL_FORKID,
  });
  return Hash.sha256(Hash.sha256(preimage));
}

/**
 * Unlocking scripts for exactly `indexes` (our inputs, from verifyTemplate). Each key's public key must hash to the
 * coin's own lock before its signature is returned, so a wrong key can never sign by accident.
 */
export async function signOurInputs(
  wallet: WalletInterface,
  t: Template,
  indexes: number[],
  keyFor: (index: number) => CoinKey | undefined,
): Promise<Record<string, string>> {
  const unlocks: Record<string, string> = {};
  for (const idx of indexes) {
    const input = t.inputs[idx];
    if (!input || input.owner !== 'user') throw new Error('Refusing to sign an input that is not ours.');
    const key = keyFor(idx);
    if (!key) throw new Error('Refusing to sign: no key for one of your coins.');
    const { publicKey } = await wallet.getPublicKey({
      protocolID: key.protocolID,
      keyID: key.keyID,
      counterparty: 'self',
      forSelf: true,
    });
    const pkh = Utils.toHex(PublicKey.fromString(publicKey).toHash() as number[]);
    const lockPkh = parseBsv21Transfer(input.script)?.pkh ?? parseP2pkh(input.script);
    if (pkh !== lockPkh) throw new Error('Refusing to sign: that coin is not locked to this wallet’s key.');
    const { signature } = await wallet.createSignature({
      hashToDirectlySign: sighashDigest(t, idx),
      protocolID: key.protocolID,
      keyID: key.keyID,
      counterparty: 'self',
    });
    const sig = [...signature, SIGHASH_ALL_FORKID];
    const pub = Utils.toArray(publicKey, 'hex');
    unlocks[String(idx)] = new UnlockingScript([
      { op: sig.length, data: sig },
      { op: pub.length, data: pub },
    ]).toHex();
  }
  return unlocks;
}

/**
 * "Recover now" (trade.ts recoverNow): the unlocking script for our funding coin at `index` of a transaction the
 * wallet built (createAction, signAndProcess false), signed SIGHASH_ALL|FORKID over that transaction exactly as built.
 * The coin's satoshis and script come from our own record, not the transaction, so a txid-only input still signs.
 * The key must hash to the coin's lock first.
 */
export async function signSelfSpend(
  wallet: WalletInterface,
  tx: Transaction,
  index: number,
  coin: { satoshis: number; script: string; key: CoinKey },
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({
    protocolID: coin.key.protocolID,
    keyID: coin.key.keyID,
    counterparty: 'self',
    forSelf: true,
  });
  const pkh = Utils.toHex(PublicKey.fromString(publicKey).toHash() as number[]);
  if (pkh !== parseP2pkh(coin.script))
    throw new Error('Refusing to sign: that coin is not locked to this wallet’s key.');
  const input = tx.inputs[index];
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: coin.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== index),
    inputIndex: index,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: LockingScript.fromHex(coin.script),
    lockTime: tx.lockTime,
    scope: SIGHASH_ALL_FORKID,
  });
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.sha256(Hash.sha256(preimage)),
    protocolID: coin.key.protocolID,
    keyID: coin.key.keyID,
    counterparty: 'self',
  });
  const sig = [...signature, SIGHASH_ALL_FORKID];
  const pub = Utils.toArray(publicKey, 'hex');
  return new UnlockingScript([
    { op: sig.length, data: sig },
    { op: pub.length, data: pub },
  ]).toHex();
}
