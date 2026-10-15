/**
 * Recover a payment by transaction ID (incident 15 Oct 2026, dkg sweep 9f66943b…).
 *
 * dkg's sweep (9 legacy coins → 1 output of 586.14198569 BSV to 1HQ7kj7…) is mined and unspent, yet his wallet
 * shows the old balance and "Find mined payments" says "Nothing to restore". That repair only looks at rows its
 * storage already holds BY TXID (failed / stuck / settled-with-hidden-change). A sweep whose row is missing, or
 * whose row never got its txid, is invisible to it.
 *
 * Who controls the output: @1sat/actions sweepBsv adds no outputs of its own on a full sweep; the wallet's change
 * output absorbs everything. wallet-toolbox change is BRC-29: key = identityKey.derivePrivateKey([2,'3241645161d8'],
 * `${derivationPrefix} ${derivationSuffix}`, self), both halves 16 random bytes picked at createAction and kept ONLY
 * in the storage row of that output. So the coin belongs to the wallet's identity key, but nobody can spend it
 * without that pair: it cannot be re-derived from the seed. Recovery therefore searches every store this wallet can
 * reach (the device's own and the remote backup) for a row holding a pair whose derived script is exactly the coin's
 * locking script, with or without a txid on the row.
 *
 * What this does for one txid:
 *  1. fetch the raw tx and its merkle proof (mined only; mempool or unknown changes nothing);
 *  2. for each output: unspent on chain (conclusive answer only), and ours: a derivation pair from storage whose
 *     BRC-29 script equals the output's script (checked here, and again by the toolbox when internalizing);
 *  3. make it spendable: internalizeAction as a 'wallet payment' when storage has no settled row for the txid,
 *     otherwise repair the existing rows on the device's store (proof attached, status completed, output spendable);
 *  4. push to the backups so the remote holds it too.
 * Idempotent: an output already spendable is reported and left alone. Nothing that isn't provably ours is added.
 * Coins on a legacy address of this wallet (not BRC-29) are reported, not imported: Sweep moves those.
 */
import { Beef, MerklePath, P2PKH, Transaction } from '@bsv/sdk';
import type { KeyDeriver } from '@bsv/sdk';

export const BRC29_PROTOCOL: [2, string] = [2, '3241645161d8'];
const TXID = /^[0-9a-f]{64}$/i;

/** A derivation pair some store holds for one of this wallet's outputs. */
export type Derivation = {
  derivationPrefix: string;
  derivationSuffix: string;
  /** Sender identity key for received payments; undefined for the wallet's own change (counterparty self). */
  senderIdentityKey?: string;
  satoshis?: number;
  txid?: string;
  /** Which store it came from (for the log). */
  store: string;
};

/** The rows the device's (active) store holds for a txid. */
export type ActiveRows = {
  tx?: { transactionId: number; status: string; provenTxId?: number };
  outputs: {
    outputId: number;
    vout: number;
    spendable: boolean;
    spentBy?: number;
    change: boolean;
    derivationPrefix?: string;
    derivationSuffix?: string;
    senderIdentityKey?: string;
  }[];
};

export type TxidRecoverDeps = {
  keyDeriver: Pick<KeyDeriver, 'derivePrivateKey'> & { identityKey: string };
  getRawTx: (txid: string) => Promise<number[] | undefined>;
  getMerklePath: (txid: string) => Promise<MerklePath | undefined>;
  /** true: the chain says unspent; false: spent; undefined: no conclusive answer. */
  isUnspent: (outpoint: string) => Promise<boolean | undefined>;
  /** Every derivation pair in every reachable store, narrowed by the outputs' satoshis and txid when given. */
  findDerivations: (hint: { txid: string; satoshis: number[] }) => Promise<Derivation[]>;
  /** Rows the active store holds for txid; undefined when the active store can't be read directly (remote). */
  activeRows: (txid: string) => Promise<ActiveRows | undefined>;
  internalize: (args: {
    tx: number[];
    outputs: {
      outputIndex: number;
      protocol: 'wallet payment';
      paymentRemittance: { derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string };
    }[];
    description: string;
    labels?: string[];
  }) => Promise<unknown>;
  /** Repair existing rows on the active store: attach proof, status completed, the given outputs spendable. */
  repairRows: (args: {
    txid: string;
    rawTx: number[];
    merklePath: MerklePath;
    transactionId: number;
    outputIds: number[];
  }) => Promise<void>;
  /** Push the repair to the other stores afterwards (backups; or the active remote when it is remote). */
  pushBackups?: () => Promise<unknown>;
  /** Also push when the repair store already held it (remote active: the remote may still lack it). */
  pushOnAlready?: boolean;
  /** Addresses this wallet also controls outside BRC-29 (identity, legacy pay / ordinals). */
  legacyAddresses?: { label: string; address: string }[];
  log?: (msg: string) => void;
};

export type TxidOutputResult = {
  vout: number;
  satoshis: number;
  state: 'restored' | 'already' | 'spent' | 'unknown-spend' | 'not-ours' | 'legacy' | 'failed';
  detail?: string;
};

export type TxidRecoverReport = {
  txid: string;
  /** Overall: restored something / already fine / nothing of ours / couldn't check. */
  result: 'restored' | 'already' | 'not-ours' | 'not-mined' | 'not-found' | 'invalid' | 'error';
  outputs: TxidOutputResult[];
  restoredSats: number;
  error?: string;
};

/** The P2PKH script hex a BRC-29 derivation pair locks to, for this wallet's identity key. */
export function brc29Script(
  kd: TxidRecoverDeps['keyDeriver'],
  d: Pick<Derivation, 'derivationPrefix' | 'derivationSuffix' | 'senderIdentityKey'>,
): string {
  const counterparty = d.senderIdentityKey || kd.identityKey;
  const priv = kd.derivePrivateKey(BRC29_PROTOCOL, `${d.derivationPrefix} ${d.derivationSuffix}`, counterparty);
  return new P2PKH().lock(priv.toAddress()).toHex();
}

const p2pkhOf = (address: string) => {
  try {
    return new P2PKH().lock(address).toHex();
  } catch {
    return '';
  }
};

/** AtomicBEEF of a mined tx: the tx with its own proof is complete on its own (no parents needed). */
export function atomicBeefOf(rawTx: number[], merklePath: MerklePath): number[] {
  const tx = Transaction.fromBinary(rawTx);
  tx.merklePath = merklePath;
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return beef.toBinaryAtomic(tx.id('hex'));
}

const SETTLED_FOR_INTERNALIZE = ['completed', 'unproven', 'sending', 'nosend'];

export async function recoverPaymentByTxid(rawTxid: string, deps: TxidRecoverDeps): Promise<TxidRecoverReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const txid = rawTxid.trim().toLowerCase();
  const report: TxidRecoverReport = { txid, result: 'not-ours', outputs: [], restoredSats: 0 };
  if (!TXID.test(txid)) return { ...report, result: 'invalid' };
  try {
    const rawTx = await deps.getRawTx(txid);
    if (!rawTx?.length) return { ...report, result: 'not-found' };
    const tx = Transaction.fromBinary(rawTx);
    if (tx.id('hex') !== txid) return { ...report, result: 'not-found', error: 'raw tx does not hash to txid' };
    const merklePath = await deps.getMerklePath(txid);
    // A proof that names this txid, nothing less: mempool or "unknown" leaves everything as it is.
    if (!merklePath?.path?.[0]?.some((l) => l.hash === txid)) return { ...report, result: 'not-mined' };

    const scripts = tx.outputs.map((o) => o.lockingScript.toHex());
    const derivations = await deps.findDerivations({ txid, satoshis: tx.outputs.map((o) => o.satoshis ?? 0) });
    // Ours = a stored pair that derives to exactly this script. Each pair is derived once.
    const owned = new Map<number, Derivation>();
    const seen = new Set<string>();
    for (const d of derivations) {
      const key = `${d.derivationPrefix} ${d.derivationSuffix} ${d.senderIdentityKey ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let script: string;
      try {
        script = brc29Script(deps.keyDeriver, d);
      } catch {
        continue;
      }
      scripts.forEach((s, vout) => {
        if (s === script && !owned.has(vout)) owned.set(vout, d);
      });
    }
    const legacy = new Map<string, string>();
    for (const a of deps.legacyAddresses ?? []) {
      const s = p2pkhOf(a.address);
      if (s) legacy.set(s, a.label);
    }

    const rows = await deps.activeRows(txid);
    const toInternalize: { vout: number; d: Derivation }[] = [];
    const toRepair: { vout: number; outputId: number }[] = [];
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const satoshis = tx.outputs[vout].satoshis ?? 0;
      const d = owned.get(vout);
      const legacyLabel = legacy.get(scripts[vout]);
      if (!d && !legacyLabel) {
        report.outputs.push({ vout, satoshis, state: 'not-ours' });
        continue;
      }
      const row = rows?.outputs.find((o) => o.vout === vout);
      if (row?.spendable && rows?.tx && SETTLED_FOR_INTERNALIZE.includes(rows.tx.status)) {
        report.outputs.push({ vout, satoshis, state: 'already' });
        continue;
      }
      const unspent = await deps.isUnspent(`${txid}.${vout}`).catch(() => undefined);
      if (unspent === false) {
        report.outputs.push({ vout, satoshis, state: 'spent' });
        continue;
      }
      if (unspent !== true) {
        report.outputs.push({ vout, satoshis, state: 'unknown-spend', detail: 'the chain gave no clear answer' });
        continue;
      }
      if (!d) {
        report.outputs.push({ vout, satoshis, state: 'legacy', detail: legacyLabel });
        continue;
      }
      if (row && rows?.tx) toRepair.push({ vout, outputId: row.outputId });
      else toInternalize.push({ vout, d });
    }

    // Rows exist for this txid on the device's store: fix them in place (internalizeAction refuses a failed /
    // unsigned row and ignores managed change it already holds).
    if (toRepair.length && rows?.tx) {
      try {
        await deps.repairRows({
          txid,
          rawTx,
          merklePath,
          transactionId: rows.tx.transactionId,
          outputIds: toRepair.map((r) => r.outputId),
        });
        for (const r of toRepair) {
          const satoshis = tx.outputs[r.vout].satoshis ?? 0;
          report.outputs.push({
            vout: r.vout,
            satoshis,
            state: 'restored',
            detail: `row repaired (was ${rows.tx.status})`,
          });
          report.restoredSats += satoshis;
        }
      } catch (e) {
        for (const r of toRepair)
          report.outputs.push({
            vout: r.vout,
            satoshis: tx.outputs[r.vout].satoshis ?? 0,
            state: 'failed',
            detail: e instanceof Error ? e.message : String(e),
          });
      }
    }

    if (toInternalize.length) {
      // A row for the txid in a status internalizeAction refuses (failed, unsigned…) and no output row: repair
      // the transaction first so the merge path accepts it.
      try {
        if (rows?.tx && !SETTLED_FOR_INTERNALIZE.includes(rows.tx.status))
          await deps.repairRows({ txid, rawTx, merklePath, transactionId: rows.tx.transactionId, outputIds: [] });
        await deps.internalize({
          tx: atomicBeefOf(rawTx, merklePath),
          outputs: toInternalize.map(({ vout, d }) => ({
            outputIndex: vout,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: d.derivationPrefix,
              derivationSuffix: d.derivationSuffix,
              senderIdentityKey: d.senderIdentityKey || deps.keyDeriver.identityKey,
            },
          })),
          description: 'Recovered payment',
          labels: ['recovered'],
        });
        for (const { vout, d } of toInternalize) {
          const satoshis = tx.outputs[vout].satoshis ?? 0;
          report.outputs.push({ vout, satoshis, state: 'restored', detail: `derivation from ${d.store}` });
          report.restoredSats += satoshis;
        }
      } catch (e) {
        for (const { vout } of toInternalize)
          report.outputs.push({
            vout,
            satoshis: tx.outputs[vout].satoshis ?? 0,
            state: 'failed',
            detail: e instanceof Error ? e.message : String(e),
          });
      }
    }

    report.outputs.sort((a, b) => a.vout - b.vout);
    if (report.restoredSats > 0) {
      report.result = 'restored';
      log(`[recoverTxid] ${txid}: restored ${report.restoredSats} sats`);
      await deps.pushBackups?.().catch((e) => log(`[recoverTxid] backup push failed: ${String(e)}`));
    } else if (report.outputs.some((o) => o.state === 'already')) {
      report.result = 'already';
      if (deps.pushOnAlready)
        await deps.pushBackups?.().catch((e) => log(`[recoverTxid] sync to the active store failed: ${String(e)}`));
    } else if (report.outputs.some((o) => o.state === 'failed')) report.result = 'error';
    else report.result = 'not-ours';
  } catch (e) {
    report.result = 'error';
    report.error = e instanceof Error ? e.message : String(e);
  }
  return report;
}

const bsv = (sats: number) => (sats / 1e8).toFixed(8).replace(/\.?0+$/, '');

/** One line for Settings › Troubleshooting. */
export function txidRecoverySummary(r: TxidRecoverReport): string {
  const short = `${r.txid.slice(0, 8)}…`;
  switch (r.result) {
    case 'invalid':
      return 'That isn’t a transaction ID (64 letters and numbers).';
    case 'not-found':
      return `${short} wasn’t found on chain.`;
    case 'not-mined':
      return `${short} isn’t mined yet. Try again after it confirms.`;
    case 'error':
      return `Couldn’t recover ${short}: ${r.error ?? r.outputs.find((o) => o.state === 'failed')?.detail ?? 'unknown error'}`;
    case 'restored':
      return `Found ${bsv(r.restoredSats)} BSV in ${short}; restored.`;
    case 'already':
      return `${short} is already in your wallet.`;
  }
  const legacy = r.outputs.find((o) => o.state === 'legacy');
  if (legacy)
    return `${bsv(legacy.satoshis)} BSV in ${short} is on your ${legacy.detail ?? 'legacy'} address. Use Sweep to move it in.`;
  if (r.outputs.some((o) => o.state === 'unknown-spend'))
    return `${short}: couldn’t confirm the coin is unspent. Nothing changed; try again later.`;
  if (r.outputs.some((o) => o.state === 'spent')) return `${short}: your coin there is already spent.`;
  return `Nothing in ${short} belongs to this wallet’s records on this device or its backup.`;
}
