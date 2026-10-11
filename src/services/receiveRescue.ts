/**
 * Rescue money the receive guard sees at our own address but can never credit.
 *
 * Owner, 11 Oct 2026, account $vexvoid on 5.2.0: 25,432,350 sats sat at the receive address (13WRxSg…, BRC-29
 * deposit index 0) in one confirmed output, and every site payment failed with "0 sats are spendable". The
 * receive guard found the output, re-ran internalizeAction on its transaction, and the output still never
 * reached a spendable basket: once wallet storage holds a transaction in a bad state (for example an earlier
 * internalize that recorded the output as not spendable), internalizing the same txid again changes nothing,
 * and @1sat/actions' internalizeBeef reports success either way.
 *
 * The way out is a fresh transaction. We hold the key for every deposit address (P1SAT protocol, keyID
 * "<prefix> <suffix>", counterparty self), so we spend the stuck output back to the same address in a new
 * transaction and internalize that one: a txid storage has never seen, credited like any normal payment.
 *
 * Only plain P2PKH outputs worth more than RESCUE_MIN_SATS, confirmed or older than RESCUE_MIN_AGE_MS since the
 * guard first saw them, are touched: never 1-sat ordinals or token outputs, and never a payment the normal
 * sync is still busy ingesting.
 */
import { Beef, P2PKH, SatoshisPerKilobyte, Transaction, UnlockingScript, Utils, type WalletProtocol } from '@bsv/sdk';

/** Below this, the fee eats too much of it, and 1-sat outputs are ordinals or tokens. */
export const RESCUE_MIN_SATS = 2000;
/** An unconfirmed output must have been missing this long before we move it (the sync may still credit it). */
export const RESCUE_MIN_AGE_MS = 10 * 60 * 1000;

export interface DepositDerivation {
  address: string;
  derivationPrefix: string;
  derivationSuffix: string;
}

export interface StuckOutput {
  outpoint: string; // "txid.vout"
  satoshis: number;
}

export interface RescueDeps {
  /** Raw transaction bytes for a txid. */
  getRawTx: (txid: string) => Promise<number[]>;
  /** BEEF of a (parent) transaction, with its proof chain. */
  getBeef: (txid: string) => Promise<number[]>;
  /** Whether a txid is mined (has a proof). */
  isConfirmed: (txid: string) => Promise<boolean>;
  /** The derivation for one of our addresses, or null when it isn't one of ours. */
  derivationFor: (address: string) => Promise<DepositDerivation | null>;
  /** Sign input `i` of `tx` with the deposit key (protocol + keyID, counterparty self). Returns unlocking hex. */
  signInput: (tx: Transaction, i: number, protocolID: WalletProtocol, keyID: string) => Promise<string>;
  /** Broadcast the signed transaction. Throws when the network refuses it. */
  broadcast: (tx: Transaction) => Promise<void>;
  /** Internalize the new transaction (BEEF whose last tx is the new one) for the given derivations. */
  internalize: (beef: number[], derivations: Map<string, DepositDerivation>) => Promise<number>;
  protocolID: WalletProtocol;
  feeRate: number; // sats per kB
  /** When the guard first saw each outpoint missing (ms since epoch). */
  firstSeen: (outpoint: string) => number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface RescueResult {
  txid: string;
  address: string;
  satoshis: number;
}

/** P2PKH address of an output, or null for any other script. */
export function p2pkhAddress(tx: Transaction, vout: number): string | null {
  const out = tx.outputs[vout];
  if (!out) return null;
  const chunks = out.lockingScript.chunks;
  // OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  if (
    chunks.length !== 5 ||
    chunks[0].op !== 0x76 ||
    chunks[1].op !== 0xa9 ||
    chunks[2].data?.length !== 20 ||
    chunks[3].op !== 0x88 ||
    chunks[4].op !== 0xac
  )
    return null;
  return Utils.toBase58Check(chunks[2].data, [0x00]);
}

/** Move each stuck output into a fresh transaction to the same address and credit it. Never throws. */
export async function rescueStuckOutputs(stuck: StuckOutput[], deps: RescueDeps): Promise<RescueResult[]> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = (deps.now ?? Date.now)();
  const done: RescueResult[] = [];
  for (const o of stuck) {
    const [txid, voutStr] = o.outpoint.replace('_', '.').split('.');
    const vout = Number(voutStr);
    try {
      if (o.satoshis < RESCUE_MIN_SATS) continue;
      const source = Transaction.fromBinary(await deps.getRawTx(txid));
      const address = p2pkhAddress(source, vout);
      if (!address) continue;
      const sats = source.outputs[vout].satoshis ?? 0;
      if (sats < RESCUE_MIN_SATS) continue;
      if (!(await deps.isConfirmed(txid)) && now - deps.firstSeen(o.outpoint) < RESCUE_MIN_AGE_MS) continue;
      const d = await deps.derivationFor(address);
      if (!d) {
        log(`[receiveGuard] ${o.outpoint} pays ${address}, which is not one of our deposit addresses; left alone`);
        continue;
      }
      const keyID = `${d.derivationPrefix} ${d.derivationSuffix}`;

      const tx = new Transaction();
      tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, sequence: 0xffffffff });
      tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
      // Size the fee with a placeholder unlock (signature + pubkey, ~107 bytes), then sign for real.
      tx.inputs[0].unlockingScriptTemplate = {
        sign: async () => {
          throw new Error('placeholder');
        },
        estimateLength: async () => 107,
      };
      await tx.fee(new SatoshisPerKilobyte(deps.feeRate));
      tx.inputs[0].unlockingScriptTemplate = undefined;
      const unlockHex = await deps.signInput(tx, 0, deps.protocolID, keyID);
      tx.inputs[0].unlockingScript = UnlockingScript.fromHex(unlockHex);

      await deps.broadcast(tx);
      const newTxid = tx.id('hex');
      const beef = Beef.fromBinary(await deps.getBeef(txid));
      beef.mergeTransaction(tx);
      const credited = await deps.internalize(beef.toBinary(), new Map([[address, d]]));
      const kept = tx.outputs[0].satoshis ?? 0;
      log(`[receiveGuard] swept stuck output at ${address} ${kept} sats ${newTxid} (credited ${credited})`);
      done.push({ txid: newTxid, address, satoshis: kept });
    } catch (err) {
      console.error(`[receiveGuard] rescue of ${o.outpoint} failed:`, err);
    }
  }
  return done;
}
